<script lang="ts">
	import type { Snippet } from "svelte";
	import ArrowLeft from "@lucide/svelte/icons/arrow-left";
	import Sun from "@lucide/svelte/icons/sun";
	import Moon from "@lucide/svelte/icons/moon";
	import Monitor from "@lucide/svelte/icons/monitor";
	import Settings from "@lucide/svelte/icons/settings";
	import Upload from "@lucide/svelte/icons/upload";
	import Save from "@lucide/svelte/icons/save";
	import Download from "@lucide/svelte/icons/download";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { settings, setTheme } from "$lib/stores/settings.svelte.js";
	import MenuButton from "$lib/components/ui/menu-button.svelte";
	import { Button } from "$lib/components/ui/button/index.js";
	import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
	import { cn } from "$lib/utils.js";

	interface Props {
		/** Whether to show the back navigation button. */
		showBack?: boolean;
		/** Breadcrumb label displayed after the app name. E.g. "Submission: 2026SS_03" */
		breadcrumb?: string;
		/** Whether to show the save button. */
		showSave?: boolean;
		/** Callback invoked when save is clicked. */
		onsaveclick?: () => void;
		showExport?: boolean;
		/** Callback invoked when export is clicked. */
		onexportclick?: () => void;
		/** Secondary export actions (split-button menu). */
		exportMenuItems?: {
			id: string;
			label: string;
			description?: string;
			onclick: () => void;
		}[];
		/** Whether to show the import button. */
		showImport?: boolean;
		/** Callback invoked when the import button is clicked. */
		onimportclick?: () => void;
		/**
		 * Header visual state:
		 * - "dashboard": no back, "Submissions" static, no actions
		 * - "submission": back visible, "Submissions" is clickable link, actions shown
		 */
		headerState?: "dashboard" | "submission";
		/** Snippet rendered in the center of the header. */
		centerContent?: Snippet;
		/** Additional CSS class names. */
		class?: string;
	}

	let {
		showBack = false,
		breadcrumb,
		showSave = false,
		onsaveclick,
		showExport = false,
		onexportclick,
		exportMenuItems = [],
		showImport = false,
		onimportclick,
		headerState = "dashboard",
		centerContent,
		class: className = "",
	}: Props = $props();

	/** Cycle theme: light → dark → system → light */
	const themeCycle: Record<string, string> = {
		light: "dark",
		dark: "system",
		system: "light",
	};

	function toggleTheme() {
		const next = themeCycle[settings.theme] ?? "system";
		setTheme(next as "light" | "dark" | "system");
	}

	function goBack() {
		if (history.length > 1) {
			history.back();
		} else {
			goto(base || "/");
		}
	}
</script>

<header
	data-state={headerState}
	class="sticky top-0 z-40 flex h-14 items-center border-b border-border bg-background/80 px-4 backdrop-blur-md {className}"
>
	<!-- Left -->
	<div class="flex min-w-0 flex-1 items-center gap-2">
		{#if showBack}
			<button
				onclick={goBack}
				class="back-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				aria-label="Go back"
			>
				<ArrowLeft size={16} />
			</button>
		{/if}

		<a
			href={base || "/"}
			class="app-name shrink-0 text-lg font-semibold tracking-tight no-underline"
		>
			SciPro Review
		</a>

		<span class="mx-1 text-muted-foreground select-none">/</span>

		{#if headerState === "submission"}
			<!-- On per-submission page: "Submissions" is a clickable link -->
			<a
				href="{base}/submissions"
				class="breadcrumb-link truncate text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
			>
				Submissions
			</a>
			{#if breadcrumb}
				<span class="mx-1 text-muted-foreground select-none">/</span>
				<span class="breadcrumb-current truncate text-sm font-medium text-foreground"
					>{breadcrumb}</span
				>
			{/if}
		{:else}
			<!-- On dashboard: "Submissions" is static text -->
			<span class="breadcrumb-current truncate text-sm text-muted-foreground"
				>Submissions</span
			>
			{#if breadcrumb}
				<span class="mx-1 text-muted-foreground select-none">/</span>
				<span class="truncate text-sm text-muted-foreground">{breadcrumb}</span>
			{/if}
		{/if}
	</div>

	<!-- Center -->
	{#if centerContent}
		<div class="absolute left-1/2 hidden -translate-x-1/2 items-center gap-3 lg:flex">
			{@render centerContent()}
		</div>
	{/if}

	<!-- Right -->
	<div class="header-actions flex flex-1 items-center justify-end gap-1">
		{#if showSave}
			<Button
				variant="success"
				size="sm"
				title="Save (Ctrl+S)"
				onclick={onsaveclick}
				class="hidden shrink-0 sm:flex"
			>
				<Save size={14} />
				Save
			</Button>
		{/if}

		{#if showExport}
			{#snippet exportIcon()}
				<Download size={14} />
			{/snippet}
			<MenuButton
				label="Export"
				primaryOnClick={() => onexportclick?.()}
				items={exportMenuItems ?? []}
				icon={exportIcon}
				class="hidden shrink-0 sm:flex"
			/>
		{/if}

		{#if showImport}
			<Button
				variant="outline"
				size="sm"
				onclick={onimportclick}
				aria-label="Import review"
				title="Import a review (YAML or JSON)"
				class="shrink-0"
			>
				<Upload size={14} />
				<span class="hidden sm:inline">Import</span>
			</Button>
		{/if}

		<Button
			variant="ghost"
			size="icon"
			onclick={toggleTheme}
			aria-label={settings.theme === "system"
				? "System theme"
				: `Switch to ${themeCycle[settings.theme]} mode`}
			class="h-8 w-8"
		>
			{#if settings.theme === "dark"}
				<Moon size={16} />
			{:else if settings.theme === "system"}
				<Monitor size={16} />
			{:else}
				<Sun size={16} />
			{/if}
		</Button>

		<a
			href="{base}/settings"
			aria-label="Settings"
			class={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
		>
			<Settings size={16} />
		</a>
	</div>
</header>

<style>
	.breadcrumb-link:hover {
		color: var(--foreground);
	}

	/* Breadcrumb current page — bold in submission state, normal in dashboard */
	header[data-state="submission"] .breadcrumb-current {
		color: var(--foreground);
		font-weight: 500;
	}
	header[data-state="dashboard"] .breadcrumb-current {
		color: var(--muted-foreground);
		font-weight: 400;
	}

	/* App name link */
	.app-name {
		color: var(--foreground);
	}
	.app-name:hover {
		color: var(--primary);
	}

	/* Hide action buttons on dashboard state — handled via header-actions visibility */
	/* (action buttons like Export/Save only appear when headerState="submission") */
</style>
