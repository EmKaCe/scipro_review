/**
 * @file Public entry point for the submissions data layer (Phase 3f.1).
 *
 * Phase 2 shipped hardcoded mock data in this module; the implementation now
 * lives in submissions-store.svelte.ts (rune store backed by
 * submissions-api.ts). This file keeps the historical import surface
 * ($lib/services/submissions-store.js) working — listSubmissions and
 * getSubmission are sync snapshots of the live store, so existing call sites
 * compile unchanged until they are wired to the store (3f.2/3f.3).
 *
 * There is no stub data anymore.
 */

export {
	POLL_INTERVAL_MS,
	submissionsStore,
	listSubmissions,
	getSubmission,
} from "./submissions-store.svelte.js";

export type { SubmissionsLoadStatus } from "./submissions-store.svelte.js";
