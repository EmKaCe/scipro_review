/**
 * @file Types for IndexedDB persistence and file export.
 *
 * @see .github/references/schemas/typescript-schema.md
 */

import type { ReviewSession } from "./session.js";

// ---------------------------------------------------------------------------
// IndexedDB records
// ---------------------------------------------------------------------------

/** A persisted review record in IndexedDB. */
export interface ReviewRecord {
	/** Unique record identifier (auto-generated). */
	readonly id: string;
	/** Academic semester derived from student_id (e.g., "2026SS"). */
	readonly semester: string;
	/** Student identifier. */
	readonly student_id: string;
	/** Assignment key. */
	readonly assignment_id: string;
	/** Review mode. */
	readonly mode: string;
	/** ISO timestamp when the review was started. */
	readonly started_at: string;
	/** ISO timestamp of the last update. */
	readonly updated_at: string;
	/** Full serialized session state. */
	data: ReviewSession;
}

/** Auto-save sentinel record for the current in-progress session. */
export interface CurrentSessionRecord extends Omit<ReviewRecord, "id"> {
	readonly id: "__current__";
}

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------

/** Structure of a bulk export containing all persisted reviews. */
export interface BulkExport {
	/** ISO timestamp when the export was generated. */
	readonly exported_at: string;
	/** All review records. */
	readonly reviews: readonly ReviewRecord[];
}

// ---------------------------------------------------------------------------
// File export
// ---------------------------------------------------------------------------

/** Supported export formats. */
export type ExportFormat = "yaml" | "json" | "md";

/** Options for exporting a single evaluation. */
export interface ExportOptions {
	/** Output format. */
	readonly format: ExportFormat;
	/** Whether to include the generated Markdown text. */
	readonly include_generated_text: boolean;
	/** Whether to pretty-print JSON output. */
	readonly pretty: boolean;
}

// ---------------------------------------------------------------------------
// DB constants
// ---------------------------------------------------------------------------

/** Fixed key for the auto-saved current session. */
export const CURRENT_SESSION_KEY = "__current__" as const;

/** IndexedDB database name. */
export const DB_NAME = "scipro_reviews" as const;

/** IndexedDB schema version. */
export const DB_VERSION = 1 as const;

/** Object store name for review records. */
export const SESSION_STORE = "reviews" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the semester prefix from a student ID (e.g., "2026SS_42" → "2026SS"). */
export function extractSemester(studentId: string): string {
	const match = studentId.match(/^(\d{4}[WS]S)/);
	return match ? match[1] : "unknown";
}

/** Generate a unique ID for a review record. */
export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
