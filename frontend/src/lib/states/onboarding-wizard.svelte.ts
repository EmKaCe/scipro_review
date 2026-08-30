/**
 * @file 2.8.0 onboarding wizard — step model and status derivation.
 *
 * Pure TS module (no runes, no module-level mutable state) mapping the
 * GET /api/onboarding/status items onto the wizard's fixed step order. The
 * step shell drives navigation off `firstIncompleteStep`; completion is
 * derived from the status payload, never stored here.
 *
 * Mapping:
 *
 *   welcome    — always complete (entry screen).
 *   restore    — fork=restore flows only; no status item maps to it. Complete
 *                unless the user entered a restore flow (`fork: "restore"`).
 *   provider   — status item llm-provider.
 *   docs-index — status item docs-index.
 *   executor   — never derived from status; apply the live /api/executor/health
 *                probe result via markExecutor().
 *   seed       — status items create-assignment AND wire-scoring both done:true
 *                (a performed seed lands exactly those two items), or the
 *                `seeded` option passed explicitly.
 *   done       — complete when every prior step is complete. first-pipeline is
 *                not a step and never gates this non-blocking closing step.
 */

export const STEP_ORDER = [
	"welcome",
	"restore",
	"provider",
	"docs-index",
	"executor",
	"seed",
	"done",
] as const;

export type WizardStepId = (typeof STEP_ORDER)[number];

/** One wizard step: fixed id plus its derived completion flag. */
export interface WizardStep {
	id: WizardStepId;
	complete: boolean;
}

/**
 * Shape of the GET /api/onboarding/status payload (authoritative shape lives
 * in $lib/server/onboarding-status.ts; duplicated here so the client-side
 * state module never imports $lib/server/*).
 */
export interface OnboardingStatusInput {
	items: {
		id: string;
		done: boolean | null;
		detail?: string;
	}[];
}

/** Extra derivation inputs that live outside the status payload. */
export interface DeriveOptions {
	/** Wizard start fork. The restore step participates only in restore flows. */
	fork?: "fresh" | "restore";
	/** Optimistic "seed was performed" flag (before status re-poll lands). */
	seeded?: boolean;
}

/** Index of the closing step within STEP_ORDER and the returned array. */
const DONE_INDEX = STEP_ORDER.indexOf("done");

/**
 * Derive the wizard steps from a status payload (fixed order, pure function).
 *
 * See the file doc comment for the per-step mapping. Steps never observed in
 * the status payload (welcome, restore, executor, done) get their defaults
 * here; restored/fork state and the executor probe are layered on top via
 * the options / markExecutor().
 */
export function deriveSteps(
	status: OnboardingStatusInput,
	options: DeriveOptions = {},
): WizardStep[] {
	const byId: Record<string, { id: string; done: boolean | null; detail?: string }> = {};
	for (const item of status.items) byId[item.id] = item;

	/** True when every listed status item is present with done:true. */
	const itemsDone = (...ids: string[]): boolean => ids.every((id) => byId[id]?.done === true);

	const steps: WizardStep[] = [
		// welcome — always complete.
		{ id: "welcome", complete: true },
		// restore — no status mapping; only the fork choice activates it.
		{ id: "restore", complete: options.fork !== "restore" },
		// provider — status item llm-provider.
		{ id: "provider", complete: byId["llm-provider"]?.done === true },
		// docs-index — status item docs-index.
		{ id: "docs-index", complete: byId["docs-index"]?.done === true },
		// executor — probed separately; status-only derivation leaves it
		// incomplete until markExecutor() applies the probe result.
		{ id: "executor", complete: false },
		// seed — both wiring items done, or explicitly seeded.
		{
			id: "seed",
			complete: options.seeded === true || itemsDone("create-assignment", "wire-scoring"),
		},
		// done — recomputed below from the preceding steps.
		{ id: "done", complete: false },
	];

	steps[DONE_INDEX] = {
		...steps[DONE_INDEX],
		complete: steps.slice(0, DONE_INDEX).every((s) => s.complete),
	};
	return steps;
}

/**
 * Apply a live executor probe result, returning NEW steps with
 * `executor.complete = ok` (pure — the input array is never mutated). The
 * closing step is re-derived so `done` reflects the probe.
 */
export function markExecutor(steps: WizardStep[], ok: boolean): WizardStep[] {
	const next = steps.map((s) => (s.id === "executor" ? { ...s, complete: ok } : s));
	next[DONE_INDEX] = {
		...next[DONE_INDEX],
		complete: next.slice(0, DONE_INDEX).every((s) => s.complete),
	};
	return next;
}

/**
 * Id of the first step the wizard still needs work on — "done" when every
 * step is complete (the terminal answer for the step shell's next-target).
 */
export function firstIncompleteStep(steps: WizardStep[]): WizardStepId {
	return steps.find((s) => !s.complete)?.id ?? "done";
}
