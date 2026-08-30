/**
 * @file Tests for the 2.8.0 wizard step model ($lib/states/onboarding-wizard.svelte).
 *
 * Pure status→step derivation: GET /api/onboarding/status items map onto the
 * wizard's fixed step order; the executor step is probed separately (never
 * from status); first-pipeline never gates the closing step.
 */
import { describe, expect, it } from "vitest";

import {
	STEP_ORDER,
	deriveSteps,
	firstIncompleteStep,
	markExecutor,
	type WizardStep,
} from "$lib/states/onboarding-wizard.svelte";

describe("wizard step model", () => {
	it("maps status items to wizard steps in fixed order (provider reflects llm-provider)", () => {
		const steps: WizardStep[] = deriveSteps({
			items: [
				{ id: "create-assignment", done: true },
				{ id: "wire-scoring", done: true },
				{ id: "llm-provider", done: false },
				{ id: "docs-index", done: null },
				{ id: "first-pipeline", done: false },
			],
		});

		expect(steps.map((s) => s.id)).toEqual([...STEP_ORDER]);
		const byId = new Map(steps.map((s) => [s.id, s]));

		// welcome is always complete; provider mirrors llm-provider (false here).
		expect(byId.get("welcome")!.complete).toBe(true);
		expect(byId.get("restore")!.complete).toBe(true); // fresh flow — vacuous
		expect(byId.get("provider")!.complete).toBe(false);
		// docs-index done:null → incomplete; executor never comes from status.
		expect(byId.get("docs-index")!.complete).toBe(false);
		expect(byId.get("executor")!.complete).toBe(false);
		// seed comes from create-assignment + wire-scoring, both done here.
		expect(byId.get("seed")!.complete).toBe(true);
	});

	it("first-pipeline never blocks the closing step", () => {
		const steps = deriveSteps({
			items: [
				{ id: "create-assignment", done: true },
				{ id: "wire-scoring", done: true },
				{ id: "llm-provider", done: true },
				{ id: "docs-index", done: true },
				{ id: "first-pipeline", done: false },
			],
		});

		// Executor is probed outside status; once the probe passes, every
		// config step is complete — first-pipeline:false changes nothing.
		const probed = markExecutor(steps, true);
		expect(probed.find((s) => s.id === "executor")!.complete).toBe(true);
		expect(probed.find((s) => s.id === "done")!.complete).toBe(true);
		expect(firstIncompleteStep(probed)).toBe("done");
	});
});