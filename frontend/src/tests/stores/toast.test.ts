// @vitest-environment jsdom
/**
 * @file Unit tests for the toast store's duplicate-guard + timer semantics.
 *
 * Covers the dedupe-by-(type,message) behavior added in P10-B: re-pushing an
 * identical toast while one is visible resets its auto-dismiss timer instead
 * of stacking a twin; a re-push during the 200ms exit-animation window re-shows
 * a fresh banner (the old one is already on its way out).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addToast, exitingToasts, removeToast, toasts } from "$lib/stores/toast.svelte.js";

describe("toast store dedupe", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		// Reset the reactive state between tests: splice everything out.
		while (toasts.length > 0) toasts.pop();
		exitingToasts.clear();
	});

	it("pushes a new toast", () => {
		addToast("error", "boom");
		expect(toasts).toHaveLength(1);
		expect(toasts[0].type).toBe("error");
		expect(toasts[0].message).toBe("boom");
	});

	it("does NOT stack an identical toast while one is visible", () => {
		addToast("error", "boom");
		addToast("error", "boom");
		expect(toasts).toHaveLength(1);
	});

	it("resets the auto-dismiss timer on re-push (toast lasts longer)", () => {
		addToast("error", "boom", 3000);
		vi.advanceTimersByTime(2000);
		// Re-push inside the original window: the toast must NOT be dismissed at 3s.
		addToast("error", "boom", 3000);
		vi.advanceTimersByTime(1000);
		expect(toasts).toHaveLength(1);
		// Original 3s deadline passed; the reset timer fires at 5s.
		vi.advanceTimersByTime(1500);
		expect(toasts).toHaveLength(1);
		// Reset timer fires at 5s → exit animation (200ms) → removal.
		vi.advanceTimersByTime(500);
		expect(toasts).toHaveLength(1); // still in exit animation
		vi.advanceTimersByTime(200);
		expect(toasts).toHaveLength(0);
	});

	it("pushes a twin for a DIFFERENT message", () => {
		addToast("error", "boom");
		addToast("error", "different");
		expect(toasts).toHaveLength(2);
	});

	it("pushes a twin for a DIFFERENT type", () => {
		addToast("error", "boom");
		addToast("success", "boom");
		expect(toasts).toHaveLength(2);
	});

	it("re-fires during the exit window and re-shows a fresh banner", () => {
		addToast("error", "boom");
		removeToast(toasts[0].id); // enters 200ms exit animation
		expect(exitingToasts.has(toasts[0].id)).toBe(true);
		// Re-fire while the old one is still animating out.
		addToast("error", "boom");
		// The exit animation of the OLD toast must remove the OLD one, but the
		// NEW toast must remain (dedupe treats exiting toasts as gone).
		vi.advanceTimersByTime(200);
		expect(toasts).toHaveLength(1);
	});
});
