<script lang="ts">
	/**
	 * @file Settings card — a read-only "configuration map" indexing every
	 * configurable across the six configuration surfaces, where it lives, and
	 * where each is edited. Keeps the settings page scannable instead of a
	 * wall of fields.
	 *
	 * The six surfaces:
	 *   1. Environment variables  (deployment; restart to apply)
	 *   2. data/settings.yaml     (edited on this page → Execution & AI)
	 *   3. data/grading_config.yaml (edited on this page → Grading)
	 *   4. Assignment editor      (per-assignment; NOT on the settings page)
	 *   5. localStorage           (browser; edited on this page → Appearance)
	 *   6. Code constants         (read-only; edit source + rebuild)
	 *
	 * Reload semantics: surfaces 2 & 3 are read fresh, so a save applies hot.
	 * Env vars and code constants need a restart. LLM endpoint/model changes
	 * apply on the next LLM request; the copilot agent's held model may need
	 * a restart.
	 */

	type SurfaceKey = "env" | "settings" | "grading" | "assignment" | "local" | "code";
	type BadgeTone = "warning" | "success" | "primary" | "muted";

	interface MapRow {
		name: string;
		description: string;
		affordance: string;
		/** Swap the affordance text for a muted "not editable here" caveat. */
		note?: string;
		secret?: boolean;
	}

	interface MapSection {
		surface: string;
		key: SurfaceKey;
		intro?: string;
		rows: MapRow[];
	}

	const toneClass: Record<SurfaceKey, BadgeTone> = {
		env: "warning",
		settings: "success",
		grading: "success",
		assignment: "primary",
		local: "muted",
		code: "muted",
	};

	const SECTIONS: MapSection[] = [
		{
			surface: "Environment variables",
			key: "env",
			intro: "Deployment-level. Set in the environment / .env — requires a restart to apply.",
			rows: [
				{
					name: "DATA_DIR",
					description: "Data root for all runtime config and state (e.g. /app/data in Docker).",
					affordance: "Set in the environment / .env",
					note: "Not editable here.",
				},
				{
					name: "DOCS_INDEX_DIR",
					description: "Docs-RAG index directory (docs-index.json + vectors).",
					affordance: "Set in the environment / .env",
					note: "Not editable here.",
				},
				{
					name: "ORIGIN",
					description: "Canonical origin URL of the deployment.",
					affordance: "Set in the environment / .env",
					note: "Not editable here.",
				},
				{
					name: "PRE_EVAL_CRITIQUE",
					description: "Set to 0 to disable the pre-evaluation critique pass (cost/quality toggle).",
					affordance: "Set in the environment / .env",
					note: "Not editable here.",
				},
				{
					name: "KI_CONNECT_BASE_URL",
					description: "KI Connect base URL fallback. Also overridable in settings.yaml below.",
					affordance: "Env, or this page → Execution & AI",
				},
				{
					name: "KI_CONNECT_API_KEY",
					description: "KI Connect bearer token. Stored in the server process only — never sent back to the browser.",
					affordance: "This page → Execution & AI",
					note: "Secret — masked; not readable.",
					secret: true,
				},
			],
		},
		{
			surface: "data/settings.yaml",
			key: "settings",
			intro: "App-level runtime settings. Read fresh on every request, so a save applies immediately.",
			rows: [
				{
					name: "Executor timeouts",
					description: "Request / per-notebook / per-cell execution budgets.",
					affordance: "This page → Execution & AI",
				},
				{
					name: "LLM provider",
					description: "Base URL, model, request timeout. Applies on the next LLM request; the copilot agent may need a restart.",
					affordance: "This page → Execution & AI",
				},
				{
					name: "Copilot",
					description: "Approval mode, allowed/deny tools, approval TTL, session cap, recall window, auto-compact.",
					affordance: "This page → Execution & AI",
				},
			],
		},
		{
			surface: "data/grading_config.yaml",
			key: "grading",
			intro: "Global grading config shared across all assignments. Read fresh on grading-page load.",
			rows: [
				{
					name: "Dimensions",
					description: "Global grading dimensions (key / title / max_points / weight).",
					affordance: "This page → Grading",
				},
				{
					name: "Grade boundaries",
					description: "Percentage → German grade / label / US equivalent bands.",
					affordance: "This page → Grading",
				},
			],
		},
		{
			surface: "Assignment editor",
			key: "assignment",
			intro: "Per-assignment config. Per the app-vs-assignment rule these live in the assignment editor, NOT on the settings page.",
			rows: [
				{
					name: "Rubric criteria",
					description: "Per-assignment criteria (data/criteria/<id>.yaml).",
					affordance: "Assignment editor → Criteria",
				},
				{
					name: "Scoring config",
					description: "Calibration anchors, evidence regexes, disallowed libraries, dimension guidance (data/scoring/<id>.yaml).",
					affordance: "Assignment editor → Scoring",
				},
				{
					name: "Assignment metadata",
					description: "Registry entry, dimensions, enabled state, materials (data/assignments.yaml).",
					affordance: "Assignment editor",
				},
			],
		},
		{
			surface: "localStorage",
			key: "local",
			intro: "Browser-only, per-device preferences (scipro-settings). Not shared or synced.",
			rows: [
				{
					name: "Appearance",
					description: "Color scheme (light / dark / system) and autosave preference.",
					affordance: "This page → Appearance",
				},
			],
		},
		{
			surface: "Code constants",
			key: "code",
			intro: "Read-only. Changing these means editing the source (or an env var) and rebuilding / restarting.",
			rows: [
				{
					name: "Prompt-injection threshold 0.7",
					description: "PromptInjectionDetector threshold.",
					affordance: "src/lib/server/copilot/agent.ts",
					note: "Code constant.",
				},
				{
					name: "KI Connect concurrency 2",
					description: "Empirically safe parallel LLM ceiling.",
					affordance: "src/routes/api/submissions/pre-evaluate/+server.ts",
					note: "Code constant.",
				},
				{
					name: "TEXTAREA_MIN_CHARS 20",
					description: "Minimum textarea length before evidence-fill kicks in.",
					affordance: "src/lib/server/copilot/post-process.ts",
					note: "Code constant.",
				},
				{
					name: "Rich-output caps",
					description: "RICH_OUTPUT_MAX_IMAGE_BYTES (5 MB) / RICH_OUTPUT_MAX_HTML_CHARS (200k).",
					affordance: "Set in the environment / .env (executor/runner.py)",
					note: "Env-driven default.",
				},
			],
		},
	];
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="p-5 pb-3">
		<h2 class="text-base font-semibold tracking-tight">Configuration map</h2>
		<p class="mt-1 text-sm text-muted-foreground">
			Where every setting lives, and where to change it. A no-op save never touches disk; settings are read
			fresh on load.
		</p>
	</div>

	<div class="space-y-5 px-5 pb-5">
		{#each SECTIONS as section (section.surface)}
			<div>
				<div class="mb-2 flex items-center gap-2">
					<span
						class:cfg-badge-warning={toneClass[section.key] === "warning"}
						class:cfg-badge-success={toneClass[section.key] === "success"}
						class:cfg-badge-primary={toneClass[section.key] === "primary"}
						class:cfg-badge-muted={toneClass[section.key] === "muted"}
						class="cfg-badge"
					>
						{section.surface}
					</span>
				</div>
				{#if section.intro}
					<p class="mb-2 text-xs text-muted-foreground">{section.intro}</p>
				{/if}
				<div class="divide-y divide-border rounded-[var(--radius)] border border-border bg-background">
					{#each section.rows as row (row.name)}
						<div class="flex items-start justify-between gap-4 px-3 py-2">
							<div class="min-w-0">
								<p
									class="font-mono text-xs font-medium text-foreground {row.secret
										? 'flex items-center gap-1.5'
										: ''}"
								>
									{row.name}
									{#if row.secret}
										<span class="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-px text-[10px] text-warning">
											secret
										</span>
									{/if}
								</p>
								<p class="mt-0.5 text-xs text-muted-foreground">{row.description}</p>
							</div>
							<div class="shrink-0 text-right">
								<p class="text-xs font-medium text-foreground">{row.affordance}</p>
								{#if row.note}
									<p class="mt-0.5 text-[11px] text-muted-foreground">{row.note}</p>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/each}
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
	.cfg-badge-muted {
		color: var(--muted-foreground);
		border-color: color-mix(in oklch, var(--fg) 14%, transparent);
		background: color-mix(in oklch, var(--fg) 5%, transparent);
	}
</style>
