import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

import LocalDataCard from "$lib/components/settings/local-data-card.svelte";
import * as db from "$lib/services/db.js";
import * as persistence from "$lib/services/session-persistence.js";

vi.mock("$lib/services/db.js", async (importOriginal) => {
	const actual = await importOriginal<typeof db>();
	return {
		...actual,
		listReviews: vi.fn().mockResolvedValue([]),
		listSemesters: vi.fn().mockResolvedValue([]),
		exportAll: vi.fn().mockResolvedValue({
			exported_at: "2026-08-21T00:00:00.000Z",
			reviews: [{ id: "r1", student_id: "2026SS_00" }],
		}),
		importAll: vi.fn().mockResolvedValue({ imported: 1, skipped: 0 }),
		clearAllReviews: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("$lib/services/session-persistence.js", async (importOriginal) => {
	const actual = await importOriginal<typeof persistence>();
	return {
		...actual,
		downloadFile: vi.fn(),
	};
});

describe("LocalDataCard (student/static settings)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(db.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(db.listSemesters as ReturnType<typeof vi.fn>).mockResolvedValue([]);
	});

	it("renders a summary of locally stored reviews", async () => {
		(db.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a" } as db.ReviewMetaFull,
			{ id: "b" } as db.ReviewMetaFull,
		]);
		(db.listSemesters as ReturnType<typeof vi.fn>).mockResolvedValue(["2026SS", "2025WS"]);

		render(LocalDataCard);

		await waitFor(() => expect(screen.getByText(/2 review\(s\)/)).toBeTruthy());
		expect(screen.getByText(/2026SS, 2025WS/)).toBeTruthy();
	});

	it("backs up all reviews as a JSON download", async () => {
		render(LocalDataCard);

		await waitFor(() => expect(screen.getByRole("button", { name: /Back up/ })).toBeTruthy());
		await fireEvent.click(screen.getByRole("button", { name: /Back up/ }));

		await waitFor(() => expect(db.exportAll).toHaveBeenCalled());
		await waitFor(() =>
			expect(persistence.downloadFile).toHaveBeenCalledWith(
				expect.stringContaining('"reviews"'),
				expect.stringMatching(/^scipro-reviews-\d{4}-\d{2}-\d{2}\.json$/),
				"application/json",
			),
		);
	});

	it("clears all reviews only after the confirm step", async () => {
		render(LocalDataCard);

		await waitFor(() => expect(screen.getByRole("button", { name: /Clear all/ })).toBeTruthy());
		await fireEvent.click(screen.getByRole("button", { name: /Clear all/ }));

		expect(await screen.findByRole("button", { name: /Really clear/ })).toBeTruthy();
		expect(db.clearAllReviews).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole("button", { name: /Really clear/ }));
		await waitFor(() => expect(db.clearAllReviews).toHaveBeenCalled());
	});
});
