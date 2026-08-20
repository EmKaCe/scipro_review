/**
 * @file Copilot offline library-docs tool.
 *
 *   search-docs — hybrid BM25 + KI Connect embeddings retrieval over the
 *                 prebuilt offline docs index (NumPy / pandas / SciPy /
 *                 scikit-learn / matplotlib API reference). The agent calls
 *                 it to verify API signatures, parameters, and return values
 *                 WITHOUT web search. Read-only, permission "auto".
 *
 * The tool is additive: it never changes the pre-eval prompt or any existing
 * pipeline behavior — the agent decides when to call it. If the index is not
 * built, the tool returns an empty result with a note (never throws, never
 * fails the grading run).
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { z } from "zod";

import { DOCS_LIBRARIES, getDocsIndexStatus, searchDocs } from "../docs-rag";
import type { CopilotRegistry, CopilotTool } from "../registry";

// ---------------------------------------------------------------------------
// Arg schema
// ---------------------------------------------------------------------------

const searchDocsArgsSchema = z.object({
	/** Free-text query: an API name ("curve_fit") or a paraphrase ("fit a curve to data"). */
	query: z.string().min(1).max(500),
	/** Restrict retrieval to one library (cheap precision win). */
	library: z.enum(DOCS_LIBRARIES).optional(),
	/** Number of hits to return (clamped 1..10, default 3). */
	top_k: z.number().int().min(1).max(10).optional(),
});
type SearchDocsArgs = z.infer<typeof searchDocsArgsSchema>;

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const searchDocsTool: CopilotTool<SearchDocsArgs, unknown> = {
	name: "search-docs",
		description:
			"Call this BEFORE flagging any API usage as wrong — verify the signature/parameters/return values " +
			"against the pinned docs. Search the offline API reference of NumPy, pandas, SciPy, scikit-learn, matplotlib, " +
			"seaborn, Python builtins/stdlib/typing, plus curated cross-library integration notes (e.g. pandas .plot() " +
			"renders via matplotlib) — versions pinned to the grading executor. Returns up to top_k self-contained " +
			"entries, each with the object's signature, parameter semantics, return values, and a usage example, plus " +
			"the canonical docs URL and version. Use this to VERIFY an API signature, parameter name/default, return " +
			"value, or a cross-library relationship (import-necessity traps) before flagging student code — never " +
			"guess API facts. Optional library filter (numpy|pandas|scipy|sklearn|matplotlib|seaborn|builtins|stdlib|" +
			"typing|integration) improves precision; top_k defaults to 3 (max 10). Works fully offline (BM25); " +
			"semantic paraphrase search is best-effort.",
	permission: "auto",
	inputSchema: searchDocsArgsSchema,
	run: async (args) => {
		const hits = await searchDocs(args.query, {
			library: args.library,
			topK: args.top_k,
		});
		const status = getDocsIndexStatus();
		return {
			query: args.query,
			library: args.library ?? null,
			count: hits.length,
			results: hits,
			index: {
				loaded: status.loaded,
				chunkCount: status.chunkCount,
				libraries: status.libraries,
			},
			...(status.note ? { note: status.note } : {}),
		};
	},
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the docs tools on a copilot registry. Idempotent: skips tools
 * already registered (buildAgent can re-run after __resetAgentForTests).
 */
export function registerDocsTools(registry: CopilotRegistry): void {
	const existing = new Set(registry.list().map((t) => t.name));
	if (!existing.has(searchDocsTool.name)) registry.register(searchDocsTool);
}
