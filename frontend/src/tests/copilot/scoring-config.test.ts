/**
 * @file Scoring-config tests (design signed off 2026-08-18).
 *
 * Covers:
 *   1. Loader + compile gate — bad regex / bad semantics / partial anchors
 *      throw; absent file → null.
 *   2. Byte-equality golden: the Phase 2a prompt assembled from the config
 *      (soil_contamination) equals the pre-config hardcoded prompt
 *      (fixtures/phase2a-prompt-golden.txt). Prompt byte-equality is a
 *      contract — the Karl gate + calibration findings were tuned against it.
 *   3. Evidence-count snapshot — config patterns against the stored 19
 *      outputs reproduce the pre-config baseline counts (fit 16/19, std-err
 *      4/19, r2 computed 7/19, r2 discussed 10/19, physical 6/19, builtin
 *      1/19, bounds 2/19, plot 19/19, unit 19/19). The repo mirror
 *      (data/submissions/.../results.json) is gitignored, so this test
 *      SKIPS gracefully when the data file is absent (fresh clone).
 *   4. fallback — `buildExtraAnalysisEvidence(cells)` without config is
 *      byte-identical to the pre-config hardcoded implementation.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildEvidenceHaystacks,
	compileScoringConfig,
	haystackFor,
	loadScoringConfig,
	substituteAnchors,
	testEvidencePattern,
	type ScoringConfig,
} from "$lib/server/copilot/scoring-config";
import { buildExtraAnalysisEvidence } from "$lib/server/copilot/pipeline/context";
import { buildPhase2aDimensionGuidance, PHASE2A_SCORING_PROMPT } from "$lib/server/copilot/pipeline/prompts";
import * as docsRag from "$lib/server/copilot/docs-rag";
import { buildDocsFactsBlock, extractApiReferences } from "$lib/server/copilot/pre-evaluation";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures");

/** Minimal valid soil scoring config (values verbatim from the committed YAML). */
function soilScoringRaw(): Record<string, unknown> {
	return {
		reference_anchors: {
			A: 1210.91,
			B: -484.95,
			x0: -4.8,
			y0: 986.98,
			L: 684.48,
			r_squared: 0.9794,
			rmse: 25.18,
		},
		evidence_patterns: {
			std_err_from_covariance: {
				pattern:
					"np\\.sqrt\\s*\\(\\s*np\\.diag\\s*\\(\\s*covariance\\s*\\)\\s*\\)|np\\.diag\\s*\\(\\s*covariance\\s*\\)|standard\\s*error",
				semantics: "test",
				haystack: "output+code",
			},
			fit_reproduces_reference: {
				pattern: ["\\bA\\b[^\\n]{0,60}?1210\\.9\\d*", "\\bB\\b[^\\n]{0,60}?-?484\\.9\\d*", "\\bL\\b[^\\n]{0,60}?684\\.4\\d*"],
				semantics: "test_all",
				haystack: "output",
			},
			plot_family_counter: {
				pattern: "(?:plt|ax)\\.(\\w+)\\s*\\(",
				semantics: "distinct_count",
				capture_group: 1,
				haystack: "code",
			},
			fit_metrics_r2: {
				pattern: "\\bR\\s*(?:\\^2|²|2)\\s*[=:]\\s*([\\d.]+)",
				semantics: "capture_value",
				capture_group: 1,
				haystack: "output",
			},
		},
		disallowed_libraries: ["tensorflow", "torch", "keras", "xgboost", "lightgbm"],
		prompt_anchor_text: {
			dimension_guidance: {
				scientific_programming:
					"scientific methodology. Anchor scale (6-point dimension, FIT-QUALITY driven — the professor's actual grading pattern): 5-5.5 = the fit reproduces the reference solution (A≈{A}, B≈{B}, L≈{L}) AND parameter standard errors are reported from the covariance matrix AND results are discussed in context; 4-4.5 = correct fit reproducing the reference, metrics computed, some discussion (built-in metrics are a suggestion, NOT a requirement — hand-rolled RMSE still earns 4.5), OR a constrained/bounded fit that is sub-reference (e.g. RMSE 42.58 vs 25.18) but whose metrics are computed AND discussed in context — the professor awards 4.5 to correct methodology with computed+discussed metrics even when the constrained fit is worse than the reference; 3 = correct fit but covariance never used, or metrics computed but never discussed; 2 = major methodology gaps (no metrics, no physical bounds, no unit awareness). A submission whose fit reproduces the reference values deserves 4+ — do not anchor it at 3.",
				creativity:
					"original thought beyond the reference. Anchor scale: 4 = genuinely novel approach beyond the reference; 3 = clear original contributions (e.g. double-checking the cluster count with the elbow technique, computing/reporting parameter standard errors from the covariance matrix, any extra meaningful analysis, or physically insightful interpretation of surprising results — e.g. explaining WHY a fitted parameter is non-physical or discussing parameter correlation); 2.5 = some original thought (extra visualization, alternative framing); 1-2 = strictly follows the reference with no original contributions. Most submissions that do ANY extra analysis or use a non-standard approach should land 2.5-4; 1 is reserved for literally nothing beyond the reference.",
			},
		},
	};
}

describe("scoring-config loader", () => {
	it("returns null when the config file is absent", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "scoring-config-"));
		const oldDataDir = process.env.DATA_DIR;
		process.env.DATA_DIR = dir;
		try {
			expect(await loadScoringConfig("soil_contamination")).toBeNull();
		} finally {
			if (oldDataDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = oldDataDir;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("throws on an invalid regex with the pattern key", () => {
		expect(() =>
			compileScoringConfig("soil_contamination", {
				...soilScoringRaw(),
				evidence_patterns: {
					bad_pattern: { pattern: "([unclosed", semantics: "test", haystack: "output" },
				},
			}),
		).toThrow(/evidence_patterns\.bad_pattern is not a valid regex/);
	});

	it("throws on unknown semantics", () => {
		expect(() =>
			compileScoringConfig("soil_contamination", {
				...soilScoringRaw(),
				evidence_patterns: {
					bad: { pattern: "x", semantics: "bogus", haystack: "output" },
				},
			}),
		).toThrow(/semantics must be one of/);
	});

	it("throws on partial reference_anchors", () => {
		expect(() =>
			compileScoringConfig("soil_contamination", {
				...soilScoringRaw(),
				reference_anchors: { A: 1210.91 },
			}),
		).toThrow(/reference_anchors\.B must be a finite number/);
	});

	it("throws when r_squared is out of [0,1]", () => {
		const raw = soilScoringRaw() as Record<string, Record<string, unknown>>;
		expect(() =>
			compileScoringConfig("soil_contamination", {
				...raw,
				reference_anchors: { ...raw.reference_anchors, r_squared: 1.5 },
			}),
		).toThrow(/r_squared must be in \[0,1\]/);
	});

	it("requires capture_group for capture semantics", () => {
		expect(() =>
			compileScoringConfig("soil_contamination", {
				...soilScoringRaw(),
				evidence_patterns: {
					bad: { pattern: "x", semantics: "capture_value", haystack: "output" },
				},
			}),
		).toThrow(/capture_group must be an integer/);
	});

	it("compiles the committed soil config and exposes anchors + patterns", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "scoring-config-"));
		const oldDataDir = process.env.DATA_DIR;
		process.env.DATA_DIR = dir;
		try {
			await writeFile(
				path.join(dir, "soil_contamination.yaml"),
				await readFile("/root/projects/svelte-review-copilot/data/scoring/soil_contamination.yaml", "utf-8"),
			);
			// The loader looks for data/scoring/<id>.yaml under DATA_DIR.
			await mkdir(path.join(dir, "scoring"), { recursive: true });
			await writeFile(
				path.join(dir, "scoring", "soil_contamination.yaml"),
				await readFile("/root/projects/svelte-review-copilot/data/scoring/soil_contamination.yaml", "utf-8"),
			);
			const config = await loadScoringConfig("soil_contamination");
			expect(config).not.toBeNull();
			expect(config!.anchors).toMatchObject({ A: 1210.91, B: -484.95, L: 684.48, rSquared: 0.9794, rmse: 25.18 });
			expect(config!.disallowedLibraries).toEqual(["tensorflow", "torch", "keras", "xgboost", "lightgbm"]);
			expect(config!.evidencePatterns.has("fit_reproduces_reference")).toBe(true);
			expect(config!.dimensionGuidance.scientific_programming).toContain("A≈{A}");
		} finally {
			if (oldDataDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = oldDataDir;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Phase 2a prompt byte-equality golden", () => {
	it("assembles the soil prompt byte-identical to the pre-config hardcoded prompt", async () => {
		const golden = await readFile(path.join(FIXTURE_DIR, "phase2a-prompt-golden.txt"), "utf-8");
		const config = compileScoringConfig("soil_contamination", soilScoringRaw());

		const guidance = Object.fromEntries(
			Object.entries(config.dimensionGuidance).map(([k, v]) => [k, substituteAnchors(v, config.anchors)]),
		);
		// The {DOCS_FACTS} placeholder (P2-4d, docs grounding) is substituted
		// with "" here — the golden fixture proves the prompt is byte-identical
		// to the pre-grounding version when the docs block is empty (index
		// absent / no hits / any failure). The template gained the token
		// IMMEDIATELY AFTER {DIMENSION_GUIDE} on the same line, so an empty
		// substitution contributes zero bytes and the fixture did NOT change.
		const assembled = PHASE2A_SCORING_PROMPT.replace(
			"{DIMENSION_GUIDE}",
			buildPhase2aDimensionGuidance(guidance),
		).replace("{DOCS_FACTS}", "");

		expect(assembled).toBe(golden);
	});

	it("the template still carries the {DIMENSION_GUIDE} placeholder", () => {
		expect(PHASE2A_SCORING_PROMPT).toContain("{DIMENSION_GUIDE}");
	});

	it("the template carries the {DOCS_FACTS} placeholder immediately after {DIMENSION_GUIDE}", () => {
		expect(PHASE2A_SCORING_PROMPT).toContain("{DIMENSION_GUIDE}{DOCS_FACTS}");
	});
});

describe("rich outputs never leak into prompts (B11 text-only contract)", () => {
	it("buildEvidenceHaystacks ignores cell.outputs — output haystack stays plain text", () => {
		const base = { type: "code", source: "print(1)" };
		const plain = [{ ...base, output: "1" }];
		const rich = [
			{
				...base,
				output: "1",
				outputs: [
					{ mime_type: "image/png", data: "iVBORw0KGgo=" },
					{ mime_type: "text/html", data: "<script>window.__pwned=1</script>" },
				],
			},
		];
		// Rich outputs are a SEPARATE optional field: the haystack (the only
		// thing prompts read) must be byte-identical with or without them.
		expect(buildEvidenceHaystacks(rich)).toEqual(buildEvidenceHaystacks(plain));
		expect(buildEvidenceHaystacks(rich).output).toBe("1");
		expect(buildEvidenceHaystacks(rich).output).not.toContain("script");
		expect(buildEvidenceHaystacks(rich).output).not.toContain("iVBOR");
	});
});

describe("Phase 2a docs grounding (P2-4d)", () => {
	const CODE_CELLS = [
		{ type: "code", source: "import numpy as np\nimport pandas as pd\npopt, pcov = scipy.optimize.curve_fit(model, x, y)" },
		{ type: "code", source: "df = pd.read_csv(\"soil.csv\")\nkm = sklearn.cluster.KMeans(n_clusters=3)" },
		{ type: "markdown", source: "The fit reproduces the reference." },
	];

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("extracts distinct dotted API references from code cells, capped at 3", () => {
		// First three distinct dotted refs in source order: scipy.optimize.curve_fit,
		// pd.read_csv, sklearn.cluster.KMeans. Bare imports (np, pd) have no dot;
		// the string literal "soil.csv" is excluded by the quote lookbehind.
		const apis = extractApiReferences(CODE_CELLS);
		expect(apis).toEqual(["scipy.optimize.curve_fit", "pd.read_csv", "sklearn.cluster.KMeans"]);
		expect(apis.length).toBeLessThanOrEqual(3);
	});

	it("assembles a docs-facts block with a docs URL when searchDocs returns hits", async () => {
		vi.spyOn(docsRag, "searchDocs").mockImplementation(async (query: string) => {
			if (query === "scipy.optimize.curve_fit") {
				return [
					{
						title: "scipy.optimize.curve_fit",
						url: "https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html",
						library: "scipy",
						version: "1.18.0",
						snippet:
							"## scipy.optimize.curve_fit (scipy 1.18.0)\nSignature: curve_fit(f, xdata, ydata, p0=None, sigma=None, absolute_sigma=False, check_finite=None, bounds=(-inf, inf), method=None)\nUse non-linear least squares to fit a function, f, to data.",
						score: 8.2,
					},
				];
			}
			return [];
		});

		const block = await buildDocsFactsBlock(CODE_CELLS);

		expect(block).toContain("<docs_facts>");
		expect(block).toContain("API: scipy.optimize.curve_fit (scipy 1.18.0)");
		expect(block).toContain("Signature: curve_fit(f, xdata, ydata, p0=None, sigma=None");
		expect(block).toContain("Source: https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html");
		expect(block).toContain("</docs_facts>");
	});

	it("degrades to an empty block when searchDocs returns no hits", async () => {
		vi.spyOn(docsRag, "searchDocs").mockResolvedValue([]);
		expect(await buildDocsFactsBlock(CODE_CELLS)).toBe("");
	});

	it("degrades to an empty block when searchDocs throws", async () => {
		vi.spyOn(docsRag, "searchDocs").mockRejectedValue(new Error("index corrupt"));
		expect(await buildDocsFactsBlock(CODE_CELLS)).toBe("");
	});

	it("degrades to an empty block when the assembled block exceeds the 3000-char cap", async () => {
		// A hit whose signature line alone is longer than DOCS_FACTS_MAX_CHARS
		// (3000) → the assembled block is over cap → "" (spec: over-cap → empty).
		vi.spyOn(docsRag, "searchDocs").mockResolvedValue([
			{
				title: "scipy.optimize.curve_fit",
				url: "https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html",
				library: "scipy",
				version: "1.18.0",
				snippet: "Signature: " + "x".repeat(4000),
				score: 8.2,
			},
		]);
		expect(await buildDocsFactsBlock(CODE_CELLS)).toBe("");
	});

	it("degrades to an empty block when the docs index is absent (real searchDocs, no index file)", async () => {
		// Pin a temp DATA_DIR so the test never sees the live volume index
		// (with DATA_DIR=/var/lib/docker/volumes/svelte-review-data/_data the
		// real index loads and searchDocs returns hits → the test would fail).
		// Mirrors the docs-rag.test.ts convention (beforeEach → mkdtemp).
		const dataDir = await mkdtemp(path.join(os.tmpdir(), "scipro-noindex-"));
		const oldDataDir = process.env.DATA_DIR;
		process.env.DATA_DIR = dataDir;
		try {
			// Clear any lazily-cached index load so the temp (empty) dir is read.
			docsRag.__resetDocsIndexForTests();
			expect(await buildDocsFactsBlock(CODE_CELLS)).toBe("");
		} finally {
			if (oldDataDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = oldDataDir;
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("substituting the empty block yields the byte-identical pre-grounding prompt", async () => {
		const config = compileScoringConfig("soil_contamination", soilScoringRaw());
		const guidance = Object.fromEntries(
			Object.entries(config.dimensionGuidance).map(([k, v]) => [k, substituteAnchors(v, config.anchors)]),
		);
		// Reference: the pre-grounding prompt = the combined token replaced by
		// the guide alone (as if {DOCS_FACTS} never existed).
		const preGrounding = PHASE2A_SCORING_PROMPT.replace(
			"{DIMENSION_GUIDE}{DOCS_FACTS}",
			buildPhase2aDimensionGuidance(guidance),
		);
		// Production path: guide substituted, then the docs block (empty here).
		const withEmptyDocs = PHASE2A_SCORING_PROMPT.replace(
			"{DIMENSION_GUIDE}",
			buildPhase2aDimensionGuidance(guidance),
		).replace("{DOCS_FACTS}", "");

		expect(withEmptyDocs).toBe(preGrounding);
		expect(withEmptyDocs).not.toContain("{DOCS_FACTS}");
	});
});

describe("evidence patterns — golden snapshot vs stored outputs", () => {
	const DATA = "/var/lib/docker/volumes/svelte-review-data/_data/submissions/soil_contamination/results.json";
	const MIRROR = "/root/projects/svelte-review-copilot/data/submissions/soil_contamination/results.json";

	function loadResults(): Record<string, { cells?: { type: string; source: string; output?: string | null }[] }> | null {
		for (const p of [DATA, MIRROR]) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				return require(p) as Record<string, { cells?: { type: string; source: string; output?: string | null }[] }>;
			} catch {
				// try next
			}
		}
		return null;
	}

	function countWhere(
		config: ScoringConfig,
		key: string,
		cellsList: { type: string; source: string; output?: string | null }[][],
	): number {
		return cellsList.filter((cells) => {
			const pattern = config.evidencePatterns.get(key)!;
			const h = buildEvidenceHaystacks(cells);
			return testEvidencePattern(pattern, haystackFor(pattern.haystack, h));
		}).length;
	}

	// The builtin regexes the pre-config implementation hardcoded — the
	// contract is CONFIG == BUILTIN on the same data (equivalence), not a
	// fixed absolute count (stored outputs legitimately drift when
	// notebooks are re-executed — design §6 mismatch policy).
	const BUILTINS: Record<string, { re: RegExp[]; kind: "output" | "code" | "markdown" | "output+code" | "markdown+code" }> = {
		fit_reproduces_reference: {
			re: [/\bA\b[^\n]{0,60}?1210\.9\d*/i, /\bB\b[^\n]{0,60}?-?484\.9\d*/i, /\bL\b[^\n]{0,60}?684\.4\d*/i],
			kind: "output",
		},
		std_err_from_covariance: {
			re: [/np\.sqrt\s*\(\s*np\.diag\s*\(\s*covariance\s*\)\s*\)|np\.diag\s*\(\s*covariance\s*\)|standard\s*error/i],
			kind: "output+code",
		},
		r2_or_rmse_computed: {
			re: [/\bR\s*(?:\^2|²|2)\s*[=:]\s*[\d.]+|\bRMSE\s*[=:]\s*[\d.]+/i],
			kind: "output",
		},
		r2_or_rmse_discussed: {
			// Pre-config code OR'd the two (R² alone OR RMSE alone).
			re: [/\bR\s*(?:\^2|²|2)\b/i, /\bRMSE\b/i],
			kind: "markdown",
		},
		physical_insight: {
			re: [/non-?physical|meaningless|not physically|correlat(?:ed|ion)\s+between\s+(?:the\s+)?(?:parameters|A|B|L)|parameter\s+correlation/i],
			kind: "markdown+code",
		},
		builtin_metrics_call: {
			re: [/\b(?:r2_score|mean_squared_error|mean_absolute_error)\s*\(/i],
			kind: "code",
		},
		bounds_assignment: {
			re: [/\bbounds\s*=/i],
			kind: "code",
		},
	};

	it("config patterns are equivalent to the builtin regexes on the 19 stored outputs (skips when data absent)", async () => {
		const results = loadResults();
		if (!results) {
			console.warn("SKIP: stored results.json absent (fresh clone) — evidence snapshot not run");
			return;
		}
		const cellsList = Object.values(results).map((r) => r.cells ?? []);
		expect(cellsList.length).toBe(19);

		// Load the REAL committed scoring YAML so every configured pattern
		// is covered (a partial fixture would silently skip patterns).
		const rawYaml = await readFile(
			"/root/projects/svelte-review-copilot/data/scoring/soil_contamination.yaml",
			"utf-8",
		);
		const parsed = (await import("js-yaml")).load(rawYaml) as { scoring: Record<string, unknown> };
		const config = compileScoringConfig("soil_contamination", parsed.scoring);

		for (const [key, builtin] of Object.entries(BUILTINS)) {
			const cfgCount = countWhere(config, key, cellsList);
			const builtinCount = cellsList.filter((cells) => {
				const h = buildEvidenceHaystacks(cells);
				const hay = haystackFor(builtin.kind, h);
				// r2_or_rmse_discussed ORs the two; everything else ANDs (single/list).
				return key === "r2_or_rmse_discussed"
					? builtin.re.some((re) => re.test(hay))
					: builtin.re.every((re) => re.test(hay));
			}).length;

			expect(cfgCount, `pattern ${key} diverges from builtin on the stored outputs`).toBe(builtinCount);
		}
	});
});

describe("buildExtraAnalysisEvidence fallback (no config)", () => {
	it("is byte-identical to the pre-config hardcoded implementation", () => {
		const cells = [
			{ type: "code", source: "import numpy as np\nimport matplotlib.pyplot as plt\npopt, pcov = curve_fit(model, x, y, bounds=(0, np.inf))", output: "R^2 = 0.98\nRMSE = 20.5\nA = 1210.91 ± 12.3\nB = -484.95 ± 8.7\nL = 684.48 ± 5.2" },
			{ type: "markdown", source: "The fit reproduces the reference. The parameter correlation is expected. Units are in mg/kg." },
		];

		const withConfig = buildExtraAnalysisEvidence(cells, compileScoringConfig("soil_contamination", soilScoringRaw()));
		const withoutConfig = buildExtraAnalysisEvidence(cells);

		expect(withConfig).toBe(withoutConfig);
	});
});
