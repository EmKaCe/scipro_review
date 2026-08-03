/** @file Shared utility functions for grading, formatting, and CSS class merging. */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import type { GradeMapping } from "./types/index.js";

/**
 * Merge Tailwind CSS classes with conflict resolution.
 * Combines `clsx` conditional class joining with `tailwind-merge` deduplication.
 * @param inputs - Class values, arrays, or conditional objects.
 * @returns Merged class string with Tailwind conflicts resolved.
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Remove the `child` property from a type if it exists. */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, "child"> : T;

/** Remove the `children` property from a type if it exists. */
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, "children"> : T;

/** Remove both `children` and `child` properties from a type if they exist. */
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;

/** Add an optional `ref` property for binding to a DOM element. */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

/** German university grading scale mapping percentage thresholds to grade strings. */
const GRADE_MAP: GradeMapping[] = [
	{ min: 95, grade: "1.0", us: "A+" },
	{ min: 90, grade: "1.3", us: "A" },
	{ min: 85, grade: "1.7", us: "A-" },
	{ min: 80, grade: "2.0", us: "B+" },
	{ min: 75, grade: "2.3", us: "B" },
	{ min: 70, grade: "2.7", us: "B-" },
	{ min: 65, grade: "3.0", us: "C+" },
	{ min: 60, grade: "3.3", us: "C" },
	{ min: 55, grade: "3.7", us: "C-" },
	{ min: 50, grade: "4.0", us: "D+" },
	{ min: 45, grade: "4.3", us: "D" },
	{ min: 40, grade: "4.7", us: "D-" },
	{ min: 0, grade: "5.0", us: "F" },
];

/** Step thresholds mapping percentage ranges to grade bar CSS variable names. */
const GRADE_BAR_STEPS = [
	{ max: 4, cssVar: "var(--grade-0)" },
	{ max: 12, cssVar: "var(--grade-8)" },
	{ max: 21, cssVar: "var(--grade-17)" },
	{ max: 29, cssVar: "var(--grade-25)" },
	{ max: 37, cssVar: "var(--grade-33)" },
	{ max: 46, cssVar: "var(--grade-42)" },
	{ max: 54, cssVar: "var(--grade-50)" },
	{ max: 62, cssVar: "var(--grade-58)" },
	{ max: 71, cssVar: "var(--grade-67)" },
	{ max: 79, cssVar: "var(--grade-75)" },
	{ max: 87, cssVar: "var(--grade-83)" },
	{ max: 96, cssVar: "var(--grade-92)" },
	{ max: 100, cssVar: "var(--grade-100)" },
];

/**
 * Map a score percentage to the corresponding grade bar CSS variable.
 * @param pct - Score percentage (0–100).
 * @returns CSS variable name for the grade bar color.
 */
export function getGradeBarColor(pct: number): string {
	const match = GRADE_BAR_STEPS.find((s) => pct <= s.max);
	return match ? match.cssVar : "var(--grade-0)";
}

/**
 * Convert a percentage score to German and US grade equivalents.
 * @param pct - Score percentage (0–100).
 * @returns Object with `grade` (German) and `us` (US letter) grade strings.
 */
export function germanGradeFromPercentage(pct: number): { grade: string; us: string } {
	for (const g of GRADE_MAP) {
		if (pct >= g.min) {
			return { grade: g.grade, us: g.us };
		}
	}
	return { grade: "5.0", us: "F" };
}

/**
 * Check if a score is within 2 points of the next higher grade boundary.
 * @param pct - Score percentage (0–100).
 * @returns Object with `near` flag and optional `target` grade string.
 */
export function isNearGradeBoundary(pct: number): { near: boolean; target?: string } {
	for (const g of GRADE_MAP) {
		if (g.min > pct && g.min - pct <= 2) {
			return { near: true, target: `${g.grade} / ${g.us}` };
		}
	}
	return { near: false };
}

/**
 * Format a byte count as a human-readable file size string.
 * @param bytes - The file size in bytes.
 * @returns Formatted string (e.g. "1.5 MB", "256 B").
 */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Generate a sanitized filename for an exported evaluation file.
 * @param studentId - The student identifier.
 * @param assignment - The assignment name (will be sanitized to lowercase snake_case).
 * @param format - The export file format ("yaml" or "md").
 * @returns The generated filename (e.g. "2026SS_42_atom_interaction_eval.yaml").
 */
export function generateFilename(
	studentId: string,
	assignment: string,
	format: "yaml" | "md" | "json",
): string {
	const sanitized = assignment
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+$/, "");
	const extensions: Record<string, string> = { yaml: "yaml", md: "md", json: "json" };
	return `${studentId}_${sanitized}_eval.${extensions[format] ?? "md"}`;
}
