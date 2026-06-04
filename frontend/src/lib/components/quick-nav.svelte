<script lang="ts">
	import Save from "@lucide/svelte/icons/save";
	import Undo2 from "@lucide/svelte/icons/undo-2";
	import Redo2 from "@lucide/svelte/icons/redo-2";

	/** A category entry for quick navigation. */
	interface NavCategory {
		/** Unique key for the category. */
		key: string;
		/** Display title for the category. */
		title: string;
	}

	/** Props for the quick navigation bar with category tabs and expand/collapse toggle. */
	interface Props {
		/** All rubric categories for navigation. */
		categories: NavCategory[];
		/** ID of the currently active/visible category, or null. */
		activeId: string | null;
		/** Callback to scroll to a specific category by ID. */
		onNavigate: (id: string) => void;
		/** Callback to toggle expand/collapse state of all categories. */
		onToggleAll: () => void;
		/** Whether all categories are currently expanded. */
		allExpanded: boolean;
		/** Number of completed categories. */
		completedCount: number;
		/** Total number of categories. */
		totalCount: number;
		/** Progress percentage (0-100). */
		progressPercentage?: number;
		/** Callback to save the review. */
		onSave?: () => void;
		/** Whether save is available (for conditional rendering). */
		showSave?: boolean;
		/** Whether undo is available. */
		canUndo?: boolean;
		/** Whether redo is available. */
		canRedo?: boolean;
		/** Callback to undo. */
		onUndo?: () => void;
		/** Callback to redo. */
		onRedo?: () => void;
	}

	let {
		categories,
		activeId,
		onNavigate,
		onToggleAll,
		allExpanded,
		completedCount,
		totalCount,
		progressPercentage = 0,
		onSave,
		showSave = false,
		canUndo = false,
		canRedo = false,
		onUndo,
		onRedo,
	}: Props = $props();

	// Reference to the scrollable tab container for auto-scrolling active tab into view
	let navContainer = $state<HTMLDivElement | null>(null);

	// Auto-scroll active tab into view when activeId changes
	$effect(() => {
		if (!navContainer || !activeId) return;
		const activeBtn = navContainer.querySelector(`[aria-current="true"]`) as HTMLElement | null;
		if (activeBtn) {
			activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
		}
	});

	function handleMobileChange(e: Event) {
		const target = e.target as HTMLSelectElement;
		if (target.value) {
			onNavigate(target.value);
			target.value = "";
		}
	}
</script>

<div class="flex items-center justify-between gap-4">
	<!-- Left: Progress indicator (desktop only) -->
	<div class="hidden shrink-0 items-center gap-2 lg:flex">
		{#if totalCount && totalCount > 0}
			<div class="flex items-center gap-2">
				<span class="text-xs whitespace-nowrap text-muted-foreground"
					>{completedCount}/{totalCount}</span
				>
				<div class="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
					<div
						class="h-full rounded-full bg-primary transition-all duration-300"
						style="width: {progressPercentage}%"
					></div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Center: Quick navigation tabs / mobile select -->
	<div class="flex max-w-[50%] flex-1 items-center justify-center">
		<!-- Desktop: horizontal tabs -->
		<div
			bind:this={navContainer}
			class="no-scrollbar hidden max-w-full items-center gap-1 overflow-x-auto lg:flex"
		>
			{#each categories as cat (cat.key)}
				<button
					onclick={() => onNavigate(cat.key)}
					class="flex items-center gap-1.5 rounded-[var(--radius)] px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors {cat.key ===
					activeId
						? 'bg-primary/10 text-primary'
						: 'text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5'}"
					aria-current={cat.key === activeId ? "true" : undefined}
				>
					{cat.title}
				</button>
			{/each}
			<button
				onclick={onToggleAll}
				class="ml-1 h-8 rounded-[var(--radius)] px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
				aria-expanded={allExpanded}
			>
				{allExpanded ? "Collapse All" : "Expand All"}
			</button>
		</div>

		<!-- Mobile: select + expand/collapse -->
		<div class="flex w-full items-center gap-2 lg:hidden">
			<select
				onchange={handleMobileChange}
				class="h-9 flex-1 rounded-[var(--radius)] border border-border bg-background px-3 text-sm text-foreground focus:ring-2 focus:ring-ring focus:outline-none"
				aria-label="Jump to category"
			>
				<option value="">Jump to category...</option>
				{#each categories as cat (cat.key)}
					<option value={cat.key}>
						{cat.title}
					</option>
				{/each}
			</select>
			<button
				onclick={onToggleAll}
				class="h-8 shrink-0 rounded-[var(--radius)] px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
				aria-expanded={allExpanded}
			>
				{allExpanded ? "Collapse All" : "Expand All"}
			</button>
			{#if showSave}
				<button
					onclick={onSave}
					title="Save (Ctrl+S)"
					class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
				>
					<Save size={14} />
				</button>
			{/if}
		</div>
	</div>

	<!-- Right: Save + Undo/Redo (desktop only) -->
	<div class="hidden shrink-0 items-center gap-1 lg:flex">
		{#if onUndo}
			<button
				onclick={onUndo}
				disabled={!canUndo}
				class="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10"
				aria-label="Undo (Ctrl+Z)"
			>
				<Undo2 size={14} />
			</button>
		{/if}
		{#if onRedo}
			<button
				onclick={onRedo}
				disabled={!canRedo}
				class="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10"
				aria-label="Redo (Ctrl+Shift+Z)"
			>
				<Redo2 size={14} />
			</button>
		{/if}
		{#if showSave}
			<button
				onclick={onSave}
				title="Save (Ctrl+S)"
				class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
			>
				<Save size={14} />
				<span class="hidden sm:inline">Save (Ctrl+S)</span>
			</button>
		{/if}
	</div>
</div>
