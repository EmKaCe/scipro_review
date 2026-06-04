/** @file Reactive application settings store using Svelte 5 runes. */
import type { ThemeMode, ReviewMode } from "../types/index.js";

const STORAGE_KEY = "scipro-settings";

function loadSettings(): {
	theme: ThemeMode;
	mode: ReviewMode;
	autoSave: boolean;
	reviewerName: string;
} {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed.theme && parsed.mode && typeof parsed.autoSave === "boolean") {
				return {
					theme: parsed.theme,
					mode: parsed.mode,
					autoSave: parsed.autoSave,
					reviewerName: parsed.reviewerName ?? "",
				};
			}
		}
	} catch {
		// ignore parse errors
	}
	return {
		theme: "system",
		mode: "student",
		autoSave: true,
		reviewerName: "",
	};
}

/**
 * Global reactive application settings.
 * Persists theme, review mode, and auto-save preference.
 */
export const settings = $state<{
	/** Current theme preference. */
	theme: ThemeMode;
	/** Default review display mode. */
	mode: ReviewMode;
	/** Whether reviews are automatically saved on changes. */
	autoSave: boolean;
	/** Reviewer name for evaluation output. */
	reviewerName: string;
}>(loadSettings());

/** Sync settings to localStorage. Call from a component $effect. */
export function syncSettingsToStorage(): void {
	const payload = JSON.stringify({
		theme: settings.theme,
		mode: settings.mode,
		autoSave: settings.autoSave,
		reviewerName: settings.reviewerName,
	});
	localStorage.setItem(STORAGE_KEY, payload);
}

/** Returns the current theme preference. */
export function getTheme(): ThemeMode {
	return settings.theme;
}

/**
 * Set the theme preference.
 * @param theme - The new theme mode.
 */
export function setTheme(theme: ThemeMode): void {
	settings.theme = theme;
}

/** Returns the current review display mode. */
export function getMode(): ReviewMode {
	return settings.mode;
}

/**
 * Set the review display mode.
 * @param mode - The new review mode.
 */
export function setMode(mode: ReviewMode): void {
	settings.mode = mode;
}

/**
 * Set the reviewer name.
 * @param name - The reviewer name for evaluation output.
 */
export function setReviewerName(name: string): void {
	settings.reviewerName = name;
}
