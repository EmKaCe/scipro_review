import adapterStatic from "@sveltejs/adapter-static";
import adapterNode from "@sveltejs/adapter-node";

const isNode = process.env.ADAPTER === "node";
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
		adapter: isNode ? adapterNode() : adapterStatic({ fallback: "404.html" }),
		paths: {
			// GitHub Pages serves at /svelte_review/ — dev server uses root /
			// Node builds also use root — the Docker container handles routing
			base: isNode || dev ? "" : "/svelte_review",
		},
	},
};

export default config;
