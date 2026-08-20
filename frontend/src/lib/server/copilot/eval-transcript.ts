/**
 * @file P12 — runEvals regression harness: extraction over recorded transcripts.
 *
 * PURE extraction (no LLM, deterministic) of GRADING PROPOSALS from recorded
 * copilot transcripts. The copilot persists every thread + message as JSON
 * files under `DATA_DIR/copilot/memory/{threads,messages}/` (see
 * file-memory.ts); messages use the Mastra V2 content shape
 * `{ format: 2, parts: MastraMessagePart[] }` with tool invocations at
 * `part.toolInvocation` (toolName / args / result).
 *
 * A "grading proposal" is exactly what the rubric-fidelity scorer judges
 * (RubricFidelityInput): the dimension scores, rubric selections and
 * feedback the copilot wrote in ONE assistant turn, keyed to an assignment.
 * The harness replays recorded turns through the live judge without ever
 * touching the agent — a regression harness for the copilot's grading
 * fidelity over real conversational data.
 *
 * Grouping rule: one assistant message (one turn) = at most one proposal.
 * set-rubric-item calls accumulate into `rubric`, update-grade-dimension
 * into `dimensions`, write-notes/draft-notes into `feedback`; a turn with
 * no grading write yields no proposal. Non-grading tools (compare-to-key,
 * get-assignment, analyze-code, …) are ignored.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { getDataDir } from "$lib/server/metadata";
import type { RubricFidelityInput } from "./rubric-fidelity";

// ---------------------------------------------------------------------------
// Part shape (recorded V2 messages — verified against the live store
// 2026-08-19: part.type is "tool-invocation", the invocation object carries
// toolName/args/result/state, roles are user|assistant|system|signal).
// ---------------------------------------------------------------------------

interface ToolInvocationRecord {
	toolName?: unknown;
	args?: unknown;
	result?: unknown;
}

interface MessagePart {
	type?: unknown;
	toolInvocation?: ToolInvocationRecord | null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** The grading WRITE tools whose payloads make up a proposal. */
const GRADING_TOOLS = new Set([
	"set-rubric-item",
	"update-grade-dimension",
	"write-notes",
	"draft-notes",
]);

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const raw = record[key];
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/**
 * Extract at most one grading proposal from ONE assistant turn's parts.
 *
 * - set-rubric-item: args.criterionKey → args.optionKey becomes a rubric
 *   entry (result fallback: result.rubricItem / result.rubric).
 * - update-grade-dimension: args.dimensionId → args.value becomes a
 *   dimension entry (result fallback: result.dimension / result.dimensions).
 * - write-notes / draft-notes: the notes text becomes `feedback`
 *   (args.notes preferred; result.notes fallback).
 *
 * Unknown tools and non-grading tools are skipped. Returns [] when the turn
 * contains no grading write.
 */
export function extractGradingProposals(parts: ReadonlyArray<unknown>): RubricFidelityInput[] {
	const rubric: Record<string, string> = {};
	const dimensions: Record<string, number> = {};
	let feedback: string | undefined;
	let wrote = false;

	for (const rawPart of parts) {
		const part = rawPart as MessagePart | null;
		if (part?.type !== "tool-invocation") continue;
		const invocation = part.toolInvocation;
		const toolName = typeof invocation?.toolName === "string" ? invocation.toolName : "";
		if (!GRADING_TOOLS.has(toolName)) continue;

		const args = asRecord(invocation?.args);
		const result = asRecord(invocation?.result);

		if (toolName === "set-rubric-item") {
			const criterionKey =
				stringField(args, "criterionKey") ??
				stringField(asRecord(result.rubricItem), "criterionKey");
			const optionKey =
				stringField(args, "optionKey") ?? stringField(asRecord(result.rubricItem), "optionKey");
			if (criterionKey && optionKey) {
				rubric[criterionKey] = optionKey;
				wrote = true;
			}
			continue;
		}

		if (toolName === "update-grade-dimension") {
			const dimensionId =
				stringField(args, "dimensionId") ?? stringField(asRecord(result.dimension), "dimensionId");
			const value =
				numberField(args, "value") ?? numberField(asRecord(result.dimension), "value");
			if (dimensionId && value !== undefined) {
				dimensions[dimensionId] = value;
				wrote = true;
			}
			continue;
		}

		// write-notes / draft-notes → feedback
		const notes = stringField(args, "notes") ?? stringField(result, "notes");
		if (notes !== undefined) {
			feedback = notes;
			wrote = true;
		}
	}

	if (!wrote) return [];

	const proposal: RubricFidelityInput = {};
	if (Object.keys(rubric).length > 0) proposal.rubric = rubric;
	if (Object.keys(dimensions).length > 0) proposal.dimensions = dimensions;
	if (feedback !== undefined) proposal.feedback = feedback;
	return [proposal];
}

// ---------------------------------------------------------------------------
// Recorded-thread loading
// ---------------------------------------------------------------------------

/** One recorded thread's grading proposals (one entry per assistant turn). */
export interface RecordedTranscriptEval {
	threadId: string;
	title: string;
	resourceId: string;
	/** Grading proposals, in conversation order (one per grading turn). */
	proposals: RubricFidelityInput[];
	/** 1-based assistant-message index of each proposal's turn. */
	turns: number[];
}

/**
 * Fallback submission → assignment map for the harness. The recorded
 * threads carry `resourceId` = submissionId; the judge needs the ASSIGNMENT
 * id to ground against the rubric. Thread metadata wins when it already
 * carries `assignmentId`; otherwise this map is used. New assignments must
 * be added here (or persisted on the thread metadata).
 *
 * NOTE (2026-08-20, privacy): no real submission IDs are hard-coded here —
 * real student IDs were removed from the repo. Prefer persisting
 * `assignmentId` on thread metadata; rely on metadata, not a hard-coded map.
 */
const SUBMISSION_TO_ASSIGNMENT: Record<string, string> = {};

async function readJsonFile<T>(file: string): Promise<T | null> {
	try {
		const raw = await readFile(file, "utf8");
		return JSON.parse(raw) as T;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/**
 * Load every recorded thread with at least one grading proposal.
 *
 * Reads the SAME store the FileMemoryStore uses (`DATA_DIR` via
 * getDataDir(), mirroring file-memory.ts exactly — no hard-coded paths).
 * Threads without grading writes (e.g. the e2e-smoke thread, which only
 * gathers context and compares to the reference key) are skipped.
 *
 * `dataDir` defaults to the app's DATA_DIR; tests pass an explicit temp dir.
 */
export async function loadRecordedThreads(
	dataDir: string = getDataDir(),
): Promise<RecordedTranscriptEval[]> {
	const threadsDir = path.join(dataDir, "copilot", "memory", "threads");
	const messagesDir = path.join(dataDir, "copilot", "memory", "messages");

	let files: string[];
	try {
		files = (await readdir(threadsDir)).filter((f) => f.endsWith(".json"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const results: RecordedTranscriptEval[] = [];
	for (const file of [...files].sort()) {
		const threadId = file.slice(0, -".json".length);
		const thread = await readJsonFile<{
			id?: unknown;
			title?: unknown;
			resourceId?: unknown;
			metadata?: Record<string, unknown>;
		}>(path.join(threadsDir, file));
		const messages = await readJsonFile<unknown[]>(path.join(messagesDir, file));
		if (!thread || !Array.isArray(messages)) continue;

		const resourceId = typeof thread.resourceId === "string" ? thread.resourceId : "";
		const metadataAssignmentId =
			typeof thread.metadata?.assignmentId === "string" ? thread.metadata.assignmentId : undefined;
		const assignmentId = metadataAssignmentId ?? SUBMISSION_TO_ASSIGNMENT[resourceId];

		const proposals: RubricFidelityInput[] = [];
		const turns: number[] = [];
		messages.forEach((rawMessage, index) => {
			const message = rawMessage as {
				role?: unknown;
				content?: { format?: unknown; parts?: unknown };
			};
			if (message?.role !== "assistant") return;
			const parts = Array.isArray(message.content?.parts) ? message.content.parts : [];
			const extracted = extractGradingProposals(parts);
			if (extracted.length === 0) return;
			for (const proposal of extracted) {
				if (assignmentId && proposal.assignmentId === undefined) {
					proposal.assignmentId = assignmentId;
				}
				proposals.push(proposal);
				turns.push(index + 1);
			}
		});

		if (proposals.length === 0) continue;
		results.push({
			threadId,
			title: typeof thread.title === "string" ? thread.title : "",
			resourceId,
			proposals,
			turns,
		});
	}
	return results;
}
