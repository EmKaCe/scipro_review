/**
 * @file GET/PUT /api/assignments/[id]/scoring — per-assignment scoring
 * config editor (calibration anchors, evidence regexes, disallowed
 * libraries, Phase 2a dimension guidance).
 *
 * Mirrors the criteria API (GET/PUT /api/assignments/[id]/criteria):
 *   GET  — load the assignment's scoring document (the raw map under the
 *          `scoring:` key), or null when no file exists on disk.
 *   PUT  — validate via the compile gate (compileScoringConfig), write
 *          atomically to <DATA_DIR>/scoring/<id>.yaml, and wire
 *          `scoring_file` into the registry on first save.
 *
 * The compile gate is the contract: a bad regex, unknown semantics enum,
 * partial reference_anchors, or out-of-range r_squared surfaces as a 400
 * with the compile error message — never silent degradation.
 *
 * Responses:
 *   GET  200 { fileName: string | null, content: ScoringConfigDocument | null }
 *   PUT  200 { fileName, content }  (content = the validated body.scoring)
 *   PUT  400 — invalid body, or the compile gate rejected the document
 *   GET/PUT 404 — unknown assignment id
 *   PUT  500 — unexpected write failure
 *
 * Environment: DATA_DIR (default ./data). Server-only ($lib/server deps).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import * as yaml from "js-yaml";

import { getAssignmentById } from "$lib/server/assignments";
import { AssignmentWriteError, updateAssignment } from "$lib/server/assignments-writer";
import { compileScoringConfig } from "$lib/server/copilot/scoring-config";
import { getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The raw document shape under the `scoring:` key — the same shape
 * compileScoringConfig consumes and the editor edits.
 */
export interface ScoringConfigDocument {
	reference_anchors?: Record<string, number>;
	evidence_patterns?: Record<
		string,
		{
			pattern: string | string[];
			semantics: "test" | "test_all" | "capture_value" | "distinct_count";
			haystack: "output" | "code" | "markdown" | "output+code" | "markdown+code";
			capture_group?: number;
		}
	>;
	disallowed_libraries?: string[];
	prompt_anchor_text?: {
		dimension_guidance?: Record<string, string>;
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep structural equality for two scoring maps.
 *
 * Used by the PUT no-op guard: the client round-trips the document through
 * JSON/YAML, so key order can differ while the document is semantically the
 * same. Compare values only, ignoring key order in objects.
 */
function deepEqualScoring(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqualScoring(item, b[i]));
	}
	if (typeof a === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const aKeys = Object.keys(aObj);
		const bKeys = Object.keys(bObj);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((key) => deepEqualScoring(aObj[key], bObj[key]));
	}
	return a === b;
}

/**
 * Read the raw scoring document for a file path, or null when the file does
 * not exist on disk. Throws when the file exists but is not valid YAML or
 * lacks the `scoring` map — a server misconfig should surface as a 500, not
 * a silent empty editor.
 */
async function loadScoringDocument(fileName: string): Promise<ScoringConfigDocument | null> {
	const absPath = path.join(getDataDir(), fileName.replace(/^data\//, ""));
	let raw: string;
	try {
		raw = await readFile(absPath, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") {
			return null;
		}
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		throw new Error(`${fileName} is not valid YAML: ${(err as Error).message}`, {
			cause: err,
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${fileName} is invalid: expected a 'scoring' map`);
	}
	const root = parsed as { scoring?: unknown };
	if (!root.scoring || typeof root.scoring !== "object" || Array.isArray(root.scoring)) {
		throw new Error(`${fileName} is invalid: missing 'scoring' map`);
	}
	return root.scoring as ScoringConfigDocument;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

// ---------------------------------------------------------------------------
// GET / PUT — scoring config editor
// ---------------------------------------------------------------------------

/** GET /api/assignments/[id]/scoring — load the assignment's scoring config. */
export async function GET(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";

	const assignment = await getAssignmentById(id);
	if (!assignment) {
		throw error(404, `Assignment "${id}" not found`);
	}

	// The assignment's scoring_file, or the loader's default path when absent
	// (getScoringConfigPath — the file the pipeline reads).
	const fileName = assignment.scoring_file ?? `data/scoring/${id}.yaml`;

	// Missing file on disk → treat as none (the editor starts empty).
	const content = await loadScoringDocument(fileName);
	if (!content) {
		return json({ fileName, content: null });
	}
	return json({ fileName, content });
}

/** PUT /api/assignments/[id]/scoring — replace the assignment's scoring config. */
export async function PUT(event: RequestEvent): Promise<Response> {
	const id = event.params.id ?? "";

	// The assignment must exist (checked before persisting anything so a bad
	// id leaves no file or registry change).
	const existing = await getAssignmentById(id);
	if (!existing) {
		throw error(404, `Assignment "${id}" not found`);
	}

	let body: { scoring?: Record<string, unknown> };
	try {
		body = (await event.request.json()) as { scoring?: Record<string, unknown> };
	} catch {
		throw error(400, "Expected a JSON body");
	}
	if (
		!body ||
		typeof body !== "object" ||
		!body.scoring ||
		typeof body.scoring !== "object" ||
		Array.isArray(body.scoring)
	) {
		throw error(400, "Expected a JSON body with a 'scoring' map");
	}

	// Compile gate (the DoD contract): validates regexes, semantics enum,
	// haystack enum, capture_group bounds, anchors all-or-nothing, and
	// r_squared ∈ [0,1]. A rejected document → 400 with the compile message.
	try {
		compileScoringConfig(id, body.scoring);
	} catch (err) {
		throw error(400, (err as Error).message);
	}

	// Serialize the document the pipeline reads (yaml.dump({ scoring: ... })).
	const yamlText = yaml.dump({ scoring: body.scoring });

	// Target file: the assignment's scoring_file, or a new
	// data/scoring/<id>.yaml when the assignment has none.
	const fileName = existing.scoring_file ?? `data/scoring/${id}.yaml`;
	const isNewFile = !existing.scoring_file;

	// No-op guard: when the saved document is semantically identical to what
	// is already on disk, skip the write entirely. The YAML dump reformats
	// (indentation, folding), so a no-op save must NOT churn the tracked
	// git file — otherwise every "Save" click produces a fake diff.
	if (!isNewFile) {
		const existingOnDisk = await loadScoringDocument(fileName);
		if (existingOnDisk && deepEqualScoring(existingOnDisk, body.scoring)) {
			return json({ fileName, content: body.scoring });
		}
	}

	// Atomic write: temp file in the same directory + rename.
	try {
		const scoringDir = path.join(getDataDir(), "scoring");
		await mkdir(scoringDir, { recursive: true });
		const basename = path.basename(fileName);
		const tmpPath = path.join(scoringDir, `.${basename}.tmp-${process.pid}-${Date.now()}`);
		await writeFile(tmpPath, yamlText, "utf-8");
		await rename(tmpPath, path.join(scoringDir, basename));
	} catch (err) {
		throw error(500, `Failed to write scoring file: ${(err as Error).message}`);
	}

	// A brand-new file must be registered in the assignment's scoring_file
	// (dedupe in case the entry somehow already exists).
	if (isNewFile) {
		try {
			await updateAssignment(id, { scoring_file: fileName });
		} catch (err) {
			if (err instanceof AssignmentWriteError) {
				throw error(err.status, err.message);
			}
			throw error(500, (err as Error).message);
		}
	}

	return json({ fileName, content: body.scoring });
}
