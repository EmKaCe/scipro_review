/**
 * @file Read-only first-run onboarding status computation.
 *
 * Drives GET /api/onboarding/status (the T6 setup checklist). Every check
 * is a cheap filesystem / in-process read — this module NEVER creates,
 * writes, or mutates anything. The guided "wizard" flow is deliberately
 * deferred; this surface only reports current state.
 *
 * Checks:
 *   1. create-assignment — ≥1 enabled assignment in data/assignments.yaml.
 *   2. wire-scoring      — the first enabled assignment has non-empty
 *                          criteria_files AND a scoring config (its
 *                          `scoring_file` field, or data/scoring/<id>.yaml
 *                          existing on disk via getScoringConfigPath).
 *                          `detail` carries the first enabled assignment id
 *                          so the page can deep-link to its criteria editor.
 *   3. llm-provider      — hasApiKey() from the in-process key store. An
 *                          env-configured or runtime-set key both count; the
 *                          key itself is never exposed.
 *   4. docs-index        — docs-index.json exists at DOCS_INDEX_DIR (env) or
 *                          <DATA_DIR>/docs-index/. Existence check only — the
 *                          corpus is never loaded or parsed here.
 *   5. first-pipeline    — ≥1 <DATA_DIR>/submissions/<assignment>/results.json exists.
 *                          Cheap glob via readdir; on error returns done:null
 *                          with guidance instead of failing the whole page.
 */

import { readdir, access } from "node:fs/promises";
import path from "node:path";

import { getEnabledAssignments } from "$lib/server/assignments";
import { hasApiKey } from "$lib/server/api-key-store";
import { getScoringConfigPath } from "$lib/server/copilot/scoring-config";
import { getDataDir } from "$lib/server/metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One checklist item. `done` is true/false, or null when undeterminable. */
export interface OnboardingItem {
	id: string;
	done: boolean | null;
	/** Optional machine-readable / guidance detail (see doc comment). */
	detail?: string;
}

export interface OnboardingStatus {
	items: OnboardingItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOCS_INDEX_FILENAME = "docs-index.json";

/** Resolve docs-index.json path, mirroring docs-rag.getIndexPath() resolution. */
function getDocsIndexPath(): string {
	if (process.env.DOCS_INDEX_DIR) {
		return path.join(process.env.DOCS_INDEX_DIR, DOCS_INDEX_FILENAME);
	}
	return path.join(getDataDir(), "docs-index", DOCS_INDEX_FILENAME);
}

/** Cheap existence check — resolves true only when the path is readable. */
async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * first-pipeline: at least one results.json under <DATA_DIR>/submissions/*.
 * Returns done:null (with guidance) when the directory cannot be inspected
 * rather than tearing down the whole checklist.
 */
async function computeFirstPipeline(): Promise<Pick<OnboardingItem, "done" | "detail">> {
	const base = path.join(getDataDir(), "submissions");
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			// No submissions directory yet — nothing has been uploaded.
			return { done: false };
		}
		return {
			done: null,
			detail: "Could not inspect the submissions directory.",
		};
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const resultsPath = path.join(base, entry.name, "results.json");
		if (await pathExists(resultsPath)) {
			return { done: true };
		}
	}
	return { done: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compute the full first-run onboarding status. Never writes anything. */
export async function getOnboardingStatus(): Promise<OnboardingStatus> {
	const enabled = await getEnabledAssignments();
	const first = enabled[0] ?? null;

	// 1. create-assignment — at least one enabled assignment exists.
	const createAssignment: OnboardingItem = {
		id: "create-assignment",
		done: enabled.length > 0,
	};

	// 2. wire-scoring — first enabled assignment is fully wired.
	let wireScoring: OnboardingItem;
	if (!first) {
		wireScoring = {
			id: "wire-scoring",
			done: null,
			detail: "Create an assignment first.",
		};
	} else {
		const hasCriteria = first.criteria_files.length > 0;
		const hasOwnScoringFile =
			first.scoring_file !== undefined && first.scoring_file.trim().length > 0;
		const hasScoringOnDisk = await pathExists(getScoringConfigPath(first.id));
		wireScoring = {
			id: "wire-scoring",
			done: hasCriteria && (hasOwnScoringFile || hasScoringOnDisk),
			// Carry the first enabled assignment id so the page can deep-link
			// straight into its criteria editor.
			detail: first.id,
		};
	}

	// 3. llm-provider — in-process API key configured (env or runtime-set).
	const llmProvider: OnboardingItem = {
		id: "llm-provider",
		done: hasApiKey(),
	};

	// 4. docs-index — docs-index.json present (existence only).
	const docsIndex: OnboardingItem = {
		id: "docs-index",
		done: await pathExists(getDocsIndexPath()),
	};

	// 5. first-pipeline — ≥1 results.json exists under submissions/*.
	const pipeline = await computeFirstPipeline();
	const firstPipeline: OnboardingItem = {
		id: "first-pipeline",
		done: pipeline.done,
		...(pipeline.detail ? { detail: pipeline.detail } : {}),
	};

	return {
		items: [createAssignment, wireScoring, llmProvider, docsIndex, firstPipeline],
	};
}
