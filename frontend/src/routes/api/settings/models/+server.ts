/**
 * @file GET /api/settings/models — live model list from KI Connect.
 *
 * Primary source: `GET {baseUrl}/models` via {@link KiConnectClient.listModels}.
 * When the live call fails or returns nothing (API unreachable, no key
 * configured), the static MODEL_CONTEXT_TOKENS map is served instead so the
 * Settings page always has a model dropdown to offer.
 */

import { json } from "@sveltejs/kit";

import { getKiConnectClient, type KiConnectModel } from "$lib/server/ki-connect";
import {
	MODEL_CONTEXT_TOKENS,
	isOpenWeightModel,
	resolveContextTokens,
} from "$lib/server/copilot/model-context";

/** One model entry served to the Settings page. */
export interface ModelInfo {
	id: string;
	contextTokens: number;
	isOpenWeight: boolean;
	operator?: string;
}

export async function GET(): Promise<Response> {
	// listModels() is contractually non-throwing, but never let an unexpected
	// failure take the whole endpoint down — fall back to the static map.
	let live: KiConnectModel[];
	try {
		live = await getKiConnectClient().listModels();
	} catch {
		live = [];
	}

	if (live.length > 0) {
		const models: ModelInfo[] = live.map((model) => ({
			id: model.id,
			contextTokens: model.context_length ?? resolveContextTokens(model.id),
			isOpenWeight: isOpenWeightModel(model.id),
			operator: model.owned_by || undefined,
		}));
		return json({ models, source: "live" as const });
	}

	// Static fallback: the verified model map (context sizes + operators
	// from the KI Connect deployments page).
	const models: ModelInfo[] = Object.entries(MODEL_CONTEXT_TOKENS).map(([id, contextTokens]) => ({
		id,
		contextTokens,
		isOpenWeight: isOpenWeightModel(id),
	}));
	return json({ models, source: "static" as const });
}
