/**
 * @file Shared submission-status display config (labels + icons).
 *
 * Used by the dashboard table and the per-submission page header chip so a
 * submission's status renders identically everywhere.
 */
import type { SubmissionStatus } from "$lib/types/submissions.js";
import Clock from "@lucide/svelte/icons/clock";
import Loader from "@lucide/svelte/icons/loader";
import CircleCheck from "@lucide/svelte/icons/circle-check";
import CircleAlert from "@lucide/svelte/icons/circle-alert";
import Sparkles from "@lucide/svelte/icons/sparkles";
import Star from "@lucide/svelte/icons/star";

export interface StatusDisplay {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	icon: any;
	label: string;
}

/** Status display config (matches OD mockup colors). */
export const statusConfig: Record<SubmissionStatus, StatusDisplay> = {
	pending: { icon: Clock, label: "Pending" },
	executing: { icon: Loader, label: "Executing" },
	executed: { icon: CircleCheck, label: "Executed" },
	error: { icon: CircleAlert, label: "Error" },
	"pre-evaluated": { icon: Sparkles, label: "Pre-evaluated" },
	graded: { icon: Star, label: "Graded" },
};

/** Human-readable label for a status (falls back to "Pending"). */
export function statusLabel(status: SubmissionStatus): string {
	return (statusConfig[status] ?? statusConfig.pending).label;
}
