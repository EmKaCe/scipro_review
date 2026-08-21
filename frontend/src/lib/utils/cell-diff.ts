/**
 * @file Deterministic per-cell diff between the original and auto-fixed
 * execution of a notebook cell (the "delta view" of the non-destructive
 * autofix design).
 *
 * Deliberately simple: line-zip by index — the LLM replaces whole cells, so
 * the teacher only needs to see which lines changed plus the error/output
 * before/after. No Myers diff, no fuzzy matching. The "marking" of what
 * changed is computed metadata, never LLM prose.
 */
import type { CellInfo } from "$lib/types/submissions";

/** One changed line pair (old → new), zipped by line index. */
export interface LineChange {
	oldLine: string;
	newLine: string;
}

/** Full delta for one cell: changed lines + execution state before/after. */
export interface CellDelta {
	changedLines: LineChange[];
	errorBefore: string | null;
	errorAfter: string | null;
	outputBefore: string;
	outputAfter: string;
}

/**
 * Zip two sources by line; return every line pair that differs. The shorter
 * side is padded with empty lines so additions/removals surface as pairs.
 */
export function diffLines(original: string, fixed: string): LineChange[] {
	const before = original.split("\n");
	const after = fixed.split("\n");
	const length = Math.max(before.length, after.length);
	const changes: LineChange[] = [];
	for (let i = 0; i < length; i++) {
		const oldLine = before[i] ?? "";
		const newLine = after[i] ?? "";
		if (oldLine !== newLine) {
			changes.push({ oldLine, newLine });
		}
	}
	return changes;
}

/** Build the delta between a cell's original and fixed execution. */
export function cellDelta(original: CellInfo, fixed: CellInfo): CellDelta {
	return {
		changedLines: diffLines(original.source, fixed.source),
		errorBefore: original.error ?? null,
		errorAfter: fixed.error ?? null,
		outputBefore: original.output ?? "",
		outputAfter: fixed.output ?? "",
	};
}
