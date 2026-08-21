#!/usr/bin/env node
/**
 * @file Offline library-docs index builder (v1).
 *
 * Downloads the official HTML doc zips for NumPy / pandas / SciPy /
 * scikit-learn / the Python 3.12 stdlib (builtins, a curated module set,
 * typing), extracts ONLY the API-reference pages (matplotlib and seaborn have
 * NO zip — pass a pre-crawled directory via --matplotlib-dir / --seaborn-dir,
 * or they are skipped with a warning), strips nav/script/style, chunks ONE
 * OBJECT PER PAGE (signature block + parameter list + first 1-2 examples;
 * multi-object pages like sklearn classes split per `dt.sig` object), prunes
 * private/internal chunks (`_`-prefixed), appends curated cross-library
 * integration notes, embeds each chunk via the KI Connect embeddings endpoint
 * (e5-mistral-7b-instruct, 4096-dim), and writes `docs-index.json` (chunks +
 * per-library manifest) plus `docs-vectors.bin` (float32 LE vectors) to a
 * configurable output dir.
 *
 * The full corpus is ~5.6M tokens / ~13,100 pages — a one-shot deploy
 * operation (~10 min). For smoke tests use `--limit N` and/or `--skip-embed`.
 *
 * Usage (from frontend/):
 *   node scripts/build-docs-index.mjs [--out <dir>] [--libraries numpy,pandas]
 *       [--limit N] [--matplotlib-dir <dir>] [--skip-embed] [--help]
 *
 * Environment:
 *   KI_CONNECT_API_KEY  — required unless --skip-embed (read from env, never
 *                         printed). The repo-root .env is loaded for any
 *                         variable not already in the process environment.
 *   KI_CONNECT_BASE_URL — default https://chat.kiconnect.nrw/api/v1
 *   DATA_DIR            — default output root (out dir = <DATA_DIR>/docs-index)
 *   DOCS_INDEX_DIR      — explicit output dir override (wins over DATA_DIR)
 *
 * Output shape:
 *   docs-index.json:
 *     {
 *       format: "svelte-review-copilot-docs-index",
 *       formatVersion: 1,
 *       builtAt: ISO string,
 *       embeddingModel: "e5-mistral-7b-instruct" | null,
 *       embeddingDim: 4096 | null,
 *       libraries: [{ library, version, pinnedVersion, sourceUrl, sha256, builtAt }],
 *       chunks: [{ id, library, version, title, url, text }],
 *       vectorsFile: "docs-vectors.bin",  // present only when vectors were embedded
 *       vectorCount: <number>             // present only when vectors were embedded
 *     }
 *   docs-vectors.bin:  // present only when vectors were embedded
 *     float32 little-endian, row-major; chunk i's vector at byte offset
 *     i * embeddingDim * 4. Byte length = chunks.length * embeddingDim * 4.
 *     (Split out of the JSON because JSON.stringify of ~3000 x 4096-dim
 *     vectors exceeds Node's ~512MB string cap.)
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { strFromU8, unzipSync } from "fflate";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// ---------------------------------------------------------------------------
// Library config — single source of truth (committed): docs-libraries.json
// ---------------------------------------------------------------------------
// Adding a library or bumping a version = edit docs-libraries.json + commit;
// the build consumes it here. Zip sources carry an expected sha256 so a
// drifting download fails the build (reproducibility) rather than silently
// embedding stale docs.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIBRARIES = JSON.parse(
	await readFile(path.join(SCRIPT_DIR, "docs-libraries.json"), "utf-8"),
).libraries;

// ---------------------------------------------------------------------------
// Curated cross-library integration notes
// ---------------------------------------------------------------------------
// Authored, high-value facts about how libraries work TOGETHER — e.g. "pandas
// .plot() renders via matplotlib, so no explicit matplotlib import is needed".
// These are common student traps (often over-imported or wrongly relied on) and
// are exactly the kind of cross-library truth a pure per-library crawl misses.
// Each note is a self-contained chunk; they embed like any other chunk, under
// the `integration` library.

const INTEGRATION_NOTES = [
	{
		title: "pandas .plot() renders via matplotlib — no explicit import needed",
		url: "https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.plot.html",
		text: `## pandas .plot() renders via matplotlib (integration: pandas + matplotlib)
pandas plotting is built ON TOP of matplotlib. Calling df.plot(kind="line") (or Series.plot, or any df.plot.*) creates and returns a matplotlib Axes — pandas imports and drives matplotlib internally. This means:
- An explicit "import matplotlib.pyplot as plt" is NOT required just to produce a plot from a DataFrame.
- You can still customize the result: the returned value is a matplotlib Axes, so you can use ax.set_xlabel(...), ax.legend(), and fig.savefig(...) (via ax.figure) on it.
- "import matplotlib.pyplot as plt; plt.show()" is only needed if you want to display the figure in the pyplot way or make additional standalone plots.
Common student trap: importing matplotlib explicitly "so that df.plot works" — unnecessary. The inverse trap: calling df.plot() and then plt.plot() expecting the same axes.
Source: pandas.DataFrame.plot`,
	},
	{
		title: "seaborn is a high-level API on top of matplotlib",
		url: "https://seaborn.pydata.org/",
		text: `## seaborn is a high-level API on top of matplotlib (integration: seaborn + matplotlib)
seaborn is built on matplotlib. Every seaborn plotting function (sns.scatterplot, sns.lineplot, sns.histplot, sns.boxplot, ...) internally constructs a matplotlib Figure/Axes and draws onto it. Implications:
- import seaborn as sns is enough to use seaborn; you do NOT need to import matplotlib yourself just to make a seaborn plot.
- The object a seaborn function returns is a matplotlib Axes, so you can call matplotlib methods on it (ax.set_title, fig.savefig).
- seaborn calls its own set_theme/style on import; you can still control output with matplotlib's plt.show()/savefig.
- seaborn integrates with pandas: pass data=<DataFrame> and column names as x=, y=, hue=; seaborn hands the underlying arrays to matplotlib.
Source: seaborn.pydata.org`,
	},
	{
		title: "pandas is built on numpy — DataFrame/Series ↔ ndarray",
		url: "https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.to_numpy.html",
		text: `## pandas is built on numpy (integration: pandas + numpy)
pandas Series and DataFrames store their data in numpy arrays internally. Conversions are trivial and common:
- Series.to_numpy() / DataFrame.to_numpy() returns a numpy ndarray.
- np.asarray(df) / np.asarray(series) works directly.
- numpy ufuncs and functions accept pandas objects: np.log(df) applies elementwise to every column; np.mean(series) works.
- A Series behaves like a 1-D numpy array for most math; a DataFrame like a 2-D one.
This is why "mix numpy and pandas" is not two separate worlds: you can compute with numpy and store with pandas, or vice versa, with zero copies in many cases.
Source: pandas.DataFrame.to_numpy`,
	},
	{
		title: "scipy is built on numpy — scipy functions take/return ndarrays",
		url: "https://docs.scipy.org/doc/scipy/",
		text: `## scipy is built on numpy (integration: scipy + numpy)
SciPy depends on numpy and its functions accept and return numpy ndarrays. Practical consequences:
- You need numpy imported to create the arrays you pass to scipy (scipy.optimize.curve_fit, scipy.stats.*, scipy.integrate.*).
- Results come back as numpy arrays (e.g. popt from curve_fit is a numpy array of fitted parameters).
- scipy.stats functions take array-like x and return objects with .statistic/.pvalue as numpy scalars/arrays.
Common student pattern: a numpy array x and a model f — curve_fit(f, x, y) → popt, pcov. The "fit the curve x to data y using z" case: z is usually scipy.optimize.curve_fit, and x/y are numpy arrays.
Source: docs.scipy.org`,
	},
	{
		title: "scikit-learn consumes 2-D numpy array-likes — X must be 2-D",
		url: "https://scikit-learn.org/stable/glossary.html#term-2Darray",
		text: `## scikit-learn consumes 2-D numpy array-likes (integration: sklearn + numpy + pandas)
scikit-learn estimators take X as a 2-D array-like of shape (n_samples, n_features) and y as a 1-D array-like of length n_samples. Practical rules:
- Pass a numpy ndarray, or a pandas DataFrame/Series — sklearn converts internally (df.to_numpy()).
- X MUST be 2-D: a single feature column must be reshaped (e.g. X[["col"]]) or passed as a DataFrame column; a bare 1-D array for X is a very common error ("Expected 2D array, got 1D array").
- Predictions and fitted parameters come back as numpy arrays.
- sklearn is designed to work well with numpy and pandas pipelines (fit/predict on DataFrames).
Source: scikit-learn.org glossary "2D array"`,
	},
	{
		title: "matplotlib: pyplot state-machine vs object-oriented API",
		url: "https://matplotlib.org/stable/tutorials/introductory/pyplot.html",
		text: `## matplotlib: pyplot vs object-oriented (integration: pyplot + Axes)
matplotlib offers two complementary styles, both in the same library:
- Pyplot (state-machine): import matplotlib.pyplot as plt; plt.plot(x, y); plt.show(). Good for quick scripts; pyplot tracks the "current" figure/axes.
- Object-oriented (OO): fig, ax = plt.subplots(); ax.plot(x, y); fig.savefig("out.png"). Explicit and essential for subplots and fine control.
Rules of thumb: use plt.subplots() to get fig+ax, then the ax.* methods; call fig.savefig() to write a file. plt.show() to display. The conventional import is "import matplotlib.pyplot as plt". A figure is a canvas, an Axes is one plot area within it.
Source: matplotlib pyplot tutorial`,
	},
	{
		title: "np.polyfit vs scipy.optimize.curve_fit",
		url: "https://numpy.org/doc/stable/reference/generated/numpy.polyfit.html",
		text: `## np.polyfit vs scipy.optimize.curve_fit (integration: numpy + scipy)
Both fit a model to data, but differ in scope:
- np.polyfit(x, y, deg) fits a POLYNOMIAL of fixed degree deg and returns the coefficient array (high to low). Fitted values via np.polyval(p, x).
- scipy.optimize.curve_fit(f, xdata, ydata) fits ANY user-defined model y = f(xdata, *params) by non-linear least squares, returning popt (optimal params) and pcov (covariance).
Use polyfit for simple polynomials; use curve_fit when the model is e.g. exponential, logistic, a custom formula — anything not a plain polynomial. A student saying "we fit the curve x to data y using z" with an arbitrary model almost always means curve_fit.
Source: numpy.polyfit / scipy.optimize.curve_fit`,
	},
	{
		title: "datetime: Python datetime ↔ numpy.datetime64 ↔ pandas Timestamp",
		url: "https://docs.python.org/3.12/library/datetime.html",
		text: `## datetime types interoperate (integration: Python + numpy + pandas)
Three datetime representations coexist and convert cleanly:
- Python datetime.datetime / datetime.date (stdlib) — portable, used in checks and formatting.
- numpy.datetime64 — numpy's compact representation; created via np.datetime64("2026-08-20").
- pandas.Timestamp — pandas' datetime scalar; pandas stores datetime columns as datetime64 with a .dt accessor (series.dt.year).
Convert with pd.to_datetime(...) (parse strings/iterables to pandas datetimes), datetime.datetime objects where the stdlib is required, and .to_pydatetime() to get a Python object from a pandas/numpy one.
Source: docs.python.org/3.12/library/datetime.html`,
	},
	{
		title: "random: numpy.random vs Python random module",
		url: "https://docs.python.org/3.12/library/random.html",
		text: `## two random APIs (integration: Python stdlib + numpy)
Python's stdlib random module and numpy.random are separate:
- import random; random.randint(a, b), random.random(), random.choice(seq), random.seed(n) — for lists and Python sequences.
- numpy.random provides np.random.rand, np.random.randn, np.random.randint, np.random.normal(...), np.random.seed / np.random.default_rng — vectorized, for arrays.
Use numpy.random when working with arrays (e.g. generating a noise vector added to numpy data); use the stdlib random for plain Python collections. Mixing them (seeding one and expecting the other to be reproducible) is a common trap.
Source: docs.python.org/3.12/library/random.html`,
	},
	{
		title: "scipy.stats and numpy: statistical functions return arrays/objects",
		url: "https://docs.scipy.org/doc/scipy/reference/stats.html",
		text: `## scipy.stats works on numpy arrays (integration: scipy + numpy)
scipy.stats provides distributions (norm, t) and tests (ttest_ind, pearsonr, linregress) that operate on numpy arrays:
- Distribution functions like norm.pdf(x), norm.cdf(x), norm.ppf(q) accept numpy arrays and return arrays elementwise.
- Hypothesis tests return result objects: r = scipy.stats.pearsonr(x, y) → r.statistic (correlation) and r.pvalue. ttest_ind(a, b) → .statistic/.pvalue.
- linregress(x, y) → slope, intercept, rvalue, pvalue, stderr — a convenient linear fit built on numpy.
Almost always the input arrays come from numpy/pandas. Source: docs.scipy.org/reference/stats`,
	},
];

/**
 * Drop private/internal chunks — object names that are private either at the
 * top level (start with `_`, e.g. `_AxesBase`) or anywhere in a dotted path
 * (contain `._`, e.g. `matplotlib.axes._axes.Axes`, `sklearn.utils._testing`,
 * `numpy._core`). These are internal submodules/helpers that almost never
 * appear in student prose or teacher queries; excluding them cuts retrieval
 * noise and memory with no coverage loss for real usage. Also drops nameless
 * chunks.
 */
function pruneChunks(chunks) {
	return chunks.filter((c) => {
		const name = (c.title || "").trim();
		if (!name) return false;
		if (name.startsWith("_")) return false;
		if (name.includes("._")) return false;
		return true;
	});
}

const EMBEDDING_MODEL = "e5-mistral-7b-instruct";
const EMBEDDING_DIM = 4096;
const EMBED_BATCH = 16; // texts per API call
const EMBED_CONCURRENCY = 2; // KI Connect rate-limit ceiling (empirical, 2026-08-17)

const MAX_DESCRIPTION_CHARS = 5000; // per object block (signature+params+notes)
const MAX_EXAMPLE_CHARS = 1500; // per kept example
const MAX_EXAMPLES = 2; // first 1-2 examples per object

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
	console.log(`Usage: node scripts/build-docs-index.mjs [options]
  --out <dir>          output dir (default: $DOCS_INDEX_DIR or <DATA_DIR>/docs-index)
  --libraries <list>   comma list: numpy,pandas,scipy,sklearn,matplotlib,seaborn,builtins,stdlib,typing (default: all; integration notes are always included)
  --limit <N>          process only the first N API pages per library (smoke tests)
  --matplotlib-dir <d> pre-crawled matplotlib docs dir (api/ inside); enables matplotlib
  --seaborn-dir <d>    pre-crawled seaborn docs dir (generated/ inside); enables seaborn
  --fetch-crawls <d>   crawl matplotlib+seaborn into <d>/<lib> first (CI: sources fully from docs-libraries.json)
  --skip-embed         write chunks without vectors (no KI Connect call)
  --help               show this help`);
}

function parseArgs(argv) {
	const args = {
		out: null,
		libraries: null,
		limit: null,
		matplotlibDir: null,
		seabornDir: null,
		fetchCrawls: null,
		venv: null,
		skipEmbed: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--out":
				args.out = argv[++i];
				break;
			case "--libraries":
				args.libraries = argv[++i]
					?.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				break;
			case "--limit":
				args.limit = Number(argv[++i]);
				break;
			case "--matplotlib-dir":
				args.matplotlibDir = argv[++i];
				break;
			case "--seaborn-dir":
				args.seabornDir = argv[++i];
				break;
			case "--fetch-crawls":
				args.fetchCrawls = argv[++i];
				break;
			case "--venv":
				args.venv = argv[++i];
				break;
			case "--skip-embed":
				args.skipEmbed = true;
				break;
			case "--help":
				usage();
				process.exit(0);
				break;
			default:
				console.warn(`[build-docs-index] ignoring unknown argument: ${a}`);
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// Environment bootstrap (load repo-root .env for KI_CONNECT_*)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
try {
	const raw = await readFile(ENV_PATH, "utf-8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed
			.slice(0, eq)
			.trim()
			.replace(/^export\s+/, "");
		const value = trimmed.slice(eq + 1).trim();
		if (key && !(key in process.env)) process.env[key] = value;
	}
} catch {
	// No .env — rely on the ambient environment.
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	times: "×",
	minus: "−",
	le: "≤",
	ge: "≥",
	ne: "≠",
	plusmn: "±",
	deg: "°",
	mu: "μ",
	sigma: "σ",
	alpha: "α",
	beta: "β",
	lambda: "λ",
	pi: "π",
	Delta: "Δ",
	Sigma: "Σ",
	infty: "∞",
	approx: "≈",
	equiv: "≡",
	sqrt: "√",
	tfrac: "⁄",
};

/** Decode HTML entities (numeric + common named) in a text string. */
function decodeEntities(text) {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		return NAMED_ENTITIES[body] ?? m;
	});
}

/** Strip all tags from an HTML fragment and normalize whitespace. */
function htmlToText(html) {
	return decodeEntities(html.replace(/<[^>]+>/g, " "))
		.replace(/[ \t\r\f\v]+/g, " ")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
}

/** Collapse whitespace in a signature line. */
function cleanSignature(text) {
	return decodeEntities(
		text
			.replace(/<[^>]+>/g, "")
			.replace(/\s*\[source\]\s*/g, "")
			.replace(/\s*#\s*$/, ""),
	)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Remove balanced elements whose opening tag matches `predicate` (e.g.
 * script/style/nav/footer/try-examples divs). Handles nested elements of the
 * same kind by depth counting.
 */
function removeElements(html, predicate) {
	const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
	let out = "";
	let last = 0;
	let depth = 0;
	let removing = false;
	let m;
	while ((m = tagRe.exec(html)) !== null) {
		const full = m[0];
		const tag = m[1];
		const attrs = m[2] ?? "";
		const isClosing = full.startsWith("</");
		if (removing) {
			if (!isClosing) depth++;
			else depth--;
			if (depth <= 0) {
				removing = false;
				last = tagRe.lastIndex;
			}
			continue;
		}
		if (!isClosing && predicate(tag, attrs)) {
			out += html.slice(last, m.index);
			removing = true;
			depth = 1;
			continue;
		}
	}
	if (!removing) out += html.slice(last);
	return out;
}

/** Extract the main article (or first section) of a Sphinx page. */
function extractArticle(html) {
	const articleStart = html.indexOf("<article");
	if (articleStart !== -1) {
		const end = html.indexOf("</article>", articleStart);
		if (end !== -1) return html.slice(articleStart, end);
	}
	// Non-`<article>` doc sites (Python's Sphinx-rtd theme uses nested
	// `<section>`/`<div class="body">`): the content begins at the first
	// documented object. Slicing from there drops the sidebar/TOC before it,
	// WITHOUT needing to match a nesting container — matching the first
	// `<section>…</section>` could clip a page whose first span is an empty
	// header (a clipped page loses every object after it, as typing.html did).
	const sigStart = html.indexOf('<dt class="sig sig-object');
	if (sigStart !== -1) return html.slice(sigStart);
	const sectionStart = html.indexOf("<section");
	if (sectionStart !== -1) {
		const end = html.indexOf("</section>", sectionStart);
		if (end !== -1) return html.slice(sectionStart, end);
	}
	return html;
}

/** Split an article into object blocks at each `dt.sig.sig-object` boundary. */
function splitObjectBlocks(article) {
	const dtRe = /<dt class="sig sig-object[^"]*"[^>]*>/g;
	const starts = [];
	let m;
	while ((m = dtRe.exec(article)) !== null) starts.push(m.index);
	if (starts.length <= 1) return [article];
	const blocks = [];
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1] : article.length;
		blocks.push(article.slice(starts[i], end));
	}
	return blocks;
}

/** Extract the first N doctest/code `<pre>` blocks from a fragment. */
function extractExamples(fragment, max = MAX_EXAMPLES) {
	const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/g;
	const examples = [];
	let m;
	while ((m = preRe.exec(fragment)) !== null) {
		const text = htmlToText(m[1]);
		if (!text) continue;
		// Keep doctest blocks (>>>) and plain code blocks; skip pure output.
		if (
			text.includes(">>>") ||
			/^[a-zA-Z_][\w.]*\s*\(/.test(text) ||
			text.includes("import ")
		) {
			examples.push(text.slice(0, MAX_EXAMPLE_CHARS));
			if (examples.length >= max) break;
		}
	}
	return examples;
}

/** Cut a class page's dd before the Attributes/Methods link tables. */
function cutAtRubric(fragment) {
	const cut = fragment.search(/<p class="rubric">\s*(?:Attributes|Methods)\s*<\/p>/);
	return cut === -1 ? fragment : fragment.slice(0, cut);
}

/** Detect the docs version from a page (version_match or title). */
function detectVersion(html, fallback) {
	const vm = html.match(/version_match\s*=\s*'([^']+)'/);
	if (vm) return vm[1];
	const title = html.match(/<title>([^<]*)<\/title>/);
	if (title) {
		const t = title[1].match(/v?(\d+\.\d+(?:\.\d+)?)/);
		if (t) return t[1];
	}
	return fallback;
}

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

/** Select API-reference page names from an unzipped file map. */
function selectApiPages(files, lib) {
	const names = Object.keys(files).filter((n) => n.endsWith(".html"));
	const cfg = LIBRARIES[lib];
	// Curated page list (Python stdlib/builtins/typing) — exact pages, no
	// prefix sweep, so the whole ~200-module stdlib is never pulled in.
	if (Array.isArray(cfg.pages)) {
		const pages = cfg.pages.filter((p) => names.includes(p));
		if (pages.length < cfg.pages.length) {
			console.warn(
				`[build-docs-index]   ${lib}: ${cfg.pages.length - pages.length} curated page(s) missing from the docs zip (${cfg.pages
					.filter((p) => !names.includes(p))
					.join(", ")})`,
			);
		}
		return pages;
	}
	const prefix = cfg.apiPrefix;
	const direct = names.filter((n) => n.startsWith(prefix));
	if (lib === "scipy") {
		// SciPy also has "special" API pages directly under reference/
		// (e.g. reference/optimize.minimize-lbfgsb.html) that carry a
		// signature dt but no generated/ prefix. Index pages (optimize.html,
		// stats.html, ...) have no signature dt and are excluded.
		const special = names.filter(
			(n) =>
				n.startsWith("reference/") &&
				!n.startsWith("reference/generated/") &&
				n.includes('<dt class="sig sig-object'),
		);
		return [...direct, ...special];
	}
	return direct;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Turn one API page into one or more chunks (one per `dt.sig` object).
 * Returns [{ id, title, url, text }].
 */
function chunkPage(html, relPath, lib, version) {
	const article = extractArticle(html);
	const cleaned = removeElements(article, (tag, attrs) => {
		if (
			tag === "script" ||
			tag === "style" ||
			tag === "nav" ||
			tag === "footer" ||
			tag === "aside" ||
			tag === "dialog"
		) {
			return true;
		}
		// Try-examples / jupyterlite iframe wrappers (numpy/pandas) — noise.
		return /class="[^"]*(?:try_examples|jupyterlite)[^"]*"/.test(attrs);
	});
	const blocks = splitObjectBlocks(cleaned);
	const url = LIBRARIES[lib].urlBase + relPath;
	const chunks = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const dtMatch = block.match(/<dt class="sig sig-object[^"]*"[^>]*id="([^"]+)"/);
		const title = dtMatch ? dtMatch[1] : null;
		const sigMatch = block.match(/<dt class="sig sig-object[^"]*"[^>]*>([\s\S]*?)<\/dt>/);
		const signature = sigMatch ? cleanSignature(sigMatch[1]) : (title ?? relPath);

		// dd content (everything after the dt), minus the Attributes/Methods
		// link tables on class pages, minus examples (kept separately).
		let dd = block;
		if (sigMatch) dd = block.slice(sigMatch.index + sigMatch[0].length);
		dd = cutAtRubric(dd);
		const examples = extractExamples(dd);
		const ddWithoutPre = dd.replace(/<pre[^>]*>[\s\S]*?<\/pre>/g, " ");
		const description = htmlToText(ddWithoutPre).slice(0, MAX_DESCRIPTION_CHARS);

		const objectName = title ?? signature.split("(")[0]?.trim() ?? relPath;
		const text = [
			`## ${objectName} (${lib} ${version})`,
			`Signature: ${signature}`,
			description,
			...(examples.length > 0 ? ["Example:", ...examples] : []),
			`Source: ${url}`,
		]
			.filter((part) => part && part.trim())
			.join("\n\n");

		chunks.push({
			id: `${lib}:${relPath}#${i}`,
			title: objectName,
			url,
			text,
		});
	}
	return chunks;
}

// ---------------------------------------------------------------------------
// Corpus acquisition
// ---------------------------------------------------------------------------

// A zip is only downloaded once per build even when several libraries share
// it (builtins/stdlib/typing all use the Python docs zip).
const zipCache = new Map();

async function downloadZip(url) {
	if (zipCache.has(url)) return zipCache.get(url);
	const resp = await fetch(url, { redirect: "follow" });
	if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status}): ${url}`);
	const buf = Buffer.from(await resp.arrayBuffer());
	zipCache.set(url, buf);
	return buf;
}

function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

/** Recursively list .html files under a directory (matplotlib/seaborn crawl). */
async function listHtmlFiles(dir) {
	const out = [];
	async function walk(d) {
		const entries = await readdir(d, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
		}
	}
	await walk(dir);
	return out;
}

/** Read a pre-crawled HTML dir into a relPath→Uint8Array file map. */
async function readCrawlDir(dir) {
	const htmlFiles = await listHtmlFiles(dir);
	const files = {};
	for (const f of htmlFiles) {
		const rel = path.relative(dir, f).split(path.sep).join("/");
		files[rel] = new TextEncoder().encode(await readFile(f, "utf-8"));
	}
	return files;
}

/** Some doc zips (Python stdlib) nest everything under a single version
 *  folder (e.g. `python-3.12.6-docs-html/`). Strip that shared top-level dir so
 *  page paths match (`library/functions.html`, not
 *  `python-3.12.6-docs-html/library/functions.html`). No-op for flat zips. */
function stripCommonTopDir(files) {
	const keys = Object.keys(files);
	if (keys.length === 0) return files;
	const firstSeg = keys[0].split("/")[0];
	if (!firstSeg) return files;
	if (!keys.every((k) => k.split("/")[0] === firstSeg)) return files;
	const out = {};
	for (const k of keys) out[k.slice(firstSeg.length + 1)] = files[k];
	return out;
}

/** Recursively find the first directory whose basename equals `name`. */
async function findDir(dir, name) {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		if (e.name === name) return path.join(dir, e.name);
		const sub = await findDir(path.join(dir, e.name), name);
		if (sub) return sub;
	}
	return null;
}

/**
 * `--fetch-crawls <baseDir>`: crawl a no-zip library (matplotlib, seaborn)
 * from its pinned `crawlSeedUrl` into `<baseDir>/<lib>` such that the
 * apiPrefix directory (`api/`, `generated/`) sits directly under it — the
 * layout readCrawlDir + selectApiPages expect. Crawled fresh each run so CI
 * is reproducible from the committed config; a changed sha of the crawl is
 * visible in the manifest's sourceUrl/builtAt (matplotlib ~180 MB cannot be
 * committed, so the crawl stays a pinned network step).
 */
async function crawlLibrary(baseDir, lib, cfg) {
	const raw = path.join(baseDir, `${lib}-raw`);
	const target = path.join(baseDir, lib);
	await rm(raw, { recursive: true, force: true });
	await rm(target, { recursive: true, force: true });
	await mkdir(raw, { recursive: true });
	const cmd = `wget --no-host-directories --recursive --level=${cfg.crawlDepth ?? 2} --no-parent --no-clobber --timeout=25 --tries=2 --wait=0.2 -A '*.html' -P ${JSON.stringify(raw)} ${JSON.stringify(cfg.crawlSeedUrl)}`;
	console.log(`[fetch-crawls] crawling ${lib} (${cfg.crawlSeedUrl}) …`);
	execSync(cmd, { stdio: "inherit" });
	const prefixDir = cfg.apiPrefix.replace(/\/$/, "");
	const found = await findDir(raw, prefixDir);
	await mkdir(path.dirname(target), { recursive: true });
	if (found) {
		await rename(found, target);
	} else {
		await rename(raw, target);
		return;
	}
	await rm(raw, { recursive: true, force: true });
	console.log(`[fetch-crawls] ${lib} -> ${target}`);
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

function createEmbedder() {
	const provider = createOpenAICompatible({
		name: "ki-connect",
		baseURL: process.env.KI_CONNECT_BASE_URL ?? "https://chat.kiconnect.nrw/api/v1",
		apiKey: process.env.KI_CONNECT_API_KEY,
	});
	return provider.embeddingModel(EMBEDDING_MODEL);
}

/** Embed texts in batches with bounded concurrency (KI Connect rate limit). */
async function embedAll(model, texts, onProgress) {
	const vectors = new Array(texts.length);
	let next = 0;
	async function worker() {
		while (true) {
			const start = next;
			next += EMBED_BATCH;
			if (start >= texts.length) return;
			const batch = texts.slice(start, start + EMBED_BATCH);
			const result = await model.doEmbed({ values: batch });
			// A partial response would leave undefined holes in `vectors`
			// that reach the write loop as a TypeError — fail loudly so the
			// outer try/catch writes the index WITHOUT vectors instead.
			if (result.embeddings.length !== batch.length) {
				throw new Error(
					`embedding API returned ${result.embeddings.length} vectors for a ${batch.length}-text batch`,
				);
			}
			for (let i = 0; i < result.embeddings.length; i++) {
				vectors[start + i] = result.embeddings[i];
			}
			onProgress?.(start + result.embeddings.length, texts.length);
		}
	}
	await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, () => worker()));
	return vectors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

const requested = args.libraries ?? Object.keys(LIBRARIES);
const libraries = requested.filter((lib) => {
	if (LIBRARIES[lib]) return true;
	console.warn(`[build-docs-index] unknown library "${lib}" — skipping`);
	return false;
});
if (libraries.length === 0) {
	console.error("[build-docs-index] no libraries selected");
	process.exit(1);
}

const outDir =
	args.out ??
	process.env.DOCS_INDEX_DIR ??
	path.join(process.env.DATA_DIR ?? "./data", "docs-index");
await mkdir(outDir, { recursive: true });

// --fetch-crawls: produce the no-zip crawl sources (matplotlib/seaborn) from
// the committed config before the build loop consumes them.
if (args.fetchCrawls) {
	for (const lib of libraries) {
		const cfg = LIBRARIES[lib];
		if (cfg.source === "crawl" && !args[cfg.dirArg]) {
			await crawlLibrary(args.fetchCrawls, lib, cfg);
			args[cfg.dirArg] = path.join(args.fetchCrawls, lib);
		}
	}
}

const allChunks = [];

// Docstring-source libraries (source:"docstrings"): ensure a uv venv with the
// pinned versions, run the Python extractor once for all of them, and load the
// per-library chunks. Fully reproducible + version-exact (no crawls, no zips).
const docstringLibs = libraries.filter((lib) => LIBRARIES[lib]?.source === "docstrings");
const docChunksByLib = new Map();
if (docstringLibs.length > 0) {
	const venv = args.venv ?? process.env.DOCS_VENV ?? "/tmp/docs-docstrings-venv";
	const pybin = path.join(venv, "bin", "python");
	console.log(
		`[build-docs-index] docstring extraction for: ${docstringLibs.join(", ")} (venv ${venv})`,
	);
	execSync(`test -x ${JSON.stringify(pybin)} || uv venv --python 3.12 ${JSON.stringify(venv)}`, {
		stdio: "inherit",
	});
	// Some lib keys differ from their PyPI distribution name (import module
	// `sklearn` ships as the `scikit-learn` package).
	const PIP_PACKAGE = { sklearn: "scikit-learn" };
	const specs = docstringLibs
		.map((l) => `${PIP_PACKAGE[l] ?? l}==${LIBRARIES[l].pinnedVersion}`)
		.join(" ");
	execSync(`uv pip install --python ${JSON.stringify(pybin)} ${specs}`, { stdio: "inherit" });
	const chunksOut = path.join(outDir, "docstrings-chunks.json");
	const versions = docstringLibs.map((l) => `${l}=${LIBRARIES[l].pinnedVersion}`).join(";");
	execSync(
		`${JSON.stringify(pybin)} ${JSON.stringify(path.join(SCRIPT_DIR, "extract-docstrings.py"))} --libs ${docstringLibs.join(",")} --versions "${versions}" --out ${JSON.stringify(chunksOut)}`,
		{ stdio: "inherit" },
	);
	const parsed = JSON.parse(await readFile(chunksOut, "utf-8"));
	for (const lib of docstringLibs) docChunksByLib.set(lib, parsed[lib] ?? []);
}
const allVectors = [];
const manifestLibraries = [];
let embeddingModel = null;
let embeddingDim = null;

for (const lib of libraries) {
	const cfg = LIBRARIES[lib];
	console.log(`[build-docs-index] === ${lib} ===`);

	let files;
	let zipSha = null;
	let sourceUrl = cfg.url ?? null;

	if (cfg.source === "zip") {
		console.log(`[build-docs-index] downloading ${cfg.url} …`);
		const buf = await downloadZip(cfg.url);
		zipSha = sha256(buf);
		if (cfg.sha256 && zipSha !== cfg.sha256) {
			throw new Error(
				`sha256 mismatch for ${lib}: expected ${cfg.sha256}, got ${zipSha} — source changed; update docs-libraries.json (pinned version) and rebuild`,
			);
		}
		console.log(
			`[build-docs-index]   ${(buf.length / 1024 / 1024).toFixed(1)} MB, sha256 ${zipSha.slice(0, 12)}… (verified)`,
		);
		files = unzipSync(new Uint8Array(buf));
		if (Array.isArray(cfg.pages)) files = stripCommonTopDir(files); // python docs zip nests under a version dir
	} else if (cfg.source === "crawl") {
		const dirArg = args[cfg.dirArg];
		if (!dirArg) {
			console.warn(
				`[build-docs-index] ${lib} has no official zip — pass --${cfg.dirArg.replace("Dir", "-dir")} <crawled-dir> (or --fetch-crawls) to include it; skipping for this build`,
			);
			continue;
		}
		console.log(`[build-docs-index] reading pre-crawled dir ${dirArg} …`);
		files = await readCrawlDir(dirArg);
		sourceUrl = "crawled:" + dirArg;
	} else if (cfg.source === "docstrings") {
		sourceUrl = `docstrings:${cfg.pinnedVersion}`;
		// files stays undefined — chunks come from docChunksByLib below.
	} else {
		console.warn(`[build-docs-index] no source for ${lib} — skipping`);
		continue;
	}

	let version = cfg.pinnedVersion;
	let libChunks;
	if (cfg.source === "docstrings") {
		libChunks = (docChunksByLib.get(lib) ?? []).map((c, i) => ({
			id: `${lib}:docstrings:${i}`,
			title: c.title,
			url: c.url,
			text: c.text,
		}));
		console.log(
			`[build-docs-index]   ${libChunks.length} docstring chunk(s) (version ${version})`,
		);
	} else {
		const pages = selectApiPages(files, lib);
		const limited = args.limit ? pages.slice(0, args.limit) : pages;
		console.log(
			`[build-docs-index]   ${pages.length} API pages (processing ${limited.length})`,
		);
		libChunks = [];
		for (const relPath of limited) {
			const html = strFromU8(files[relPath]);
			if (version === cfg.pinnedVersion) version = detectVersion(html, cfg.pinnedVersion);
			libChunks.push(...chunkPage(html, relPath, lib, version));
		}
	}
	const pruned = pruneChunks(libChunks);
	if (pruned.length !== libChunks.length) {
		console.log(
			`[build-docs-index]   pruned ${libChunks.length - pruned.length} internal/private chunk(s) → ${pruned.length}`,
		);
	}
	libChunks = pruned;
	console.log(`[build-docs-index]   ${libChunks.length} chunks (docs version ${version})`);

	manifestLibraries.push({
		library: lib,
		version,
		pinnedVersion: cfg.pinnedVersion,
		sourceUrl,
		sha256: zipSha,
		builtAt: new Date().toISOString(),
	});

	if (!args.skipEmbed) {
		if (!process.env.KI_CONNECT_API_KEY) {
			console.warn(
				"[build-docs-index] KI_CONNECT_API_KEY not set — writing index WITHOUT vectors (BM25-only at runtime)",
			);
		} else {
			try {
				const model = createEmbedder();
				embeddingModel = EMBEDDING_MODEL;
				embeddingDim = EMBEDDING_DIM;
				console.log(
					`[build-docs-index]   embedding ${libChunks.length} chunks (${EMBEDDING_MODEL}, concurrency ${EMBED_CONCURRENCY}) …`,
				);
				const vectors = await embedAll(
					model,
					libChunks.map((c) => c.text),
					(done, total) => {
						if (done % 64 === 0 || done === total)
							console.log(`[build-docs-index]     ${done}/${total}`);
					},
				);
				allVectors.push(...vectors);
			} catch (err) {
				console.warn(
					`[build-docs-index]   embedding failed (${err instanceof Error ? err.message : String(err)}) — writing index WITHOUT vectors`,
				);
			}
		}
	}

	allChunks.push(...libChunks.map((c) => ({ ...c, library: lib, version })));
}

// Authored cross-library integration notes — always included (tiny, curated).
if (INTEGRATION_NOTES.length > 0) {
	const libChunks = INTEGRATION_NOTES.map((n, i) => ({
		id: `integration:${i}`,
		title: n.title,
		url: n.url,
		text: n.text,
		library: "integration",
		version: "curated",
	}));
	if (!args.skipEmbed) {
		if (!process.env.KI_CONNECT_API_KEY) {
			console.warn(
				"[build-docs-index] KI_CONNECT_API_KEY not set — integration notes written WITHOUT vectors",
			);
		} else {
			try {
				const model = createEmbedder();
				if (!embeddingModel) embeddingModel = EMBEDDING_MODEL;
				if (!embeddingDim) embeddingDim = EMBEDDING_DIM;
				const vectors = await embedAll(
					model,
					libChunks.map((c) => c.text),
					() => {},
				);
				allVectors.push(...vectors);
			} catch (err) {
				console.warn(
					`[build-docs-index]   embedding integration notes failed (${err instanceof Error ? err.message : String(err)}) — written WITHOUT vectors`,
				);
			}
		}
	}
	allChunks.push(...libChunks);
	manifestLibraries.push({
		library: "integration",
		version: "curated",
		pinnedVersion: "curated",
		sourceUrl: null,
		sha256: null,
		builtAt: new Date().toISOString(),
	});
	console.log(
		`[build-docs-index] === integration ===\n[build-docs-index]   ${libChunks.length} curated cross-library note(s)`,
	);
}

if (allChunks.length === 0) {
	console.error("[build-docs-index] no chunks produced — nothing to write");
	process.exit(1);
}

const index = {
	format: "svelte-review-copilot-docs-index",
	formatVersion: 1,
	builtAt: new Date().toISOString(),
	embeddingModel,
	embeddingDim,
	libraries: manifestLibraries,
	chunks: allChunks,
};
if (allVectors.length > 0) {
	index.vectorsFile = "docs-vectors.bin";
	index.vectorCount = allVectors.length;
}

const outPath = path.join(outDir, "docs-index.json");
await writeFile(outPath, JSON.stringify(index), "utf-8");

if (allVectors.length > 0) {
	// float32 little-endian, row-major: chunk i's vector at byte offset
	// i * embeddingDim * 4. writeFloatLE explicitly (do NOT rely on
	// Buffer.from(Float32Array) platform endianness).
	const buf = Buffer.allocUnsafe(allVectors.length * embeddingDim * 4);
	for (let i = 0; i < allVectors.length; i++) {
		const vec = allVectors[i];
		const offset = i * embeddingDim * 4;
		for (let j = 0; j < embeddingDim; j++) {
			buf.writeFloatLE(vec[j], offset + j * 4);
		}
	}
	const vectorsPath = path.join(outDir, "docs-vectors.bin");
	await writeFile(vectorsPath, buf);
	console.log(
		`[build-docs-index] wrote ${vectorsPath}: ${allVectors.length} vectors x ${embeddingDim} dims (${buf.length} bytes)`,
	);
}

console.log(
	`[build-docs-index] wrote ${outPath}: ${allChunks.length} chunks, ${allVectors.length} vectors, ${manifestLibraries.length} libraries`,
);
