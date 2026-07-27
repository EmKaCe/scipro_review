import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	timeout: 30000,
	retries: 0,
	use: {
		baseURL: "http://localhost:5174",
		headless: true,
	},
	webServer: {
		command: "pnpm dev --port 5174",
		url: "http://localhost:5174",
		reuseExistingServer: true,
		cwd: ".",
	},
});
