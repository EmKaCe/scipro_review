import adapter from "@sveltejs/adapter-static";

const dev = process.env.NODE_ENV === "development";

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) =>
			filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
		// Suppress autofocus a11y warning — autofocus is intentional on modal dialog buttons
		warningFilter: (warning) => warning.code !== "a11y_autofocus",
	},
	kit: {
		adapter: adapter({
			// SPA fallback — all routes are handled client-side
			fallback: "404.html",
		}),
		paths: {
			// GitHub Pages serves at /svelte_review/ — dev server uses root /
			base: dev ? "" : "/svelte_review",
		},
	},
};

export default config;
