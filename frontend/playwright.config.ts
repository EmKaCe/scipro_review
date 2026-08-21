import { defineConfig } from "@playwright/test";

/**
 * Playwright E2E suite for the SciPro Review teacher app.
 *
 * The stack is fully hermetic: `e2e/scripts/start-stack.sh` seeds a throwaway
 * temp DATA_DIR, starts the FastAPI executor on 127.0.0.1:8767 and Vite
 * (teacher mode) on 127.0.0.1:5174. The repo's real data/ and ports
 * 8766/5173 are never touched — another process uses them concurrently.
 *
 * Visual-regression baselines (e2e/*.spec.ts-snapshots/) are committed for
 * Linux only — that is the declared platform constraint.
 */
export default defineConfig({
	testDir: "./e2e",
	// Specs run serially: teacher-flow and visual-regression share one
	// webServer/DATA_DIR and both mutate submissions — parallel files would
	// race on uploads/process/deletes.
	workers: 1,
	timeout: 180_000,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: "http://localhost:5174",
		headless: true,
	},
	expect: {
		toHaveScreenshot: {
			// Deterministic screenshots: freeze CSS animations/transitions at
			// their end state instead of capturing mid-transition frames.
			animations: "disabled",
			maxDiffPixelRatio: 0.01,
		},
	},
	webServer: {
		// NOTE: the package.json "dev" script only prints "Specify mode:
		// pnpm run dev:student or dev:teacher" and exits — it is NOT a valid
		// webServer command. The stack script does the full hermetic bring-up
		// (seed temp DATA_DIR → executor :8767 → vite :5174).
		command: "bash e2e/scripts/start-stack.sh",
		url: "http://localhost:5174",
		reuseExistingServer: false,
		cwd: ".",
		timeout: 120_000,
	},
});
