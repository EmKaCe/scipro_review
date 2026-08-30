<script module lang="ts">
	/**
	 * Shared step metadata (titles + blurbs) exported for the page's Done
	 * summary — one source of truth for the step labels.
	 */
	import type { WizardStepId } from "$lib/states/onboarding-wizard.svelte";

	export const STEP_META: Record<WizardStepId, { title: string; blurb: string }> = {
		welcome: {
			title: "Welcome",
			blurb: "Choose how to set up this SciPro Review installation.",
		},
		restore: {
			title: "Restore a backup",
			blurb: "Bring back settings, assignments and submissions from another machine.",
		},
		provider: {
			title: "LLM provider",
			blurb: "Connect the KI Connect endpoint the copilot grades through.",
		},
		"docs-index": {
			title: "Docs index",
			blurb: "Build the offline semantic search index the copilot looks up against.",
		},
		executor: {
			title: "Executor check",
			blurb: "Verify the notebook-execution backend is reachable.",
		},
		seed: {
			title: "Reference assignment",
			blurb: "Enable the bundled reference assignment for your first grading pass.",
		},
		done: {
			title: "Finish",
			blurb: "Setup complete — run your first grading pass whenever you're ready.",
		},
	};
</script>

<script lang="ts">
	/**
	 * Step-shell chrome for the 2.8.0 onboarding wizard.
	 *
	 * Strictly presentational — no fetching, no data mutation. Completion
	 * comes from the `steps` prop (derived by the page from the status
	 * payload), navigation reports through `ongoto`, the welcome fork
	 * choice through `onfork`. All steps are navigable: Next/Back always
	 * enabled, so skippable steps (docs-index, executor, seed) can be
	 * walked past without completion — the Done summary (page side) shows
	 * the honest state.
	 */
	import type { WizardStep } from "$lib/states/onboarding-wizard.svelte";
	import { cn } from "$lib/utils.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import Check from "@lucide/svelte/icons/check";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
	import KeyRound from "@lucide/svelte/icons/key-round";
	import BookOpenCheck from "@lucide/svelte/icons/book-open-check";
	import Server from "@lucide/svelte/icons/server";
	import PackagePlus from "@lucide/svelte/icons/package-plus";
	import PartyPopper from "@lucide/svelte/icons/party-popper";
	import ChevronLeft from "@lucide/svelte/icons/chevron-left";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";

	interface Props {
		steps: WizardStep[];
		current: WizardStepId;
		fork?: "fresh" | "restore" | null;
		onfork: (choice: "fresh" | "restore") => void;
		ongoto: (step: WizardStepId) => void;
		children?: import("svelte").Snippet;
	}

	let { steps, current, fork = null, onfork, ongoto, children }: Props = $props();

	/** The step icons shown in the step header. */
	const STEP_ICONS: Record<WizardStepId, typeof Sparkles> = {
		welcome: Sparkles,
		restore: ArchiveRestore,
		provider: KeyRound,
		"docs-index": BookOpenCheck,
		executor: Server,
		seed: PackagePlus,
		done: PartyPopper,
	};

	/** Active step's icon — derived so it can be used as a dynamic component. */
	const CurrentStepIcon = $derived(STEP_ICONS[current]);

	/**
	 * The rail omits the restore step unless a restore flow was chosen —
	 * in fresh flows it is vacuously complete and would just be noise.
	 */
	const railSteps = $derived(steps.filter((s) => !(s.id === "restore" && fork !== "restore")));
	const currentIndex = $derived(railSteps.findIndex((s) => s.id === current));
	const prevStep = $derived(currentIndex > 0 ? railSteps[currentIndex - 1] : undefined);
	const nextStep = $derived(
		currentIndex >= 0 && currentIndex < railSteps.length - 1
			? railSteps[currentIndex + 1]
			: undefined,
	);
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="grid gap-0 sm:grid-cols-[13rem_1fr]">
		<nav
			aria-label="Setup steps"
			class="border-b border-border bg-muted/20 p-4 sm:border-b-0 sm:border-r"
		>
			<ol class="space-y-1">
				{#each railSteps as step, i (step.id)}
					{@const active = step.id === current}
					<li>
						<button
							type="button"
							onclick={() => ongoto(step.id)}
							aria-current={active ? "step" : undefined}
							class={cn(
								"flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2 py-1.5 text-left text-sm transition-colors",
								active
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
							)}
						>
							<span class="flex h-5 w-5 shrink-0 items-center justify-center">
								{#if step.complete}
									<Check class="h-4 w-4 text-success" />
								{:else}
									<span
										class="flex h-4.5 w-4.5 items-center justify-center rounded-full border border-border text-[10px] font-semibold"
									>
										{i + 1}
									</span>
								{/if}
							</span>
							<span class="min-w-0 flex-1 truncate font-medium">
								{STEP_META[step.id].title}
							</span>
							{#if step.complete}
								<span
									class="shrink-0 rounded-full border border-success/30 bg-success/10 px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase text-success"
								>
									Done
								</span>
							{/if}
						</button>
					</li>
				{/each}
			</ol>
		</nav>

		<div class="flex min-w-0 flex-col p-5">
			<header>
				<h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
					<CurrentStepIcon class="h-5 w-5 text-primary" />
					{STEP_META[current].title}
				</h2>
				<p class="mt-1 text-sm text-muted-foreground">{STEP_META[current].blurb}</p>
			</header>

			{#if current === "welcome"}
				<!-- The fork decides the path: restore flows jump to restore,
				     fresh flows straight to the provider step. -->
				<div class="mt-5 space-y-2">
					<button
						type="button"
						aria-pressed={fork === "fresh"}
						class={cn(
							buttonVariants({ variant: "default" }),
							"w-full justify-start",
							fork === "fresh" && "ring-2 ring-primary/40",
						)}
						onclick={() => onfork("fresh")}
					>
						<Sparkles class="h-4 w-4" />
						Start fresh setup
					</button>
					<button
						type="button"
						aria-pressed={fork === "restore"}
						class={cn(
							buttonVariants({ variant: "outline" }),
							"w-full justify-start",
							fork === "restore" && "ring-2 ring-primary/40",
						)}
						onclick={() => onfork("restore")}
					>
						<ArchiveRestore class="h-4 w-4" />
						Restore a backup from another machine
					</button>
				</div>
			{:else}
				<div class="mt-4 flex-1">
					{@render children?.()}
				</div>
			{/if}

			{#if current !== "welcome"}
				<footer class="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
					<div>
						{#if prevStep}
							<button
								type="button"
								class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
								onclick={() => ongoto(prevStep.id)}
							>
								<ChevronLeft class="h-3.5 w-3.5" />
								Back
							</button>
						{/if}
					</div>
					<div>
						{#if nextStep}
							<button
								type="button"
								class={cn(buttonVariants({ variant: "default", size: "sm" }), "gap-1")}
								onclick={() => ongoto(nextStep.id)}
							>
								Next
								<ChevronRight class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
				</footer>
			{/if}
		</div>
	</div>
</div>