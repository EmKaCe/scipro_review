/**
 * @file Shared grading validation helpers.
 *
 * The save route and the teacher-YAML import service both validate grading
 * payloads; these guards live here so the shapes stay in sync.
 *
 * This module runs only on the SvelteKit server (`$lib/server/`).
 */

/** True when value is a plain object mapping string keys to string values. */
export function isStringMap(value: unknown): value is Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === "string");
}

/** True when value is a plain object mapping string keys to finite numbers. */
export function isNumberMap(value: unknown): value is Record<string, number> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v));
}

/**
 * True when value is an object mapping category keys to v2 CategoryFeedback
 * entries ({ checked: string[], comments: Record<string,string>,
 * deductions: Record<string,number>, notes: string }).
 */
export function isFeedbackMap(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((entry) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return false;
		}
		const e = entry as Record<string, unknown>;
		return (
			Array.isArray(e.checked) &&
			e.checked.every((v) => typeof v === "string") &&
			isStringMap(e.comments) &&
			isNumberMap(e.deductions) &&
			typeof e.notes === "string"
		);
	});
}
