/**
 * @file Copilot tool registration entry point.
 *
 * Imports every tool module and registers its tools into the copilot
 * registry (the agent's tool surface). Called by agent.ts `buildAgent()`
 * BEFORE the Mastra Agent is constructed, so `registry.list()` feeds the
 * agent's tools.
 *
 * There is deliberately no runtime import cycle: tool modules only
 * type-import from ../registry and ../agent — the registry singleton is
 * passed in here at call time.
 */

import { registerAnalysisTools } from "./analysis-tools";
import { registerContextTools } from "./context-tools";
import { registerPreevalTools } from "./preeval-tools";
import { registerReferenceTools } from "./reference-tools";

import type { CopilotRegistry } from "../registry";

/**
 * Register the full copilot tool surface (context, reference/ops-read,
 * analysis, and pre-evaluation tools). Idempotent per call — registration
 * rejects duplicate names, so calling it more than once with the same set
 * throws.
 */
export function registerCopilotTools(registry: CopilotRegistry): void {
	registerContextTools(registry);
	registerReferenceTools(registry);
	registerAnalysisTools(registry);
	registerPreevalTools(registry);
}
