// @vitest-environment node
/**
 * @file Unit tests — pre-evaluation log ring buffer (pre-eval-logs.ts).
 *
 * Covers: append (id/ts/source stamping), oldest → newest reads, the limit
 * clamp, capacity overflow truncation, and reset isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	appendPreEvalLog,
	getPreEvalLogs,
	resetPreEvalLogs,
	type PreEvalLogEntry,
} from "$lib/server/pre-eval-logs";

function row(overrides: Partial<PreEvalLogEntry> = {}): PreEvalLogEntry {
	return {
		id: 0,
		ts: 0,
		level: "info",
		logger: "pre-eval",
		source: "pre-eval",
		submissionId: "2026SS_01",
		message: 'Pre-evaluated "2026SS_01"',
		grades: { code_quality_design: 4 },
		markerCount: 1,
		selectionCount: 1,
		ok: true,
		...overrides,
	};
}

beforeEach(() => {
	resetPreEvalLogs();
});

afterEach(() => {
	resetPreEvalLogs();
});

describe("pre-eval log ring buffer", () => {
	it("stamps id/ts/source on append and reads back oldest → newest", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_752_000_000_000));
		try {
			const first = appendPreEvalLog(row({ submissionId: "2026SS_01" }));
			expect(first.id).toBe(1);
			expect(first.ts).toBe(1_752_000_000);
			expect(first.source).toBe("pre-eval");

			vi.setSystemTime(new Date(1_752_000_001_000));
			const second = appendPreEvalLog(row({ submissionId: "2026SS_02" }));
			expect(second.id).toBe(2);
			expect(second.ts).toBe(1_752_000_001);
		} finally {
			vi.useRealTimers();
		}

		const { entries, truncated } = getPreEvalLogs();
		expect(truncated).toBe(false);
		expect(entries.map((e) => e.submissionId)).toEqual(["2026SS_01", "2026SS_02"]);
	});

	it("clamps the limit and flags truncation when entries were dropped", () => {
		for (let i = 0; i < 5; i += 1) {
			appendPreEvalLog(row({ submissionId: `S${i}` }));
		}

		const limited = getPreEvalLogs(2);
		expect(limited.truncated).toBe(true);
		expect(limited.entries.map((e) => e.submissionId)).toEqual(["S3", "S4"]);

		// Non-finite limits fall back to the default window (no truncation).
		const fallback = getPreEvalLogs(Number.NaN);
		expect(fallback.entries).toHaveLength(5);
		expect(fallback.truncated).toBe(false);
	});

	it("drops the oldest entries beyond the buffer capacity", () => {
		// Capacity is 500 — overflow must evict the oldest rows.
		for (let i = 0; i < 505; i += 1) {
			appendPreEvalLog(row({ submissionId: `S${i}` }));
		}

		// The buffer itself holds the newest 500; a wide-enough request
		// returns all of them without truncation.
		const all = getPreEvalLogs(1000);
		expect(all.truncated).toBe(false);
		expect(all.entries).toHaveLength(500);
		expect(all.entries[0]!.submissionId).toBe("S5");
		expect(all.entries[all.entries.length - 1]!.submissionId).toBe("S504");

		// A narrower request drops buffered entries and flags truncation.
		const limited = getPreEvalLogs(100);
		expect(limited.truncated).toBe(true);
		expect(limited.entries).toHaveLength(100);
		expect(limited.entries[0]!.submissionId).toBe("S405");
	});

	it("reset clears the buffer between cases", () => {
		appendPreEvalLog(row());
		resetPreEvalLogs();

		const { entries, truncated } = getPreEvalLogs();
		expect(entries).toEqual([]);
		expect(truncated).toBe(false);
	});
});
