/**
 * @file Vitest global setup — runs before each test suite.
 *
 * Provides a minimal browser-like environment for service-layer tests.
 * Component tests should use @testing-library/svelte with jsdom.
 */
import "fake-indexeddb/auto";
import { vi } from "vitest";

// Mock `window.location` for URL construction in criteria-loader and grading-config
if (typeof window !== "undefined" && !window.location) {
	Object.defineProperty(window, "location", {
		value: {
			origin: "http://localhost:5173",
			href: "http://localhost:5173",
		},
		writable: true,
	});
}

// Mock `document.createElement` for downloadFile tests
if (typeof document !== "undefined") {
	const originalCreateElement = document.createElement.bind(document);
	document.createElement = vi.fn((tagName: string) => {
		const el = originalCreateElement(tagName);
		if (tagName === "a") {
			Object.defineProperty(el, "click", { value: vi.fn(), writable: true });
			Object.defineProperty(el, "download", { value: "", writable: true });
			Object.defineProperty(el, "href", { value: "", writable: true });
		}
		return el;
	}) as typeof document.createElement;
}
