import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	define: {
		APP_VERSION: JSON.stringify(pkg.version),
	},
});
