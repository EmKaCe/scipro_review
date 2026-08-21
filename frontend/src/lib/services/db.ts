/**
 * @file IndexedDB persistence layer — CRUD operations for review records.
 *
 * Uses the `idb` package for type-safe IndexedDB access.
 * Handles Svelte 5 proxy objects by deep-cloning before IDB writes.
 *
 * @see .github/references/schemas/typescript-schema.md (persistence.ts)
 */

import { openDB as idbOpenDB, type IDBPDatabase, type DBSchema } from "idb";
import type { ReviewSession } from "../types/session.js";
import type { ReviewRecord, CurrentSessionRecord } from "../types/persistence.js";
import type { GradingConfig } from "../types/grading.js";
import { calculateGrade } from "../services/grade-calculator.js";
import { jsonSerialize } from "../utils/json-serialize.js";
import {
	CURRENT_SESSION_KEY,
	DB_NAME,
	DB_VERSION,
	SESSION_STORE,
	extractSemester,
	generateId,
} from "../types/persistence.js";

// ---------------------------------------------------------------------------
// Database schema
// ---------------------------------------------------------------------------

/** IndexedDB schema definition for the scipro_reviews database. */
interface SciproDB extends DBSchema {
	reviews: {
		key: string;
		value: ReviewRecord;
		indexes: {
			semester: string;
			student_id: string;
			updated_at: string;
		};
	};
}

// ---------------------------------------------------------------------------
// Serialize / deserialize helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a ReviewSession for IndexedDB storage.
 *
 * Converts Set → Array for JSON compatibility.
 */
function serializeSession(session: ReviewSession): Record<string, unknown> {
	return jsonSerialize(session) as unknown as Record<string, unknown>;
}

/**
 * Deserialize a ReviewSession from IndexedDB storage.
 *
 * Converts Array → Set for runtime use.
 */
function deserializeSession(data: Record<string, unknown>): ReviewSession {
	const session = { ...data } as unknown as ReviewSession;

	// Convert category_selections from arrays back to Sets
	if (session.category_selections && typeof session.category_selections === "object") {
		const selections = session.category_selections as unknown as Record<
			string,
			Record<string, unknown>
		>;
		for (const key of Object.keys(selections)) {
			const catSel = selections[key];
			if (catSel.checked_items && Array.isArray(catSel.checked_items)) {
				catSel.checked_items = new Set(catSel.checked_items as string[]);
			}
		}
	}

	return session;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/** Open (or create) the IndexedDB database. */
async function openDB(): Promise<IDBPDatabase<SciproDB>> {
	return idbOpenDB(DB_NAME, DB_VERSION, {
		upgrade(db) {
			const store = db.createObjectStore(SESSION_STORE, { keyPath: "id" });
			store.createIndex("semester", "semester", { unique: false });
			store.createIndex("student_id", "student_id", { unique: false });
			store.createIndex("updated_at", "updated_at", { unique: false });
		},
	});
}

// ---------------------------------------------------------------------------
// Auto-save (current session)
// ---------------------------------------------------------------------------

/**
 * Auto-save the current in-progress session to IndexedDB.
 *
 * Uses the `__current__` sentinel key. Overwrites any previous auto-save.
 */
export async function saveCurrentSession(session: ReviewSession): Promise<void> {
	const db = await openDB();
	const record: Omit<CurrentSessionRecord, "id"> & { id: "__current__" } = {
		id: CURRENT_SESSION_KEY,
		semester: extractSemester(session.student_id),
		student_id: session.student_id,
		assignment_id: session.assignment_id,
		mode: session.mode,
		started_at: session.started_at,
		updated_at: session.updated_at,
		data: serializeSession(session) as unknown as ReviewSession,
	};
	await db.put(SESSION_STORE, record);
}

/**
 * Load the auto-saved current session from IndexedDB.
 *
 * @returns The saved session, or null if none exists
 */
export async function loadCurrentSession(): Promise<ReviewSession | null> {
	const db = await openDB();
	const record = await db.get(SESSION_STORE, CURRENT_SESSION_KEY);
	if (!record) return null;
	return deserializeSession(record.data as unknown as Record<string, unknown>);
}

/** Clear the auto-saved current session from IndexedDB. */
export async function clearCurrentSession(): Promise<void> {
	const db = await openDB();
	await db.delete(SESSION_STORE, CURRENT_SESSION_KEY);
}

// ---------------------------------------------------------------------------
// Review CRUD
// ---------------------------------------------------------------------------

/**
 * Save a completed review to IndexedDB.
 *
 * @param session - The review session to save
 * @param existingId - Optional existing ID for updates
 * @returns The ID of the saved record
 */
export async function saveReview(session: ReviewSession, existingId?: string): Promise<string> {
	const db = await openDB();
	const id = existingId ?? generateId();
	const now = new Date().toISOString();

	const record: ReviewRecord = {
		id,
		semester: extractSemester(session.student_id),
		student_id: session.student_id,
		assignment_id: session.assignment_id,
		mode: session.mode,
		started_at: session.started_at,
		updated_at: now,
		data: serializeSession(session) as unknown as ReviewSession,
	};

	await db.put(SESSION_STORE, record);
	return id;
}

/**
 * Load a review by ID from IndexedDB.
 *
 * @param id - The review record ID
 * @returns The review session, or null if not found
 */
export async function loadReview(id: string): Promise<ReviewSession | null> {
	const db = await openDB();
	const record = await db.get(SESSION_STORE, id);
	if (!record) return null;
	return deserializeSession(record.data as unknown as Record<string, unknown>);
}

/**
 * Delete a review by ID from IndexedDB.
 *
 * @param id - The review record ID
 * @returns True if the review was deleted, false if not found
 */
export async function deleteReview(id: string): Promise<boolean> {
	const db = await openDB();
	const existing = await db.get(SESSION_STORE, id);
	if (!existing) return false;
	await db.delete(SESSION_STORE, id);
	return true;
}

// ---------------------------------------------------------------------------
// Review listing
// ---------------------------------------------------------------------------

/** Metadata for a review in the listing. */
export interface ReviewMeta {
	id: string;
	semester: string;
	student_id: string;
	assignment_id: string;
	mode: string;
	started_at: string;
	updated_at: string;
}

/** Full review metadata including computed progress and grade. */
export interface ReviewMetaFull extends ReviewMeta {
	progress: number;
	grade: number;
	label: string;
	us_equiv: string;
}

/**
 * List all saved reviews, optionally filtered by semester.
 *
 * Excludes the `__current__` sentinel record.
 *
 * @param semester - Optional semester filter (e.g., "2026SS")
 * @param gradingConfig - Optional grading config to compute actual grades
 * @returns Array of review metadata, sorted by updated_at descending
 */
export async function listReviews(
	semester?: string,
	gradingConfig?: GradingConfig,
): Promise<ReviewMetaFull[]> {
	const db = await openDB();
	let cursor = await db.transaction(SESSION_STORE).store.openCursor();

	const reviews: ReviewMetaFull[] = [];

	while (cursor) {
		const record = cursor.value;
		// Skip the auto-save sentinel
		if (record.id !== CURRENT_SESSION_KEY) {
			// Apply semester filter if provided
			if (!semester || record.semester === semester) {
				const session = deserializeSession(
					record.data as unknown as Record<string, unknown>,
				);
				let grade = 0;
				let label = "";
				let us_equiv = "";
				if (gradingConfig && Object.keys(session.grading).length > 0) {
					try {
						const result = calculateGrade(session.grading, gradingConfig);
						grade = result.grade;
						label = result.label;
						us_equiv = result.us_equiv;
					} catch {
						// Fallback to placeholder if calculation fails
					}
				}
				reviews.push({
					id: record.id,
					semester: record.semester,
					student_id: record.student_id,
					assignment_id: record.assignment_id,
					mode: record.mode,
					started_at: record.started_at,
					updated_at: record.updated_at,
					progress: computeProgress(session),
					grade,
					label,
					us_equiv,
				});
			}
		}
		cursor = await cursor.continue();
	}

	// Sort by updated_at descending
	reviews.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
	return reviews;
}

/**
 * List distinct semesters from saved reviews.
 *
 * @returns Array of semester strings (e.g., ["2026SS", "2025WS"])
 */
export async function listSemesters(): Promise<string[]> {
	const db = await openDB();
	const index = db.transaction(SESSION_STORE).store.index("semester");
	const semesters = new Set<string>();

	let cursor = await index.openCursor();
	while (cursor) {
		semesters.add(cursor.value.semester);
		cursor = await cursor.continue();
	}

	return [...semesters].sort().reverse();
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/** Structure of a bulk export containing all persisted reviews. */
export interface DbExport {
	exported_at: string;
	reviews: ReviewRecord[];
}

/**
 * Export all reviews as a JSON-serializable object.
 *
 * @returns Bulk export data
 */
export async function exportAll(): Promise<DbExport> {
	const db = await openDB();
	const allRecords = await db.getAll(SESSION_STORE);
	// Filter out the auto-save sentinel
	const reviews = allRecords.filter((r) => r.id !== CURRENT_SESSION_KEY);
	return {
		exported_at: new Date().toISOString(),
		reviews,
	};
}

/**
 * Import reviews from a bulk export object.
 *
 * @param data - Bulk export data
 * @returns Object with imported and skipped counts
 */
export async function importAll(data: DbExport): Promise<{ imported: number; skipped: number }> {
	const db = await openDB();
	let imported = 0;
	let skipped = 0;

	for (const record of data.reviews) {
		try {
			await db.put(SESSION_STORE, record);
			imported++;
		} catch {
			skipped++;
		}
	}

	return { imported, skipped };
}

/**
 * Clear all reviews from IndexedDB, including the auto-save sentinel.
 */
export async function clearAllReviews(): Promise<void> {
	const db = await openDB();
	await db.clear(SESSION_STORE);
}

// ---------------------------------------------------------------------------
// Progress computation
// ---------------------------------------------------------------------------

/**
 * Compute the progress percentage for a review session.
 *
 * Counts the percentage of categories that have at least one checked item
 * or non-empty notes.
 */
function computeProgress(session: ReviewSession): number {
	const selections = session.category_selections;
	if (!selections || typeof selections !== "object") return 0;

	const selectionEntries = Object.entries(selections as Record<string, unknown>);
	if (selectionEntries.length === 0) return 0;

	let filled = 0;
	for (const [, rawSel] of selectionEntries) {
		const catSel = rawSel as Record<string, unknown>;
		if (!catSel) continue;

		const checkedItems = catSel.checked_items;
		const notes = catSel.notes;

		const hasChecked =
			(checkedItems instanceof Set && checkedItems.size > 0) ||
			(Array.isArray(checkedItems) && checkedItems.length > 0);
		const hasNotes = typeof notes === "string" && notes.trim().length > 0;

		if (hasChecked || hasNotes) {
			filled++;
		}
	}

	return Math.round((filled / selectionEntries.length) * 100);
}
