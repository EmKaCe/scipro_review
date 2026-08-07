/**
 * @file /api/settings — read/write teacher-adjustable app settings.
 *
 * GET  — current settings (executor timeouts + LLM provider). Secrets are
 *        never exposed: the API only returns the settings-file surface.
 * PUT  — persist settings to data/settings.yaml. The full AppSettings shape
 *        is required; values are validated (positive numbers, non-empty
 *        strings) and merged over defaults on the next read.
 *
 * These settings feed the server-side executor client and KI Connect client,
 * so a save here takes effect on the next batch/single execution request.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

import { loadSettings, writeSettings, type AppSettings } from "$lib/server/settings";

function isAppSettings(value: unknown): value is AppSettings {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	const ex = v.executor as Record<string, unknown> | undefined;
	const llm = v.llm as Record<string, unknown> | undefined;
	if (!ex || !llm) return false;
	const posInt = (x: unknown): x is number =>
		typeof x === "number" && Number.isFinite(x) && x > 0;
	const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
	return (
		posInt(ex.requestTimeoutMs) &&
		posInt(ex.notebookTimeoutMs) &&
		posInt(ex.cellTimeoutS) &&
		nonEmpty(llm.baseUrl) &&
		nonEmpty(llm.model) &&
		posInt(llm.timeoutMs)
	);
}

export async function GET(): Promise<Response> {
	const settings = await loadSettings();
	return json(settings);
}

export async function PUT(event: RequestEvent): Promise<Response> {
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		throw error(400, "Expected a JSON body");
	}
	if (!isAppSettings(body)) {
		throw error(
			400,
			"Invalid settings: expected executor (requestTimeoutMs, notebookTimeoutMs, cellTimeoutS) and llm (baseUrl, model, timeoutMs) with positive numbers / non-empty strings",
		);
	}
	await writeSettings(body);
	return json(await loadSettings());
}
