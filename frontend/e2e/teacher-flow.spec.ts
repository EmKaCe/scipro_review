/// <reference types="node" />
/**
 * Teacher-flow E2E — happy path (upload → process → review → grade → export)
 * plus the error path (a failing cell surfaces its error state and the
 * dashboard summary keeps it).
 *
 * Stack: hermetic (see e2e/scripts/start-stack.sh) — temp DATA_DIR, executor
 * on :8767, vite (teacher mode) on :5174. The teacher UI lives at
 * /submissions (in dev, "/" is the student home by design — never tested).
 *
 * Run: cd frontend && npx playwright test e2e/teacher-flow.spec.ts
 */
import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSIGNMENT = "soil_contamination";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const NOTEBOOKS = ["2026SS_910.ipynb", "2026SS_911.ipynb", "2026SS_912.ipynb"];
const ALL_IDS = ["2026SS_910", "2026SS_911", "2026SS_912"];

/** Remove any rows left over from an earlier run (404s are fine). */
async function resetRows(request: APIRequestContext) {
	for (const id of ALL_IDS) {
		await request
			.delete(`/api/submissions/${id}?assignment=${ASSIGNMENT}`)
			.catch(() => {});
	}
}

/** POST the fixture notebooks through the real upload UI. */
async function uploadThroughUi(page: Page) {
	// The upload panel is toggled by the "Upload More" button.
	await page.getByRole("button", { name: "Upload More" }).click();
	const input = page.locator(".upload-panel input[type=file]");
	await expect(input).toBeAttached();
	await input.setInputFiles(NOTEBOOKS.map((n) => path.join(FIXTURES, n)));
	// Results table with per-file classification chips.
	await expect(page.locator(".class-table")).toBeVisible({ timeout: 15_000 });
}

/** Expand every collapsed rubric category so its items are visible. */
async function expandAllRubricCategories(page: Page) {
	const collapsed = page.locator(".tab-content button[aria-expanded='false']");
	while ((await collapsed.count()) > 0) {
		await collapsed.first().click();
		await page.waitForTimeout(150); // Svelte 5 async state flush
	}
}

/** Set a grading slider value (fill works on range inputs; fall back to
 *  a synthetic input event which oninput handlers accept). */
async function setSlider(page: Page, name: string, value: number) {
	const slider = page.getByRole("slider", { name });
	await slider.fill(String(value)).catch(async () => {
		await slider.evaluate((el, v) => {
			const input = el as HTMLInputElement;
			input.value = String(v);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		}, value);
	});
	await expect(slider).toHaveValue(String(value));
}

test.describe("teacher flow", () => {
	test.beforeEach(async ({ request }) => {
		await resetRows(request);
	});

	test.afterAll(async ({ request }) => {
		// Best-effort cleanup of the seeded rows (temp DATA_DIR is discarded
		// anyway, but keep the stack tidy for the next spec file).
		await resetRows(request);
	});

	test("happy path: upload → process → review → grade → export", async ({
		page,
		request,
	}) => {
		await page.goto("/submissions");

		// ── Upload ────────────────────────────────────────────────────────
		await uploadThroughUi(page);

		// Server classification: every fixture is a submission (digit student
		// id after the semester) → "Submission" kind chips. Status shows
		// "Uploaded" on a fresh file, "Replaced" when the seeded copy of the
		// same notebook already exists in DATA_DIR — both are success states.
		await expect(page.locator(".chip.chip-submission")).toHaveCount(3);
		for (const name of NOTEBOOKS) {
			await expect(
				page.locator(".class-table").getByText(name, { exact: true }),
			).toBeVisible();
		}
		await expect(page.locator(".status-uploaded, .badge-replaced")).toHaveCount(3);

		// Upload auto-selects the new rows → bulk bar "Process" is live.
		const processBtn = page.getByRole("button", { name: "Process", exact: true });
		await expect(processBtn).toBeEnabled({ timeout: 15_000 });

		// ── Process ───────────────────────────────────────────────────────
		await processBtn.click();

		// Each notebook executes in ~5-15s; the batch loop runs serially.
		// Poll the server-authoritative list (no fixed sleeps). Note: a
		// notebook with cell errors still settles as status "executed" —
		// the errors live in the cell summary, not the status.
		await expect
			.poll(
				async () => {
					const res = await request.get(
						`/api/submissions?assignment=${ASSIGNMENT}`,
					);
					const body = (await res.json()) as {
						submissions: { studentId: string; status: string }[];
					};
					const byId = Object.fromEntries(
						body.submissions.map((s) => [s.studentId, s.status]),
					);
					return [byId["2026SS_910"], byId["2026SS_911"], byId["2026SS_912"]];
				},
				{ timeout: 120_000, message: "batch process should settle" },
			)
			.toEqual(["executed", "executed", "executed"]);

		// Dashboard rows reflect the settled states. Scope to the submissions
		// table — the upload panel's classification table also has tbody tr.
		const row910 = page.locator(".submissions-table tbody tr", {
			hasText: "2026SS_910",
		});
		await expect(row910).toContainText("Executed");
		await expect(row910).toContainText("2 cells");

		// ── Review: open the clean submission ─────────────────────────────
		await row910.getByRole("link", { name: "2026SS_910" }).click();
		await page.waitForURL("**/submissions/2026SS_910");

		// Cells render source + output.
		await expect(page.locator(".cell-card")).toHaveCount(2, { timeout: 15_000 });
		await expect(
			page.locator(".cell-card").first().locator("pre.hljs"),
		).toContainText("x = 5");
		await expect(page.locator(".cell-output").last()).toContainText("5");

		// ── Grade: tick a rubric item + move a dimension slider ───────────
		// Rubric categories are collapsed by default — expand first.
		await expandAllRubricCategories(page);
		const rubricItem = page.getByLabel("blank lines - consistent and good usage");
		await rubricItem.check();

		// Sliders live on the Grading tab.
		await page.getByRole("button", { name: "Grading" }).click();
		await setSlider(page, "Code Quality & Design", 5);

		// Save Grade (header Save button; no plagiarism pairs exist, so no
		// export-guard modal appears).
		await page.getByRole("button", { name: "Save", exact: true }).click();

		// Persistence via the API, not the DOM.
		await expect
			.poll(
				async () => {
					const res = await request.get(
						`/api/submissions/2026SS_910?assignment=${ASSIGNMENT}`,
					);
					const rec = (await res.json()) as {
						grading?: {
							dimensions?: Record<string, number>;
							feedback?: Record<string, unknown>;
						};
					};
					return rec.grading?.dimensions?.["code_quality_design"];
				},
				{ timeout: 15_000 },
			)
			.toBe(5);

		// Reload → state survives.
		await page.reload();
		await expect(page.locator(".cell-card")).toHaveCount(2, { timeout: 15_000 });
		await expandAllRubricCategories(page);
		await expect(rubricItem).toBeChecked();
		await page.getByRole("button", { name: "Grading" }).click();
		await expect(
			page.getByRole("slider", { name: "Code Quality & Design" }),
		).toHaveValue("5");

		// ── Export: student copy has feedback, never plagiarism ───────────
		const exportRes = await request.get(
			`/api/submissions/2026SS_910/export?kind=student&assignment=${ASSIGNMENT}`,
		);
		expect(exportRes.ok()).toBeTruthy();
		const yaml = await exportRes.text();
		expect(yaml).toContain("feedback:");
		expect(yaml).not.toContain("plagiarism");
	});

	test("error path: failing cell shows its error state and the dashboard keeps it", async ({
		page,
		request,
	}) => {
		await page.goto("/submissions");
		await uploadThroughUi(page);

		const processBtn = page.getByRole("button", { name: "Process", exact: true });
		await expect(processBtn).toBeEnabled({ timeout: 15_000 });
		await processBtn.click();

		// 2026SS_911 has a SyntaxError in cell 2. The run completes (status
		// "executed") but the cell summary keeps the error count.
		await expect
			.poll(
				async () => {
					const res = await request.get(
						`/api/submissions?assignment=${ASSIGNMENT}`,
					);
					const body = (await res.json()) as {
						submissions: {
							studentId: string;
							status: string;
							cellSummary?: string;
						}[];
					};
					return body.submissions.find(
						(s) => s.studentId === "2026SS_911",
					)?.cellSummary;
				},
				{ timeout: 120_000 },
			)
			.toBe("3 cells, 1 error");

		// Dashboard row: the ORIGINAL cell summary stays visible ("3 cells,
		// 1 error"), on a completed ("Executed") run. Scoped to the
		// submissions table (the upload panel has its own tbody tr).
		const row911 = page.locator(".submissions-table tbody tr", {
			hasText: "2026SS_911",
		});
		await expect(row911).toContainText("Executed");
		await expect(row911).toContainText(/3 cells, \d+ error/);

		// Open the failing submission.
		await row911.getByRole("link", { name: "2026SS_911" }).click();
		await page.waitForURL("**/submissions/2026SS_911");

		// The error cell renders: source + the SyntaxError block.
		await expect(page.locator(".cell-card")).toHaveCount(3, { timeout: 15_000 });
		const errorCell = page.locator(".cell-card.cell-error");
		await expect(errorCell).toHaveCount(1);
		await expect(errorCell.locator("pre.hljs")).toContainText("print(x");
		await expect(errorCell.locator(".cell-error-block")).toContainText("SyntaxError");
		await expect(errorCell.locator(".cell-marker")).toContainText("Error");

		// The dependent cell 3 never ran — no fabricated output/error.
		const lastCell = page.locator(".cell-card").nth(2);
		await expect(lastCell.locator(".cell-error-block")).toHaveCount(0);

		// Back on the dashboard, the ORIGINAL error summary is still there
		// (nothing hid it after visiting the detail page).
		await page.goto("/submissions");
		await expect(
			page.locator(".submissions-table tbody tr", { hasText: "2026SS_911" }),
		).toContainText(/3 cells, \d+ error/);
		await expect(
			page.locator(".submissions-table tbody tr", { hasText: "2026SS_911" }),
		).toContainText("Executed");
	});
});
