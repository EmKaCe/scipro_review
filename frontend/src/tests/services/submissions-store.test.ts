import { describe, it, expect } from "vitest";
import { listSubmissions, getSubmission } from "$lib/services/submissions-store.js";

describe("submissions-store (stub)", () => {
	it("returns 5 stub submissions", () => {
		const subs = listSubmissions();
		expect(subs).toHaveLength(5);
	});

	it("returns valid detail for a known submission", () => {
		const detail = getSubmission("1");
		expect(detail).not.toBeNull();
		expect(detail!.studentId).toBe("2026SS_03");
		expect(detail!.cells).toHaveLength(6);
	});

	it("returns null for an unknown submission", () => {
		const detail = getSubmission("999");
		expect(detail).toBeNull();
	});

	it("returns an error-status submission with correct marker", () => {
		const detail = getSubmission("3");
		expect(detail).not.toBeNull();
		expect(detail!.cells.some((c) => c.marker === "error")).toBe(true);
		expect(detail!.cells.some((c) => c.marker === "questionable")).toBe(true);
	});
});
