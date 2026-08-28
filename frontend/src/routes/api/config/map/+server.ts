/**
 * @file GET /api/config/map — live configuration inventory (A1).
 *
 * Read-only aggregation of the running server's configuration: settings
 * group (data/settings.yaml + grading_config.yaml + env + localStorage),
 * assignment group (assignments.yaml), deploy group (process.env), and code
 * group (engineering constants). Every row carries a stable id, its source,
 * status, where it is edited (affordance), and when a change takes effect
 * (reload).
 *
 * Response shape: { rows: ConfigMapRow[], generatedAt: string }
 *
 * Secret rule: the API key row only reports presence — value is "••••" or
 * null, never the real key. Cheap by construction: all loaders are file
 * reads / env lookups.
 */

import { json } from "@sveltejs/kit";

import { getConfigMap } from "$lib/server/config-map";

export async function GET(): Promise<Response> {
	return json(await getConfigMap());
}
