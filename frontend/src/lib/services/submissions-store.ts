/**
 * @file Public entry point for the submissions data layer — re-exports the
 * rune store and its sync snapshot helpers.
 */

export {
	POLL_INTERVAL_MS,
	submissionsStore,
	listSubmissions,
	getSubmission,
} from "./submissions-store.svelte.js";

export type { SubmissionsLoadStatus } from "./submissions-store.svelte.js";
