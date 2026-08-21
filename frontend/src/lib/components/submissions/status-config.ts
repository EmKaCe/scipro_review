/**
 * @file Shared submission-status display config (labels + icons).
 *
 * Used by the dashboard table and the per-submission page header chip so a
 * submission's status renders identically everywhere.
 */
import type { SubmissionStatus } from "$lib/types/submissions.js";
import type { LucideIcon } from "@lucide/svelte";
import Archive from "@lucide/svelte/icons/archive";
import CircleAlert from "@lucide/svelte/icons/circle-alert";
import CircleCheck from "@lucide/svelte/icons/circle-check";
import Clock from "@lucide/svelte/icons/clock";
import Loader from "@lucide/svelte/icons/loader";
import Sparkles from "@lucide/svelte/icons/sparkles";
import Star from "@lucide/svelte/icons/star";

export interface StatusDisplay {
	/** Lucide icon component rendered in the badge. */
	icon: LucideIcon;
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
	archived: { icon: Archive, label: "Archived" },
};

/** Human-readable label for a status (falls back to "Pending"). */
export function statusLabel(status: SubmissionStatus): string {
	return (statusConfig[status] ?? statusConfig.pending).label;
}
