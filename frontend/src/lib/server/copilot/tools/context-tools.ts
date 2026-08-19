/**
 * @file Copilot CONTEXT tools — the agent's ground truth about a submission,
 * the dashboard, an assignment, and the settings.
 *
 * Four read-only tools (all `permission: "auto"`):
 *
 *   get-submission-context — one submission's metadata, execution status,
 *     bounded per-cell previews (sources capped at 40 lines, outputs at
 *     500 chars), and the teacher's grading state.
 *   list-submissions       — the dashboard list: statuses, grades, and
 *     whether execution results exist per student.
 *   get-assignment         — assignment config (title, criteria files,
 *     dimensions) plus materials presence (key/pdf/input-data).
 *   get-settings           — the non-secret AppSettings (executor, llm,
 *     copilot). Key-like fields are scrubbed defensively.
 *
 * Bounded-payload rules (plan 4b / token-budget decision):
 *   - never dump full cell sources or outputs; truncate with markers and
 *     summarize the truncation in `truncationNotice`.
 *   - tools have NO top-level side effects — every service call happens
 *     inside run().
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { CopilotRegistry, CopilotTool } from "../registry";
import { getAssignmentById, resolveAssignmentId } from "$lib/server/assignments";
import { getDataDir, getSubmission, listSubmissions } from "$lib/server/metadata";
import { readResults } from "$lib/server/results-store";
import { loadSettings, type AppSettings } from "$lib/server/settings";
import { INJECTION_CELL_PLACEHOLDER, screenStudentContent } from "../screening";

// ---------------------------------------------------------------------------
// Preview bounds
// ---------------------------------------------------------------------------

const SOURCE_PREVIEW_LINES = 40;
const OUTPUT_PREVIEW_CHARS = 500;
const SOURCE_TRUNCATION_MARKER = "\n… [source truncated after 40 lines]";
const OUTPUT_TRUNCATION_MARKER = "… [output truncated]";

// ---------------------------------------------------------------------------
// Shared arg schemas
// ---------------------------------------------------------------------------

const submissionIdArgs = z.object({
	/** Student id of the submission to inspect. Falls back to ctx.submissionId. */
	submissionId: z.string().optional(),
	/** Assignment id; falls back to ctx.assignmentId, then the first enabled one. */
	assignmentId: z.string().optional(),
});

const assignmentIdArgs = z.object({
	assignmentId: z.string().optional(),
});

const requiredAssignmentIdArgs = z.object({
	assignmentId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First `SOURCE_PREVIEW_LINES` lines of source, with a truncation marker. */
function previewSource(source: string): { text: string; truncated: boolean } {
	const lines = source.split("\n");
	if (lines.length <= SOURCE_PREVIEW_LINES) {
		return { text: source, truncated: false };
	}
	return {
		text: `${lines.slice(0, SOURCE_PREVIEW_LINES).join("\n")}${SOURCE_TRUNCATION_MARKER}`,
		truncated: true,
	};
}

/** First `OUTPUT_PREVIEW_CHARS` chars of output, with a truncation marker. */
function previewOutput(output: string): { text: string; truncated: boolean } {
	if (output.length <= OUTPUT_PREVIEW_CHARS) {
		return { text: output, truncated: false };
	}
	return {
		text: `${output.slice(0, OUTPUT_PREVIEW_CHARS)}${OUTPUT_TRUNCATION_MARKER}`,
		truncated: true,
	};
}

/** True for key.ipynb or the <name>_key.ipynb convention used in sample data. */
function isKeyNotebook(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "key.ipynb" || lower.endsWith("_key.ipynb");
}

/**
 * Scan <DATA_DIR>/materials/<assignmentId>/ for material presence, mirroring
 * the dashboard's /api/assignments/[id]/materials route rules (pdf and key
 * notebooks at the root, data files under input_data/).
 */
async function scanMaterialPresence(
	assignmentId: string,
): Promise<{ hasKey: boolean; hasPdf: boolean; hasInputData: boolean }> {
	const root = path.join(getDataDir(), "materials", assignmentId);
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return { hasKey: false, hasPdf: false, hasInputData: false };
		}
		throw err;
	}

	let hasKey = false;
	let hasPdf = false;
	let hasInputData = false;

	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (entry.name === "input_data") {
				const inner = await readdir(path.join(root, entry.name)).catch(() => []);
				hasInputData = inner.length > 0;
			}
			continue;
		}
		if (entry.name.toLowerCase().endsWith(".pdf")) hasPdf = true;
		if (isKeyNotebook(entry.name)) hasKey = true;
	}

	return { hasKey, hasPdf, hasInputData };
}

const SECRET_KEY_PATTERN = /api_?key|token|secret|password|credential/i;

/**
 * Recursively drop key-like fields (apiKey, access_token, clientSecret, …)
 * from a settings payload. AppSettings has none today, but this guarantees
 * get-settings can never leak a secret even if the shape grows.
 */
function scrubSecrets<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => scrubSecrets(item)) as T;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (SECRET_KEY_PATTERN.test(key)) continue;
			out[key] = scrubSecrets(item);
		}
		return out as T;
	}
	return value;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const getSubmissionContextTool: CopilotTool<z.infer<typeof submissionIdArgs>> = {
	name: "get-submission-context",
	description:
		"Load ground-truth context for one submission: student metadata, execution status, per-cell errors with bounded source/output previews, and the teacher's grading state (rubric, dimensions, feedback, notes, autofix dispositions).",
	permission: "auto",
	inputSchema: submissionIdArgs,
	run: async (args, ctx) => {
		const submissionId = args.submissionId?.trim() || ctx.submissionId?.trim();
		if (!submissionId) {
			throw new Error("get-submission-context requires a submissionId (argument or context)");
		}
		const assignmentId =
			args.assignmentId?.trim() ||
			ctx.assignmentId?.trim() ||
			(await resolveAssignmentId(null));
		if (!assignmentId) {
			throw new Error(
				"get-submission-context: no assignmentId given and no assignment is configured",
			);
		}

		const record = await getSubmission(assignmentId, submissionId);
		if (!record) {
			throw new Error(
				`Submission "${submissionId}" not found in assignment "${assignmentId}"`,
			);
		}

		const results = await readResults(assignmentId);
		const stored = results[record.id];

		const cells = stored?.cells ?? [];
		let truncatedSources = 0;
		let truncatedOutputs = 0;
		let injectionCells = 0;
		// (B13) Cell source + text output are UNTRUSTED student content flowing
		// into the model as a tool result — screen each cell before returning it.
		// FAIL-OPEN: screenStudentContent degrades to "clean" on any API/parse
		// failure, so a guard failure never breaks the tool.
		const executedCells: {
			index: number;
			cell_type: string;
			error: string | null;
			sourcePreview: string;
			outputPreview: string;
		}[] = [];
		for (const cell of cells) {
			// What the student actually wrote (what the teacher sees); the
			// cleaned as-executed source is the fallback when absent.
			const source = cell.original_source?.trim() ? cell.original_source : cell.source;
			const sourcePreview = previewSource(source);
			const outputPreview = previewOutput(cell.output ?? "");
			if (sourcePreview.truncated) truncatedSources += 1;
			if (outputPreview.truncated) truncatedOutputs += 1;

			let sourceText = sourcePreview.text;
			let outputText = outputPreview.text;
			const verdict = await screenStudentContent(`${sourceText}\n\n${outputText}`);
			if (verdict === "injection") {
				injectionCells += 1;
				sourceText = INJECTION_CELL_PLACEHOLDER;
				outputText = "";
			}

			executedCells.push({
				index: cell.index,
				cell_type: cell.type,
				error: cell.error ?? null,
				sourcePreview: sourceText,
				outputPreview: outputText,
			});
		}

		const noticeParts: string[] = [];
		if (truncatedSources > 0) {
			noticeParts.push(
				`${truncatedSources} of ${executedCells.length} cell sources truncated at ${SOURCE_PREVIEW_LINES} lines`,
			);
		}
		if (truncatedOutputs > 0) {
			noticeParts.push(
				`${truncatedOutputs} of ${executedCells.length} cell outputs truncated at ${OUTPUT_PREVIEW_CHARS} chars`,
			);
		}
		if (injectionCells > 0) {
			noticeParts.push(
				`${injectionCells} of ${executedCells.length} cells flagged for possible injection — content removed`,
			);
		}

		const grading = record.grading;
		const preEval =
			stored && "preEval" in stored
				? (stored as StoredExecutionResultWithPreEval).preEval
				: undefined;

		return {
			studentId: record.studentId,
			assignmentId: record.assignmentId,
			status: record.status,
			fileName: record.fileName,
			uploadedAt: record.createdAt,
			error: record.error ?? null,
			cellCount: stored ? (stored.totalCells ?? cells.length) : 0,
			executedCells,
			rubric: grading?.rubric ?? {},
			feedback: grading?.feedback ?? {},
			gradingDimensions: grading?.dimensions ?? {},
			notes: grading?.notes ?? null,
			autofixDispositions: grading?.autofixDispositions ?? {},
			...(preEval !== undefined ? { preEval } : {}),
			truncationNotice: noticeParts.length > 0 ? noticeParts.join("; ") : null,
		};
	},
};

const listSubmissionsTool: CopilotTool<z.infer<typeof assignmentIdArgs>> = {
	name: "list-submissions",
	description:
		"List all submissions for an assignment with their status, teacher grade, pre-evaluation grade (when recorded), and whether execution results exist.",
	permission: "auto",
	inputSchema: assignmentIdArgs,
	run: async (args, ctx) => {
		const assignmentId =
			args.assignmentId?.trim() ||
			ctx.assignmentId?.trim() ||
			(await resolveAssignmentId(null));
		if (!assignmentId) {
			throw new Error(
				"list-submissions: no assignmentId given and no assignment is configured",
			);
		}

		const records = await listSubmissions(assignmentId);
		const results = await readResults(assignmentId);

		const submissions = records.map((record) => ({
			studentId: record.studentId,
			status: record.status,
			teacherGrade: record.teacherGrade ?? null,
			hasResults: record.id in results,
		}));

		return { assignmentId, count: submissions.length, submissions };
	},
};

const getAssignmentTool: CopilotTool<z.infer<typeof requiredAssignmentIdArgs>> = {
	name: "get-assignment",
	description:
		"Load an assignment's configuration: id, title, enabled flag, criteria files, grading dimensions, and uploaded materials presence (key notebook, pdf, input data).",
	permission: "auto",
	inputSchema: requiredAssignmentIdArgs,
	run: async (args) => {
		const assignment = await getAssignmentById(args.assignmentId);
		if (!assignment) {
			throw new Error(`Assignment "${args.assignmentId}" not found in assignments.yaml`);
		}
		return {
			id: assignment.id,
			title: assignment.title,
			enabled: assignment.enabled,
			criteriaFiles: [...assignment.criteria_files],
			dimensions: [...assignment.dimensions],
			materials: await scanMaterialPresence(args.assignmentId),
		};
	},
};

const getSettingsTool: CopilotTool = {
	name: "get-settings",
	description:
		"Load the current non-secret application settings (executor timeouts, LLM endpoint/model, copilot approval policy). Never includes API keys or secrets.",
	permission: "auto",
	inputSchema: z.object({}),
	run: async () => scrubSecrets(await loadSettings()) as AppSettings,
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the four context tools on the given registry (all auto). */
export function registerContextTools(registry: CopilotRegistry): void {
	// Idempotent: skip tools already registered (buildAgent can re-run after
	// __resetAgentForTests, and the registry rejects duplicate names).
	const existing = new Set(registry.list().map((t) => t.name));
	for (const tool of [
		getSubmissionContextTool,
		listSubmissionsTool,
		getAssignmentTool,
		getSettingsTool,
	]) {
		if (!existing.has(tool.name)) registry.register(tool);
	}
}

/** Stored execution result that may carry a future `preEval` block. */
type StoredExecutionResultWithPreEval = { preEval?: unknown };
