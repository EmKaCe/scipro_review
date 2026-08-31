<script lang="ts">
	import { base } from "$app/paths";
	import { cn } from "$lib/utils.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import ConfirmationDialog from "$lib/components/confirmation-dialog.svelte";
	import Download from "@lucide/svelte/icons/download";
	import Box from "@lucide/svelte/icons/box";
	import SkipForward from "@lucide/svelte/icons/skip-forward";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import CircleCheckBig from "@lucide/svelte/icons/circle-check-big";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
	import Ban from "@lucide/svelte/icons/ban";
	import Database from "@lucide/svelte/icons/database";

	/** Constants of the released prebuilt corpus (2.7.0 design doc §2.1). */
	const PREBUILT_MODEL = "e5-mistral-7b-instruct";
	const PREBUILT_DIM = 4096;

	/** One job as exposed by GET /api/onboarding/docs-embeddings/status. */
	interface DocsEmbedJob {
		kind: "fetch" | "embed";
		phase:
			"fetch-chunks" | "embed" | "finalize" | "done" | "failed" | "cancelled" | "interrupted";
		startedAt?: string;
		done: number;
		total: number;
		ratePerSecond?: number;
		etaSeconds?: number;
		failedBatches?: number;
		model?: string | null;
		error?: string | null;
		/** Not part of the pinned status contract — read defensively when the
		 * server includes it (the done summaries want model dims). */
		dim?: number;
	}

	type JobPhase = DocsEmbedJob["phase"];
	type RunningPhase = "fetch-chunks" | "embed" | "finalize";

	const PHASE_LABELS: Record<RunningPhase, string> = {
		"fetch-chunks": "downloading",
		embed: "embedding",
		finalize: "finalizing",
	};

	function isRunningPhase(p: JobPhase): boolean {
		return p === "fetch-chunks" || p === "embed" || p === "finalize";
	}

	function isTerminalPhase(p: JobPhase): boolean {
		return p === "done" || p === "failed" || p === "cancelled" || p === "interrupted";
	}

	function formatCount(n: number): string {
		return n.toLocaleString("en-US");
	}

	function formatEta(seconds: number): string {
		if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
		return `${Math.max(1, Math.round(seconds))} s`;
	}

	/** 629_145_600 → "600 MB". */
	function formatBytes(n: number): string {
		if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
		if (n >= 1_048_576) return `${Math.round(n / 1_048_576)} MB`;
		if (n >= 1024) return `${Math.round(n / 1024)} KB`;
		return `${Math.round(n)} B`;
	}

	/** 12_582_912 → "12 MB/s". */
	function formatRate(n: number): string {
		return `${formatBytes(n)}/s`;
	}

	interface Props {
		/** Where the card renders — drives the container look and how the
		 * rebuild confirm dialog is decided. */
		context: "onboarding" | "settings";
		/**
		 * True when a docs index (chunks + vectors) already exists on this
		 * machine. The onboarding page knows this from its checklist item;
		 * the settings page leaves it null and the card probes
		 * GET /api/onboarding/status itself (unknown → always confirm).
		 */
		indexPresent?: boolean | null;
		/** Fired once when an A/B job reaches a terminal phase or skip (C) is
		 * confirmed, so the host page can re-evaluate its own state. */
		ondone?: () => void;
	}

	let { context, indexPresent = null, ondone }: Props = $props();

	// ---------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------
	let phase = $state<"idle" | "running" | "done" | "failed">("idle");
	let choice = $state<"A" | "B" | "C" | null>(null);
	let job = $state<DocsEmbedJob | null>(null);
	let running = $state(false);
	let wasRunning = $state(false);
	let error = $state<string | null>(null);
	/** 422 no-API-key state (option B) — inline hint, C stays available. */
	let keyError = $state(false);
	/** 409 single-flight note — another tab is already running a job. */
	let conflictNote = $state(false);
	let interrupted = $state(false);
	let cancelledNote = $state(false);
	let initializing = $state(true);
	let optionsOpen = $state(false);
	let cConfirm = $state(false);
	let confirmOpen = $state(false);
	/** Set once the overwrite confirm dialog is accepted for this session. */
	let overwriteConfirmed = $state(false);
	let cancelRequested = $state(false);
	let indexPresentState = $state<boolean | null>(null);
	/** Resolved embedding model for the confirm-dialog wording (settings only). */
	let resolvedModel = $state<string | null>(null);

	const installed = $derived(
		indexPresentState === true &&
			phase === "idle" &&
			choice === null &&
			!running &&
			!conflictNote,
	);
	const showOptions = $derived(phase === "idle" && (!installed || optionsOpen));
	/** True while no job flow is mid-flight — the A/B/C options may be picked. */
	const canStartFlow = $derived(!running && phase !== "running");
	const progressPercent = $derived(
		job && job.total > 0 && job.done >= 0 ? Math.min(100, (job.done / job.total) * 100) : 0,
	);

	// ---------------------------------------------------------------------
	// Effects
	// ---------------------------------------------------------------------

	// Keep the internal view in sync with the host page's knowledge of an
	// existing index (onboarding: the checklist item flips to done after a
	// successful run).
	$effect(() => {
		if (indexPresent !== null && indexPresent !== undefined) {
			indexPresentState = indexPresent;
		}
	});

	// Restore the running state after a page reload mid-run: one status poll
	// on mount re-arms the polling loop when a job is still in flight, and
	// surfaces a persisted `interrupted` state (crash recovery §5 row 2) as
	// a retryable failure. Done/failed/cancelled leftovers are intentionally
	// NOT absorbed — the installed/options view is the honest at-rest state.
	$effect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const resp = await fetch(`${base}/api/onboarding/docs-embeddings/status`);
				if (!resp.ok) return;
				const body = (await resp.json()) as { job: DocsEmbedJob | null };
				if (cancelled) return;
				const next = body.job;
				if (next && isRunningPhase(next.phase)) {
					choice = next.kind === "embed" ? "B" : "A";
					job = next;
					phase = "running";
					running = true;
					wasRunning = true;
				} else if (next?.phase === "interrupted") {
					absorbTerminal(next);
				}
			} catch {
				// Status unreachable — stay idle; actions surface errors themselves.
			} finally {
				if (!cancelled) initializing = false;
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	// Poll every 2s while a job is active (the repo's established cadence —
	// same as the dashboard pre-eval loop). Stops at the first terminal phase.
	$effect(() => {
		if (!running) return;
		void pollStatus();
		const timer = setInterval(() => {
			void pollStatus();
		}, 2000);
		return () => clearInterval(timer);
	});

	// Settings only: resolve the configured embedding model for the overwrite
	// dialog wording (server resolver: settings → env → built-in default).
	$effect(() => {
		if (context !== "settings") return;
		let cancelled = false;
		void (async () => {
			try {
				const resp = await fetch(`${base}/api/settings`);
				if (!resp.ok) return;
				const body = (await resp.json()) as { llm?: { embeddingModel?: unknown } };
				const model = body.llm?.embeddingModel;
				if (!cancelled && typeof model === "string" && model.trim().length > 0) {
					resolvedModel = model.trim();
				}
			} catch {
				// Keep the built-in default.
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	// Settings only: probe whether a docs index already exists so the rebuild
	// confirm dialog matches §4.2 (only when vectors exist). Unknown → null →
	// B always confirms (never silently overwrite).
	$effect(() => {
		if (context !== "settings" || indexPresentState !== null) return;
		let cancelled = false;
		void (async () => {
			try {
				const resp = await fetch(`${base}/api/onboarding/status`);
				if (!resp.ok) return;
				const body = (await resp.json()) as {
					items?: { id: string; done: boolean | null }[];
				};
				const docsItem = body.items?.find((i) => i.id === "docs-index");
				if (!cancelled) indexPresentState = docsItem?.done === true;
			} catch {
				// Unknown → keep null → B always confirms (safe default).
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	// ---------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------

	function resetForStart(): void {
		phase = "running";
		job = null;
		error = null;
		keyError = false;
		conflictNote = false;
		interrupted = false;
		cancelledNote = false;
		cConfirm = false;
		cancelRequested = false;
	}

	/** Apply a terminal job observation; fires ondone once on the transition. */
	function absorbTerminal(next: DocsEmbedJob): void {
		const wasTerminal = job !== null && isTerminalPhase(job.phase);
		job = next;
		running = false;
		wasRunning = false;
		cancelRequested = false;
		conflictNote = false;
		if (next.phase === "cancelled") {
			phase = "idle";
			cancelledNote = true;
			optionsOpen = true;
			choice = null;
		} else if (next.phase === "interrupted") {
			phase = "failed";
			interrupted = true;
			choice = "B";
			error = next.error ?? "The rebuild was interrupted.";
		} else if (next.phase === "failed") {
			phase = "failed";
			interrupted = false;
			choice = choice ?? (next.kind === "fetch" ? "A" : "B");
			error = next.error ?? "The job failed — try again.";
		} else {
			phase = "done";
			error = null;
			choice = choice ?? (next.kind === "fetch" ? "A" : "B");
		}
		if (!wasTerminal) ondone?.();
	}

	async function pollStatus(): Promise<void> {
		try {
			const resp = await fetch(`${base}/api/onboarding/docs-embeddings/status`);
			if (!resp.ok) return; // keep the last good observation; next tick retries
			const body = (await resp.json()) as { job: DocsEmbedJob | null };
			const next = body.job;
			if (!next) {
				// Job vanished (cleanup raced between polls) — back to idle.
				if (wasRunning) {
					wasRunning = false;
					ondone?.();
				}
				running = false;
				job = null;
				phase = "idle";
				return;
			}
			if (isTerminalPhase(next.phase)) {
				absorbTerminal(next);
			} else {
				// Sync the choice to the adopted job's kind so the running
				// labels + cancel affordance match what is actually running
				// (matters for the mount-recovery / 409-adopt paths).
				choice = next.kind === "embed" ? "B" : "A";
				job = next;
				phase = "running";
				running = true;
				wasRunning = true;
				conflictNote = false;
				error = null;
			}
		} catch {
			// Transient — the next tick retries.
		}
	}

	function handlePostFailure(status: number, serverError: string | null): void {
		if (status === 409) {
			// Another tab owns the single-flight slot. Show the note WITHOUT
			// disturbing the running job — and start the polling loop so this
			// tab mirrors the other tab's job live instead of blocking.
			phase = "idle";
			error = null;
			conflictNote = true;
			running = true;
			return;
		}
		if (status === 422) {
			// B needs a key; C stays available.
			phase = "idle";
			error = null;
			keyError = true;
			return;
		}
		if (status === 400 && serverError && /overwrite/i.test(serverError)) {
			// The server found vectors on disk but the POST carried no
			// overwrite flag (e.g. the presence probe was stale/unknown).
			// Offer the honest confirm dialog instead of a dead-end failure.
			phase = "idle";
			error = null;
			confirmOpen = true;
			return;
		}
		phase = "failed";
		error = serverError ?? `Request failed (${status})`;
	}

	async function runJob(payload: {
		mode: "download" | "rebuild";
		overwrite?: boolean;
	}): Promise<void> {
		resetForStart();
		try {
			const resp = await fetch(`${base}/api/onboarding/docs-embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = (await resp.json().catch(() => null)) as {
				job?: DocsEmbedJob | null;
				alreadyPresent?: boolean;
				error?: string;
			} | null;
			if (!resp.ok) {
				handlePostFailure(resp.status, body?.error ?? null);
				return;
			}
			const j = body?.job ?? null;
			if (j && isTerminalPhase(j.phase)) {
				// Fast-path (e.g. already-present download) — finish immediately.
				absorbTerminal(j);
			} else if (j) {
				job = j;
				phase = "running";
				running = true;
				wasRunning = true;
				error = null;
			} else if (payload.mode === "rebuild" || payload.mode === "download") {
				// The runner writes its job state before the POST returns
				// (started:true) — adopt it via the polling loop. For a
				// download, alreadyPresent:true means nothing was fetched.
				if (payload.mode === "download" && body?.alreadyPresent === true) {
					phase = "done";
					job = null;
					error = null;
					choice = choice ?? "A";
					ondone?.();
					return;
				}
				phase = "running";
				running = true;
				error = null;
			} else {
				// Download fast-path already finished — nothing left to follow.
				phase = "done";
				job = null;
				error = null;
				choice = choice ?? "A";
				ondone?.();
			}
		} catch (err) {
			phase = "failed";
			error = err instanceof Error ? err.message : "Request failed";
		}
	}

	function handleChooseA(): void {
		if (!canStartFlow) return;
		choice = "A";
		cConfirm = false;
		void runJob({ mode: "download" });
	}

	function handleChooseB(): void {
		if (!canStartFlow) return;
		cConfirm = false;
		if (indexPresentState !== false) {
			// Vectors already exist (or unknown) — never overwrite silently.
			confirmOpen = true;
			return;
		}
		choice = "B";
		void runJob({ mode: "rebuild" });
	}

	function handleChooseC(): void {
		if (!canStartFlow) return;
		cConfirm = true;
	}

	function handleConfirmRebuild(): void {
		confirmOpen = false;
		overwriteConfirmed = true;
		choice = "B";
		void runJob({ mode: "rebuild", overwrite: true });
	}

	async function confirmSkip(): Promise<void> {
		if (!canStartFlow) return;
		resetForStart();
		choice = "C";
		phase = "running";
		cConfirm = false;
		try {
			const resp = await fetch(`${base}/api/onboarding/docs-embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "skip" }),
			});
			if (!resp.ok) {
				const body = (await resp.json().catch(() => null)) as { error?: string } | null;
				handlePostFailure(resp.status, body?.error ?? null);
				return;
			}
			phase = "done";
			job = null;
			error = null;
			ondone?.();
		} catch (err) {
			phase = "failed";
			error = err instanceof Error ? err.message : "Skip failed";
		}
	}

	async function cancelJob(): Promise<void> {
		if (!running || cancelRequested) return;
		try {
			const resp = await fetch(`${base}/api/onboarding/docs-embeddings`, {
				method: "DELETE",
			});
			if (!resp.ok) {
				const body = (await resp.json().catch(() => null)) as { error?: string } | null;
				error = body?.error ?? `Cancel failed (${resp.status})`;
				return;
			}
			cancelRequested = true; // the poll will observe phase "cancelled"
		} catch (err) {
			error = err instanceof Error ? err.message : "Cancel failed";
		}
	}

	function retry(): void {
		if (phase !== "failed") return;
		if (choice === "A") {
			void runJob({ mode: "download" });
		} else if (choice === "B") {
			// A retry after a confirmed overwrite keeps the sanction (the
			// earlier failed run never replaced anything); a fresh build with
			// no existing index never needs the flag.
			void runJob({
				mode: "rebuild",
				...(overwriteConfirmed ? { overwrite: true } : {}),
			});
		}
	}
</script>

<div
	class={cn(
		"rounded-[var(--radius)] border border-border",
		context === "settings" ? "bg-card p-5 shadow-sm" : "bg-muted/40 p-3",
	)}
>
	{#if context === "settings"}
		<h3 class="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
			<Database class="h-4 w-4 text-primary" />
			Docs index — semantic search vectors
		</h3>
		<p class="mt-1 mb-3 text-xs text-muted-foreground">
			Choose how the semantic docs-search leg is set up. BM25 exact-API search works without
			any of this.
		</p>
	{/if}

	{#if initializing}
		<p class="text-xs text-muted-foreground">Checking docs index…</p>
	{:else if phase === "running" || running}
		<div class="space-y-2">
			<div class="flex flex-wrap items-center gap-2">
				<span class="inline-flex items-center gap-1.5 text-sm text-foreground">
					<LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
					{#if choice === "C"}
						<span>Saving your choice…</span>
					{:else if job?.kind === "fetch" || choice === "A"}
						<span>Downloading prebuilt vectors…</span>
					{:else}
						<span>Building vectors locally…</span>
					{/if}
				</span>
				{#if job && isRunningPhase(job.phase)}
					<span
						class="rounded-full border border-primary/30 bg-primary/10 px-2 py-px text-[10px] font-semibold tracking-wide text-primary uppercase"
					>
						{PHASE_LABELS[job.phase as RunningPhase] ?? job.phase}
					</span>
				{/if}
			</div>
			{#if job && job.total > 0}
				<p class="font-mono text-xs text-muted-foreground">
					{#if job.kind === "fetch"}
						downloaded {formatBytes(job.done)} / {formatBytes(job.total)}
					{:else}
						embedded {formatCount(job.done)} / {formatCount(job.total)}
					{/if}
					{#if job.ratePerSecond != null && job.ratePerSecond > 0}
						<span>
							· {job.kind === "fetch"
								? formatRate(job.ratePerSecond)
								: `${job.ratePerSecond.toFixed(1)} texts/s`}
						</span>
					{/if}
					{#if job.etaSeconds != null && job.etaSeconds > 0}
						<span> · ETA {formatEta(job.etaSeconds)}</span>
					{/if}
				</p>
				<div
					class="h-1.5 w-full overflow-hidden rounded-full bg-muted"
					role="progressbar"
					aria-valuenow={Math.round(progressPercent)}
					aria-valuemin={0}
					aria-valuemax={100}
				>
					<div
						class="h-full rounded-full bg-primary transition-all duration-500"
						style:width="{progressPercent}%"
					></div>
				</div>
			{/if}
			{#if error}
				<p class="text-xs text-destructive">{error}</p>
			{/if}
			{#if choice === "B" || choice === "A"}
				<button
					type="button"
					class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
					disabled={cancelRequested}
					onclick={() => void cancelJob()}
				>
					{#if cancelRequested}
						<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						Cancelling…
					{:else}
						<Ban class="h-3.5 w-3.5" />
						Cancel
					{/if}
				</button>
			{/if}
		</div>
	{:else if phase === "done"}
		{#if choice === "C"}
			<div class="flex items-start gap-2">
				<SkipForward class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
				<div class="min-w-0 flex-1">
					<p class="text-sm text-foreground">Semantic leg disabled — BM25-only</p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						BM25 finds exact API names; paraphrase queries weaken;
						<strong>no API key needed</strong> for the docs leg.
					</p>
					<div class="mt-2">
						<button
							type="button"
							class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
							onclick={() => {
								phase = "idle";
								choice = null;
								optionsOpen = true;
							}}
						>
							Change mind
						</button>
					</div>
				</div>
			</div>
		{:else}
			<div class="flex items-start gap-2">
				<CircleCheckBig class="mt-0.5 h-4 w-4 shrink-0 text-success" />
				<div class="min-w-0 flex-1">
					<p class="text-sm text-foreground">
						{#if choice === "B"}
							Vectors rebuilt with your model
						{:else}
							Prebuilt vectors downloaded
						{/if}
					</p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						{#if choice === "B"}
							{job?.model ?? "your configured model"}{job?.dim != null
								? ` · ${job.dim}-dim`
								: ""}
						{:else}
							{PREBUILT_MODEL} · {job?.dim ?? PREBUILT_DIM}-dim
						{/if}
					</p>
					{#if (job?.failedBatches ?? 0) > 0}
						<p class="mt-1 flex items-start gap-1.5 text-[11px] text-warning">
							<CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
							<span>
								{job?.failedBatches} batch(es) with unexpected dimensions — zero-filled
								in the index.
							</span>
						</p>
					{/if}
					<div class="mt-2">
						<button
							type="button"
							class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
							onclick={() => {
								phase = "idle";
								choice = null;
								job = null;
								optionsOpen = true;
							}}
						>
							<RotateCcw class="h-3.5 w-3.5" />
							{#if (job?.failedBatches ?? 0) > 0}
								Rebuild with a different model
							{:else}
								Reconfigure
							{/if}
						</button>
					</div>
				</div>
			</div>
		{/if}
	{:else if phase === "failed"}
		<div class="flex items-start gap-2">
			<CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
			<div class="min-w-0 flex-1">
				<p class="text-sm text-foreground">
					{interrupted
						? "The rebuild was interrupted"
						: "Could not set up the docs index"}
				</p>
				{#if error}
					<p class="mt-0.5 text-xs text-destructive">{error}</p>
				{/if}
				{#if interrupted}
					<p class="mt-1 text-[11px] text-muted-foreground">
						{choice === "A"
							? "The download was interrupted — the staging files are cleaned automatically on the next attempt."
							: "Your existing index (if any) is untouched — stale staging files are cleaned automatically on the next attempt."}
					</p>
				{/if}
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<button
						type="button"
						class={cn(buttonVariants({ variant: "default", size: "sm" }), "gap-1")}
						onclick={retry}
					>
						<RotateCcw class="h-3.5 w-3.5" />
						{interrupted
							? choice === "A"
								? "Retry download"
								: "Retry rebuild"
							: "Retry"}
					</button>
					<button
						type="button"
						class={cn(buttonVariants({ variant: "outline", size: "sm" }))}
						onclick={() => {
							phase = "idle";
							choice = null;
							error = null;
							interrupted = false;
							optionsOpen = true;
						}}
					>
						Choose another option
					</button>
				</div>
			</div>
		</div>
	{:else}
		{#if conflictNote}
			<p
				class="mb-2 flex items-start gap-1.5 text-[11px] text-muted-foreground"
				role="status"
			>
				<CircleAlert class="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
				<span
					>A docs-index download/rebuild is already running — open this page in another
					tab?</span
				>
			</p>
		{/if}
		{#if cancelledNote}
			<p class="mb-2 text-xs text-muted-foreground" role="status">
				Cancelled — nothing was changed.
			</p>
		{/if}
		{#if installed && !optionsOpen}
			<div class="flex flex-wrap items-center justify-between gap-2">
				<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<CircleCheckBig class="h-3.5 w-3.5 shrink-0 text-success" />
					<span
						>Semantic vectors are installed — search uses BM25 + vector retrieval.</span
					>
				</p>
				<button
					type="button"
					class={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
					onclick={() => (optionsOpen = true)}
				>
					Reconfigure
				</button>
			</div>
		{/if}
		{#if showOptions}
			{#if keyError}
				<p class="mb-2 flex items-start gap-1.5 text-[11px] text-warning" role="status">
					<CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
					<span>set your API key in the LLM provider step above, or in `.env`</span>
				</p>
			{/if}
			<div class="space-y-1.5" role="group" aria-label="Docs index setup options">
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent"
					aria-label="A — Download prebuilt vectors"
					onclick={handleChooseA}
				>
					<span
						class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-semibold text-muted-foreground"
						aria-hidden="true"
					>
						A
					</span>
					<span class="min-w-0 flex-1">
						<span class="block text-sm font-medium text-foreground"
							>Download prebuilt vectors</span
						>
						<span class="block text-[11px] text-muted-foreground"
							>e5-mistral-7b-instruct · 4096-dim · no API key needed</span
						>
					</span>
					<Download class="h-4 w-4 shrink-0 text-muted-foreground" />
				</button>
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent"
					aria-label="B — Build vectors locally"
					onclick={handleChooseB}
				>
					<span
						class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-semibold text-muted-foreground"
						aria-hidden="true"
					>
						B
					</span>
					<span class="min-w-0 flex-1">
						<span class="block text-sm font-medium text-foreground"
							>Build vectors locally</span
						>
						<span class="block text-[11px] text-muted-foreground"
							>Uses your configured endpoint + model · API key required</span
						>
					</span>
					<Box class="h-4 w-4 shrink-0 text-muted-foreground" />
				</button>
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent"
					aria-label="C — Skip vectors, BM25 only"
					onclick={handleChooseC}
				>
					<span
						class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-semibold text-muted-foreground"
						aria-hidden="true"
					>
						C
					</span>
					<span class="min-w-0 flex-1">
						<span class="block text-sm font-medium text-foreground"
							>Skip vectors — BM25 only</span
						>
						<span class="block text-[11px] text-muted-foreground"
							>Exact API names still found; paraphrase queries weaken · no API key
							needed</span
						>
					</span>
					<SkipForward class="h-4 w-4 shrink-0 text-muted-foreground" />
				</button>
			</div>
			{#if cConfirm}
				<div
					class="mt-2 space-y-2 rounded-[var(--radius)] border border-border bg-background p-3"
				>
					<p class="text-xs text-muted-foreground">
						Skip the semantic vector leg? BM25 still finds exact API names (curve_fit,
						np.polyfit); paraphrase queries like “fit a curve to data” weaken.
						<strong>No API key needed</strong> for the docs leg.
					</p>
					<div class="flex flex-wrap items-center gap-2">
						<button
							type="button"
							class={cn(buttonVariants({ variant: "default", size: "sm" }))}
							onclick={() => void confirmSkip()}
						>
							Confirm skip
						</button>
						<button
							type="button"
							class={cn(buttonVariants({ variant: "outline", size: "sm" }))}
							onclick={() => (cConfirm = false)}
						>
							Keep options
						</button>
					</div>
				</div>
			{/if}
		{/if}
	{/if}
</div>

<ConfirmationDialog
	open={confirmOpen}
	title="Rebuild semantic vectors?"
	message={`Rebuilding replaces your current vectors (≈ 629 MB) with ${resolvedModel ?? PREBUILT_MODEL}. Retrieval serves from the old vectors until the swap completes, then switches atomically. A failed rebuild leaves the old index intact. This run costs ~10–30 min of embedding API calls.`}
	confirmLabel="Start rebuild"
	onconfirm={handleConfirmRebuild}
	oncancel={() => (confirmOpen = false)}
/>
