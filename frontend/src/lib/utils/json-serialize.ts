/**
 * @file Shared JSON serialization utility.
 *
 * Deep-clones values for IndexedDB or JSON storage, stripping Svelte 5 Proxy
 * wrappers and converting Set/Map to JSON-compatible arrays.
 *
 * @example
 * ```ts
 * import { jsonSerialize } from "$lib/utils/json-serialize";
 *
 * const clean = jsonSerialize(reactiveSession);
 * await db.put("store", clean);
 * ```
 */

/**
 * Deep-clone a value for serialization (IndexedDB, JSON, etc.).
 *
 * Strips Svelte 5 Proxy wrappers that IndexedDB's structuredClone cannot
 * handle, and converts:
 * - Set → Array
 * - Map → Array of [key, value] entries
 *
 * @param value - The value to serialize (may contain Proxies, Sets, or Maps).
 * @returns A plain, deeply cloned copy safe for storage.
 */
export function jsonSerialize<T>(value: T): T {
	return JSON.parse(
		JSON.stringify(value, (_key, val) => {
			if (val instanceof Set) return [...val];
			if (val instanceof Map) return [...val.entries()];
			return val;
		}),
	);
}
