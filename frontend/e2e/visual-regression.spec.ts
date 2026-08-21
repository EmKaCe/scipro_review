/// <reference types="node" />
/**
 * Visual-regression baselines for the SciPro Review teacher app.
 *
 * Screenshots:
 *   - /submissions dashboard (light + dark)
 *   - /submissions/2026SS_910 submission detail (light + dark)
 *
 * Baselines land in e2e/visual-regression.spec.ts-snapshots/ and ARE
 * committed. Platform constraint: baselines are generated and verified on
 * Linux only — other platforms skip (see guard below).
 *
 * Setup runs through the REAL API (upload + batch process) so the screens
 * show settled executed/error rows and rendered cells, not skeletons.
 *
 * Run: cd frontend && npx playwright test e2e/visual-regression.spec.ts
 */
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSIGNMENT = "soil_contamination";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const ROWS = ["2026SS_910", "2026SS_911"];

test.describe("visual regression (Linux baselines)", () => {
	// Linux-only constraint: the committed PNG baselines were generated on
	// this platform; font rendering/anti-aliasing differ elsewhere.
	test.skip(process.platform !== "linux", "baselines committed for Linux only");
	test.beforeAll(async ({ request }) => {
		// Seed through the real API so the exact code path the UI uses is
		// exercised (upload → process), then wait for settlement.
		// NOTE: one file per request — Playwright's multipart with a `files`
		// ARRAY crashes on this Node version ("stream4.on is not a function");
		// a single FilePayload object works.
		for (const nb of ["2026SS_910.ipynb", "2026SS_911.ipynb"]) {
			const res = await request.post("/api/submissions/upload", {
				multipart: {
					assignmentId: ASSIGNMENT,
					files: {
						name: nb,
						mimeType: "application/json",
						buffer: await readFile(path.join(FIXTURES, nb)),
					},
				},
			});
			expect(res.ok()).toBeTruthy();
		}
		const processRes = await request.post("/api/submissions/process", {
			data: { assignmentId: ASSIGNMENT, ids: ROWS },
		});
		expect(processRes.ok()).toBeTruthy();

		await expect
			.poll(
				async () => {
					const res = await request.get(`/api/submissions?assignment=${ASSIGNMENT}`);
					const body = (await res.json()) as {
						submissions: { studentId: string; status: string }[];
					};
					const byId = Object.fromEntries(
						body.submissions.map((s) => [s.studentId, s.status]),
					);
					return [byId["2026SS_910"], byId["2026SS_911"]];
				},
				{ timeout: 120_000, message: "visual spec: process should settle" },
			)
			.toEqual(["executed", "executed"]);
	});

	test("dashboard — light", async ({ page }) => {
		await page.goto("/submissions");
		// Wait for the settled rows (status + cell summary), not skeletons.
		// Scope to the submissions table — the upload panel has its own rows.
		const rows = page.locator(".submissions-table tbody tr");
		await expect(rows).toHaveCount(2, { timeout: 15_000 });
		await expect(rows.filter({ hasText: "2026SS_910" })).toContainText("Executed");
		await expect(rows.filter({ hasText: "2026SS_911" })).toContainText("3 cells, 1 error");
		await expect(page).toHaveScreenshot("dashboard-light.png", {
			maxDiffPixelRatio: 0.01,
		});
	});

	test("dashboard — dark", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto("/submissions");
		const rows = page.locator(".submissions-table tbody tr");
		await expect(rows).toHaveCount(2, { timeout: 15_000 });
		await expect(rows.filter({ hasText: "2026SS_910" })).toContainText("Executed");
		await expect(rows.filter({ hasText: "2026SS_911" })).toContainText("3 cells, 1 error");
		await expect(page.locator("html")).toHaveClass(/dark/);
		await expect(page).toHaveScreenshot("dashboard-dark.png", {
			maxDiffPixelRatio: 0.01,
		});
	});

	test("submission detail 2026SS_910 — light", async ({ page }) => {
		await page.goto("/submissions/2026SS_910");
		// Cells must render (source + output) before capturing.
		await expect(page.locator(".cell-card")).toHaveCount(2, { timeout: 15_000 });
		await expect(page.locator(".cell-output").last()).toContainText("5");
		await expect(page).toHaveScreenshot("detail-light.png", {
			maxDiffPixelRatio: 0.01,
		});
	});

	test("submission detail 2026SS_910 — dark", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto("/submissions/2026SS_910");
		await expect(page.locator(".cell-card")).toHaveCount(2, { timeout: 15_000 });
		await expect(page.locator("html")).toHaveClass(/dark/);
		await expect(page).toHaveScreenshot("detail-dark.png", {
			maxDiffPixelRatio: 0.01,
		});
	});
});
