<script lang="ts">
	/**
	 * @file Settings card — LIVE configuration inventory, fed by
	 * GET /api/config/map (the A1 aggregation endpoint). Groups config by
	 * *purpose* (settings / assignment / deploy) rather than by raw surface,
	 * so the "Configuration map" reads as "nearly everything is here on this
	 * page" — and every value shown is the actual running value, read fresh
	 * from the server on mount and on manual refresh.
	 *
	 * Row rendering rules (per plan A2):
	 * - File-backed editable rows (settings.yaml / grading_config.yaml) show
	 *   the live value and link to their owning editor card on this page via
	 *   an anchor (#execution-ai / #grading) — editors are NOT duplicated
	 *   here (drift risk).
	 * - Env rows (deploy group) show the live value + "restart to apply".
	 * - Secret row (llm.api_key) shows "••••" + a presence badge; the real
	 *   key is never rendered (the endpoint masks it).
	 * - Assignment rows deep-link to the assignment editor
	 *   (${base}/settings/assignments/<id>).
	 * - The "code" group (engineering constants) is deliberately NOT rendered
	 *   — those constants moved to the README table (task A3).
	 */

	import { base } from "$app/paths";
	import Loader from "@lucide/svelte/icons/loader";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
	import Link2 from "@lucide/svelte/icons/link-2";

	type GroupKey = "settings" | "assignment" | "deploy";
	type BadgeTone = "warning" | "success" | "primary" | "muted";

	interface ConfigMapRow {
		id: string;
		group: GroupKey | "code";
		name: string;
		description: string;
		value: string | null;
		source: string;
		status: "ok" | "unset" | "env-fallback" | "readonly" | "secret-set";
		affordance: "this-page" | "assignment-editor" | "env-file" | "none";
		reload: "hot" | "next-request" | "restart";
		secret?: boolean;
	}

	interface ConfigMapResponse {
		rows: ConfigMapRow[];
		generatedAt: string;
	}

	interface MapSection {
		surface: string;
		key: GroupKey;
		intro?: string;
		rows: ConfigMapRow[];
	}

	/** Group order in the UI (code rows are filtered out entirely). */
	const GROUP_ORDER: GroupKey[] = ["settings", "assignment", "deploy"];

	const toneClass: Record<GroupKey, BadgeTone> = {
		settings: "success",
		assignment: "primary",
		deploy: "warning",
	};

	const reloadLabel: Record<ConfigMapRow["reload"], string> = {
		hot: "Applies immediately",
		"next-request": "Applies on the next LLM request",
		restart: "Restart required",
	};

	/** Anchor on the settings page owning this file-backed row's editor. */
	const ownerAnchor: Record<string, string> = {
		"settings.yaml": "#execution-ai",
		grading_config_yaml: "#grading",
	};

	let rows = $state<ConfigMapRow[]>([]);
	let generatedAt = $state<string | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let loadError = $state<string | null>(null);

	async function loadMap() {
		try {
			const res = await fetch(`${base}/api/config/map`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as ConfigMapResponse;
			rows = body.rows;
			generatedAt = body.generatedAt;
			loadError = null;
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Failed to load";
			rows = [];
			generatedAt = null;
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	$effect(() => {
		void loadMap();
	});

	async function refresh() {
		refreshing = true;
		await loadMap();
	}

	/** Purpose-grouped sections derived from the response (code group dropped). */
	const sections = $derived.by(() => {
		const byGroup: Record<GroupKey, ConfigMapRow[]> = {
			settings: [],
			assignment: [],
			deploy: [],
		};
		for (const row of rows) {
			if (row.group === "code") continue; // README table territory (A3)
			byGroup[row.group as GroupKey]?.push(row);
		}
		return GROUP_ORDER.map((key): MapSection => {
			const sectionRows = byGroup[key] ?? [];
			switch (key) {
				case "settings":
					return {
						surface: "Settings page",
						key,
						intro: "Almost everything is edited here, in one place. Values below are live — loaded from the server, so a save on this page shows up here after refresh.",
						rows: sectionRows,
					};
				case "assignment":
					return {
						surface: "Assignment editor",
						key,
						intro: "Per-assignment content. Per the app-vs-assignment rule these live in the assignment editor, NOT on the settings page.",
						rows: sectionRows,
					};
				case "deploy":
					return {
						surface: "Deployment environment",
						key,
						intro: "Set once when standing up the server; requires a restart to apply.",
						rows: sectionRows,
					};
			}
		});
	});

	function statusBadgeClass(row: ConfigMapRow): string {
		if (row.secret) {
			return row.status === "secret-set"
				? "rounded-full border border-success/30 bg-success/10 px-1.5 py-px text-[10px] font-medium text-success"
				: "rounded-full border border-warning/30 bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning";
		}
		if (row.status === "unset") {
			return "rounded-full border border-warning/30 bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning";
		}
		return "rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground";
	}

	function statusBadgeLabel(row: ConfigMapRow): string {
		if (row.secret) return row.status === "secret-set" ? "set" : "unset";
		return row.status;
	}

	function ownerHref(row: ConfigMapRow): string | null {
		if (row.affordance !== "this-page") return null;
		const key = row.source === "grading_config.yaml" ? "grading_config_yaml" : row.source;
		return ownerAnchor[key] ?? null;
	}

	/**
	 * Where the row's value can be changed, as an anchor when the affordance
	 * is an in-page card or the assignment editor; otherwise plain text.
	 */
	function rowAffordance(row: ConfigMapRow): { href: string | null; label: string } {
		if (row.affordance === "assignment-editor") {
			const target =
				row.id === "assignment.none"
					? `${base}/settings/assignments`
					: `${base}/settings/assignments/${row.value}`;
			return { href: target, label: "Assignment editor" };
		}
		if (row.affordance === "this-page") {
			const href = ownerHref(row);
			return {
				href,
				label: href === "#execution-ai" ? "Edit — Execution & AI" : "Edit — Grading",
			};
		}
		return { href: null, label: "Environment / .env" };
	}

	/** Muted caveat under the affordance (never an editor). */
	function rowNote(row: ConfigMapRow): string | null {
		if (row.secret) {
			return "Secret — masked; not readable.";
		}
		if (row.affordance === "env-file") {
			return "Set in .env / environment — restart to apply.";
		}
		if (row.affordance === "this-page") {
			return "Saved on this page.";
		}
		return null;
	}

	function formatTimestamp(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="p-5 pb-3">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<h2 class="text-base font-semibold tracking-tight">Configuration map</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					Where every setting lives, and where to change it — grouped by purpose. Values
					are live, loaded from the server; use Refresh to re-check after saving
					elsewhere.
				</p>
			</div>
			<button
				type="button"
				class="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
				disabled={loading || refreshing}
				onclick={refresh}
			>
				{#if refreshing}
					<Loader size={13} class="animate-spin" />
				{:else}
					<RefreshCw size={13} />
				{/if}
				Refresh
			</button>
		</div>
		{#if generatedAt}
			<p class="mt-1.5 text-xs text-muted-foreground">
				Last checked: {formatTimestamp(generatedAt)}
			</p>
		{/if}
	</div>

	<div class="space-y-5 px-5 pb-5">
		{#if loading}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader size={14} class="animate-spin" /> Loading configuration map…
			</p>
		{:else if loadError}
			<p class="text-sm text-muted-foreground">
				Could not load configuration map ({loadError}).
			</p>
		{:else if sections.length === 0 || sections.every((s) => s.rows.length === 0)}
			<p class="text-sm text-muted-foreground">No configuration to show.</p>
		{:else}
			{#each sections as section (section.surface)}
				{#if section.rows.length > 0}
					<div>
						<div class="mb-2 flex items-center gap-2">
							<span
								class:cfg-badge-warning={toneClass[section.key] === "warning"}
								class:cfg-badge-success={toneClass[section.key] === "success"}
								class:cfg-badge-primary={toneClass[section.key] === "primary"}
								class="cfg-badge"
							>
								{section.surface}
							</span>
						</div>
						{#if section.intro}
							<p class="mb-2 text-xs text-muted-foreground">{section.intro}</p>
						{/if}
						<div
							class="divide-y divide-border rounded-[var(--radius)] border border-border bg-background"
						>
							{#each section.rows as row (row.id)}
								{@const affordance = rowAffordance(row)}
								{@const note = rowNote(row)}
								<div class="flex items-start justify-between gap-4 px-3 py-2">
									<div class="min-w-0">
										<p
											class="font-mono text-xs font-medium text-foreground {row.secret
												? 'flex items-center gap-1.5'
												: ''}"
										>
											{row.name}
											{#if row.secret}
												<span class={statusBadgeClass(row)}>
													{statusBadgeLabel(row)}
												</span>
											{:else if row.status === "unset"}
												<span class={statusBadgeClass(row)}>
													{statusBadgeLabel(row)}
												</span>
											{/if}
										</p>
										<p class="mt-0.5 text-xs text-muted-foreground">
											{row.description}
										</p>
									</div>
									<div class="max-w-[45%] shrink-0 text-right">
										<p class="text-xs font-medium text-foreground">
											{#if affordance.href}
												<a
													href={affordance.href}
													class="inline-flex items-center gap-1 text-primary no-underline transition-colors hover:text-primary/80"
												>
													<Link2 size={11} />
													{affordance.label}
													<ArrowUpRight size={11} />
												</a>
											{:else}
												{affordance.label}
											{/if}
										</p>
										{#if row.value !== null}
											<p
												class="mt-1 truncate font-mono text-[11px] text-muted-foreground"
												title={row.value}
											>
												{row.value}
											</p>
										{/if}
										{#if note}
											<p class="mt-0.5 text-[11px] text-muted-foreground">
												{note}
											</p>
										{/if}
										<p class="mt-0.5 text-[11px] text-muted-foreground">
											{reloadLabel[row.reload]}
										</p>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</div>

<style>
	.cfg-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border-radius: 9999px;
		border: 1px solid var(--border);
		padding: 2px 10px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
	}
	.cfg-badge-warning {
		color: var(--warning);
		border-color: color-mix(in oklch, var(--warning) 30%, transparent);
		background: color-mix(in oklch, var(--warning) 10%, transparent);
	}
	.cfg-badge-success {
		color: var(--success);
		border-color: color-mix(in oklch, var(--success) 30%, transparent);
		background: color-mix(in oklch, var(--success) 10%, transparent);
	}
	.cfg-badge-primary {
		color: var(--primary);
		border-color: color-mix(in oklch, var(--primary) 30%, transparent);
		background: color-mix(in oklch, var(--primary) 10%, transparent);
	}
</style>
