/**
 * @file In-memory store for the KI Connect API key (server-side only).
 *
 * The key is initialized from the `KI_CONNECT_API_KEY` env var and can be
 * replaced at runtime from the Settings page (`PATCH /api/settings`).
 * It is NEVER exposed by any API — the settings surface only reports
 * `hasApiKey: boolean`.
 *
 * `setApiKey` keeps `process.env.KI_CONNECT_API_KEY` in sync (the env var is
 * the canonical source the KiConnectClient singleton reads at construction)
 * and resets the singleton, so the next `getKiConnectClient()` call — and
 * any other env-reading module — picks up the new key immediately.
 */

import { resetKiConnectClient } from "./ki-connect";

let _apiKey: string = process.env["KI_CONNECT_API_KEY"] ?? "";

/** Current API key (may be empty when none is configured). */
export function getApiKey(): string {
	return _apiKey;
}

/** Replace the API key and reset the KiConnectClient singleton so the new
 * key takes effect on the next request. */
export function setApiKey(key: string): void {
	_apiKey = key;
	process.env["KI_CONNECT_API_KEY"] = key;
	resetKiConnectClient();
}

/** Whether a non-empty API key is configured. */
export function hasApiKey(): boolean {
	return _apiKey.trim().length > 0;
}
