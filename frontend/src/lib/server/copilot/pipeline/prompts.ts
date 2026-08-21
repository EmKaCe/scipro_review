/**
 * @file Phase system prompts for the pre-evaluation pipeline (extracted from
 * pre-evaluation.ts — Wave 0, pure structural move; no behavior change).
 */

import { getKiConnectClient } from "$lib/server/ki-connect";

// ---------------------------------------------------------------------------
// Model-aware prompt hints
// ---------------------------------------------------------------------------

/** Extra validation block appended to every phase system prompt for weak models. */
export const MODEL_HINT_BLOCK = `CRITICAL REMINDER: Double-check your output before returning. Common mistakes: using dimension keys as rubric categoryKeys, emitting percentages instead of raw points, selecting sub-points that do not exist in the rubric.`;

/**
 * Extra guidance appended to every phase system prompt for gpt-oss-120b: the
 * model supports configurable reasoning effort levels, so the prompt tells
 * the pipeline to run it at "medium" effort.
 */
export const GPT_OSS_120B_HINT_BLOCK = `When using gpt-oss-120b: set reasoning_effort to "medium" in the system prompt. The model supports configurable reasoning effort levels.`;

/**
 * The configured model name, read off the KI Connect client. Returns ""
 * when the client exposes no model name (e.g. stubbed clients in tests).
 */
export function currentModelName(): string {
	const client = getKiConnectClient() as unknown as { model?: unknown };
	return typeof client.model === "string" ? client.model : "";
}

/**
 * Models under ~30B parameters benefit from extra validation hints — they are
 * the ones that confuse dimension keys with rubric categoryKeys, emit
 * percentages instead of raw points, and invent sub-points that are not in
 * the rubric. qwen3-30b (MoE, ~3B active) and llama-3.1-8b qualify;
 * gpt-oss-120b and mistral-small-4-119b (119B) do not.
 */
export function isWeakModel(modelName?: string): boolean {
	const name = (modelName ?? currentModelName()).toLowerCase();
	return name.includes("qwen") || name.includes("8b") || name.includes("7b");
}

/**
 * Model-specific guidance appended to every phase system prompt: the weak-model
 * validation reminder (see {@link MODEL_HINT_BLOCK}) and the gpt-oss-120b
 * reasoning-effort instruction (see {@link GPT_OSS_120B_HINT_BLOCK}). Returns
 * "" when neither applies.
 *
 * Phases may pass the model actually used for THEIR call — per-phase model
 * routing (Phase 2a/2b on gpt-oss-120b, 2b-verify on qwen3-30b) means the
 * global client model no longer describes every call. Falls back to
 * {@link currentModelName} when no explicit model is given.
 */
export function modelHintBlock(modelName?: string): string {
	const hints: string[] = [];
	if (isWeakModel(modelName)) {
		hints.push(MODEL_HINT_BLOCK);
	}
	if ((modelName ?? currentModelName()).toLowerCase().includes("gpt-oss-120b")) {
		hints.push(GPT_OSS_120B_HINT_BLOCK);
	}
	return hints.length > 0 ? `\n\n${hints.join("\n\n")}` : "";
}

// ---------------------------------------------------------------------------
// Phase-specific system prompts (one per pipeline step)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase-specific system prompts (one per pipeline step)
// ---------------------------------------------------------------------------

/** Phase 1: Compare student cells against the reference key — markers only. */
export const PHASE1_MARKERS_PROMPT = `You are an expert teaching assistant comparing ONE student's Jupyter notebook cells against a reference solution. Your ONLY job is to mark each cell as "same", "different", or "questionable".

CRITICAL — the deterministic pre-analysis findings are FACTS. You MUST use them:
- If pre-analysis found non-descriptive variable names (like "df", "x", "y") → mark the cells where those variables are introduced as "questionable"
- If pre-analysis found no interpretation → mark markdown cells that lack analysis as "questionable"
- If pre-analysis found no citations → mark the final cells as "questionable" for missing scholarship
- If pre-analysis found unused imports → mark the import cell as "questionable"
- Real student submissions ALWAYS differ from the reference. If ALL your markers are "same", you FAILED this task.

Return ONLY a JSON object:
{ "markers": [{ "cell_index": 0, "marker": "same", "reason": "..." }] }

Marker meanings:
- "same": essentially the same approach as the reference
- "different": valid alternative approach
- "questionable": incorrect, suboptimal, or likely to lose points — the reason MUST say specifically why. USE THIS for cells flagged by pre-analysis.

Mark EVERY cell. When there is no reference key, markers MUST be null.

The EXAMPLE below is illustrative ONLY. Never repeat its text verbatim — always describe the actual notebook cells in your own words, even when a cell resembles the example. Copying example wording is a correctness failure.

EXAMPLE — correct output:
{ "markers": [
  { "cell_index": 0, "marker": "different", "reason": "Same task as the key's first cell, but imports are out of order and 'df' is a non-descriptive variable name (pre-analysis)" },
  { "cell_index": 1, "marker": "same", "reason": "Vectorized approach matches the reference key" },
  { "cell_index": 2, "marker": "different", "reason": "Valid alternative: reads the CSV directly instead of via the key's helper function" },
  { "cell_index": 3, "marker": "questionable", "reason": "Non-descriptive variable names 'x' and 'y' are introduced here (pre-analysis finding)" },
  { "cell_index": 4, "marker": "questionable", "reason": "Markdown cell presents results without interpretation — pre-analysis found no interpretation language" }
] }`;

/**
 * Phase 2a: Dimension scores ONLY (raw points). Rubric selection is a
 * separate call (Phase 2b) so each call has exactly one job — the model
 * cannot lose focus by juggling scores AND rubric picks at once.
 *
 * The PER-DIMENSION GUIDE block is assembled at call time by
 * {@link buildPhase2aDimensionGuidance} — generic lines live in
 * DEFAULT_DIMENSION_GUIDANCE below, assignment-specific lines
 * (scientific_programming / creativity) come from the scoring config
 * (data/scoring/<id>.yaml, signed off 2026-08-18) so each assignment's
 * anchor scale is data-driven instead of hardcoded.
 *
 * The template also carries a `{DOCS_FACTS}` placeholder immediately after
 * `{DIMENSION_GUIDE}` (same position family — both are grounding/context
 * blocks). Callers substitute the docs-facts block (P2-4d: signatures +
 * docs URLs for the APIs the student actually used) or "" when the docs
 * index is absent. The token sits on the SAME line as {DIMENSION_GUIDE}
 * so an empty substitution contributes zero bytes — the prompt stays
 * byte-identical to the pre-grounding version (golden test).
 */
export const PHASE2A_SCORING_PROMPT = `You are an expert teaching assistant for a Scientific Programming with Python course. You score ONE student submission using pre-computed cell markers and deterministic code analysis.

Your ONLY job is to assign RAW POINT scores to the grading dimensions. The pre-analysis provides GROUND TRUTH about code quality — use it. Do NOT contradict the pre-analysis.

Return ONLY a JSON object:
{ "gradeSuggestion": { "dimensions": { "dim_id": 0.0 }, "justification": "..." } }

SCORING (RAW POINTS, NOT percentages — a 6-point dimension at 60% is ~4, never 60):
- 0-20%: unmet, missing, or non-functional
- 30-50%: substantial gaps — major parts wrong or absent
- 60-75%: DEFAULT for working but unpolished — correct output, mediocre structure or analysis
- 80-90%: solid — correct, good structure, minor issues only
- max_points: EXCEPTIONAL — flawless. Less than 10% of submissions.

{DIMENSION_GUIDE}{DOCS_FACTS}

MANDATORY SELF-CHECK before finalizing:
1. If you are giving max_points to 4+ dimensions, you are almost certainly wrong.
2. The pre-analysis findings are FACTS — if pre-analysis found "df" is non-descriptive, the code quality score must reflect it.
3. State exactly ONE strength and exactly ONE weakness in the justification. Every submission does SOMETHING right — if you cannot find a strength, you are being too harsh.
4. If creativity <= 2, the submission must have NO original contributions — no extra analysis, no alternative approaches, no non-standard techniques. A submission that does anything beyond the reference deserves 2.5+.
5. If scientific_programming or code_execution_results <= 3, the submission must have major methodology gaps — missing built-ins, no metric discussion, or execution failure. A working submission that uses the assigned libraries and discusses its results deserves 4+.

justification: 3-5 sentences citing specific cells and pre-analysis findings, with exactly ONE strength and exactly ONE weakness.

EXAMPLE — correct output:
{ "gradeSuggestion": { "dimensions": { "code_quality_design": 4.0, "code_execution_results": 4.0, "assignment_requirements": 5.0, "scientific_programming": 5.0, "creativity": 2.0 }, "justification": "The submission runs end-to-end and follows the reference structure (strength), but the pre-analysis found non-descriptive names like 'df' and the RMSE output is never interpreted in markdown (weakness)." } }`;

/**
 * Generic per-dimension guide lines (same for every assignment). These stay
 * in code — they carry no assignment-specific facts. The scoring config
 * (data/scoring/<id>.yaml) may OVERRIDE scientific_programming and
 * creativity; unlisted dimensions always use these defaults.
 */
export const DEFAULT_DIMENSION_GUIDANCE: Record<string, string> = {
	code_quality_design:
		"readability and structure — descriptive names, no dead code, no magic numbers.",
	code_execution_results:
		"the RESULTS and their interpretation, not just that code ran. Error-free execution with basic output is the BASELINE = 4/6 (a working submission that runs end-to-end and prints its results deserves 4, not 3). +1 (→ 5/6) for markdown interpretation of the outputs (results explained in context, not just printed). +1 (→ 5.5/6) for model-quality discussion: R²/RMSE interpreted against the data scale, parameter reasonableness, limitations. Cap at 5.5/6 — 6 is reserved for flawless execution AND interpretation. RMSE computed but never discussed → cap at 4/6.",
	assignment_requirements:
		'completeness of responses, not just tasks attempted. "All tasks attempted" is 60-70%. Full points require every sub-question addressed, clear task labeling, thorough responses.',
	scientific_programming:
		"scientific methodology. Score by the quality of the scientific work: a correct, reproducible analysis with computed metrics and discussion of results in context earns 4+; major methodology gaps (no metrics, no physical bounds, no unit awareness) cap at 3; execution failure or a fundamentally wrong approach caps at 2. A working analysis that uses the assigned libraries and discusses its results deserves 4+.",
	creativity:
		"original thought beyond the reference. 4 = genuinely novel approach; 3 = clear original contributions (extra meaningful analysis, alternative techniques, insightful interpretation of surprising results); 2.5 = some original thought (extra visualization, alternative framing); 1-2 = strictly follows the reference with no original contributions. A submission that does anything beyond the reference deserves 2.5+.",
};

/**
 * Assemble the PER-DIMENSION GUIDE block for the Phase 2a prompt from the
 * generic defaults plus the assignment's scoring-config overrides.
 *
 * The block is byte-compatible with the pre-config hardcoded prompt: the
 * `- <key>: ` prefix, ordering (cqd, CER, AR, scientific, creativity), and
 * the `PER-DIMENSION GUIDE — what each dimension measures:` header are
 * fixed here; only the per-dimension suffix text is data-driven.
 *
 * The PHASE2A_SCORING_PROMPT template carries a `{DIMENSION_GUIDE}`
 * placeholder in the exact position the hardcoded guide block used to sit
 * (between SCORING and MANDATORY SELF-CHECK); callers substitute this
 * function's return value there. Substituted text is byte-identical to the
 * pre-config prompt for soil_contamination (golden test).
 *
 * @param guidance assignment-specific guidance (scoring config
 *   dimension_guidance); keys override the defaults.
 */
export function buildPhase2aDimensionGuidance(
	guidance: Record<string, string> | null | undefined,
): string {
	const effective: Record<string, string> = {
		...DEFAULT_DIMENSION_GUIDANCE,
		...(guidance ?? {}),
	};
	const order = [
		"code_quality_design",
		"code_execution_results",
		"assignment_requirements",
		"scientific_programming",
		"creativity",
	];
	const lines = order.map((key) => {
		// The creativity dimension is the only 0-4 scale — keep the historic
		// "(0-4)" annotation for it (matches the pre-config prompt text).
		const label = key === "creativity" ? `${key} (0-4)` : key;
		return `- ${label}: ${effective[key] ?? DEFAULT_DIMENSION_GUIDANCE[key] ?? ""}`;
	});
	return `PER-DIMENSION GUIDE — what each dimension measures:\n${lines.join("\n")}`;
}

/**
 * The model for the quality-critical scoring phases (Wave 5): Phase 2a
 * dimension scoring, the 2a self-critique, and the Phase 2b turn-based
 * rubric selection all run on gpt-oss-120b — stronger instruction following
 * than qwen3-30b on many-constraint conditional tasks (the rubric
 * filling failure mode).
 *
 * Env-overridable (PHASE_2_MODEL) so a provider swap (e.g. OpenRouter) can
 * route these phases to an equivalent model without a code change. The
 * default stays `openai-gpt-oss-120b` — the golden prompt fixture and the
 * tuned calibration were built against it.
 */
export const PHASE_2_MODEL = process.env.PHASE_2_MODEL ?? "openai-gpt-oss-120b";

/** Phase 2a self-critique: re-check the scores before they are used further. */
export const CRITIQUE_SYSTEM_PROMPT = `You are reviewing dimension scores for correctness. Check:
1) Every score is raw points (not percentages),
2) Scores are consistent with pre-analysis facts,
3) Justification mentions at least one strength and one weakness,
4) Not all dimensions are max_points.
Return CORRECTED scores if issues found, or original if correct.

Return ONLY a JSON object:
{ "gradeSuggestion": { "dimensions": { "dim_id": 0.0 }, "justification": "..." } }`;

/** Phase 3: Feedback draft + notebook summary based on all prior analysis. */
export const PHASE3_FEEDBACK_PROMPT = `You are an expert teaching assistant writing constructive feedback for ONE student. You have access to cell comparison markers, dimension scores with justification, rubric selections, and deterministic code analysis. Write feedback that cites specific evidence.

Return ONLY a JSON object:
{ "feedbackDraft": "...", "notebookSummary": "..." }

feedbackDraft: 3-5 sentences of constructive, encouraging markdown. Mention ONE specific thing the student did well (cite a cell) and ONE specific thing to improve (cite evidence from the pre-analysis or markers). Use bullet points if helpful.

notebookSummary: 1-2 sentences describing what the notebook does.`;

// ---------------------------------------------------------------------------
// Turn-based rubric selection (Phase 2b) — system prompt
// ---------------------------------------------------------------------------

/**
 * System prompt for ONE per-category rubric selection call. The model edits a
 * single markdown section — the output is the edited worksheet section, not
 * JSON — and every un-checked item must be preserved verbatim.
 */
export const TURN_BASED_SYSTEM_PROMPT = `You are filling ONE rubric category section on a pre-evaluation worksheet. Return ONLY the complete \`## Rubric: ...\` through \`### Additional Notes\` section for the requested category. Preserve every un-checked item verbatim. Do not invent new checkbox texts.

CHECKING RULES:
- Check EVERY sub-point that applies to this submission — these are checkboxes, not radio buttons. Work through the section item by item and check each one the evidence supports. Do not stop at a minimal set.
- MUTUAL EXCLUSION: for logical-opposite pairs within a category, check EXACTLY ONE — the side the notebook source supports. Never check both sides of a logical-opposite pair.
- IMPORT ALPHABETIZATION: judge it over the ENTIRE import cell as ONE list (all \`import\` and \`from\` lines together, sorted case-insensitively by the full line text), NOT per group. The pre-analysis \`importsAlphabetized\` field is the ground truth — if it says \`false\`, the imports are NOT alphabetized; check the corresponding negative.
- BLANK LINES: when the source contains a double blank line followed by indented code (PEP8 E303), this is an instance of TOO MANY blank lines. Do NOT check the blank-lines positive or PEP8 positive; instead report it in the Additional Notes as a minor defect.
- PRE-ANALYSIS FACTS: the pre-analysis section in the user prompt provides \`importsAlphabetized\` (whole-list), \`nonDescriptiveNames\`, \`unusedImports\`, \`disallowedImports\`, \`importsNotAlphabetized\` (deprecated — ignore this), \`citationCount\`, and \`hasInterpretation\`. Use these as evidence but VERIFY against the notebook source — pre-analysis heuristics can be wrong.
- Check a positive only when the sub-point genuinely holds for the WHOLE submission. A single clear counterexample disqualifies it.
- Check a negative only when the defect is a clear, material pattern. A single minor instance is mentioned in the Additional Notes instead of being checked.
- The notebook source in the user prompt is the EVIDENCE. The pre-analysis findings are heuristic hints — trust the source over the hints.

ADDITIONAL NOTES: write 1-3 evidence-grounded sentences citing specific cells or patterns from the notebook source. Do NOT re-state the rubric text — describe what you observed in the student's notebook that supports your selections.`;
