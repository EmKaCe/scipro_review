/** @file Reactive toast notification store using Svelte 5 runes. */
import type { Toast, ToastType } from "../types/index.js";

import { SvelteMap, SvelteSet } from "svelte/reactivity";

/** Auto-incrementing ID counter for toast notifications. */
let nextId = 0;

/** Reactive array of currently displayed toast notifications. */
export const toasts = $state<Toast[]>([]);

/** Set of toast IDs currently in exit animation. */
export const exitingToasts = new SvelteSet<string>();

/** Map of toast IDs to their auto-dismiss timeout IDs. */
const toastTimeouts = new SvelteMap<string, number>();

/**
 * Display a toast notification that auto-dismisses after the specified duration.
 * @param type - Severity level of the toast.
 * @param message - Message text to display.
 * @param duration - Auto-dismiss duration in milliseconds (default 3000).
 */
export function addToast(type: ToastType, message: string, duration: number = 3000): void {
	const id = `toast-${nextId++}`;
	toasts.push({ id, type, message, duration });
	const timeoutId = window.setTimeout(() => removeToast(id), duration);
	toastTimeouts.set(id, timeoutId);
}

/**
 * Remove a toast notification by its ID, first triggering the exit animation.
 * @param id - The unique toast identifier to remove.
 */
export function removeToast(id: string): void {
	const timeoutId = toastTimeouts.get(id);
	if (timeoutId !== undefined) {
		clearTimeout(timeoutId);
		toastTimeouts.delete(id);
	}
	exitingToasts.add(id);
	setTimeout(() => {
		const index = toasts.findIndex((t) => t.id === id);
		if (index !== -1) {
			toasts.splice(index, 1);
		}
		exitingToasts.delete(id);
	}, 200);
}
