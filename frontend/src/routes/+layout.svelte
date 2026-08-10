<script lang="ts">
	import "./layout.css";
	import AppHeader from "$lib/components/app-header.svelte";
	import ToastContainer from "$lib/components/toast-container.svelte";
	import favicon from "$lib/assets/favicon.svg";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { settings, syncSettingsToStorage } from "$lib/stores/settings.svelte.js";
	import { TooltipProvider } from "$lib/components/ui/tooltip/index.js";

	let { children } = $props();

	$effect(() => {
		const theme = settings.theme;
		if (theme === "dark") {
			document.documentElement.classList.add("dark");
		} else if (theme === "light") {
			document.documentElement.classList.remove("dark");
		} else {
			const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
			document.documentElement.classList.toggle("dark", prefersDark);
		}
	});

	$effect(() => {
		if (settings.theme !== "system") return;
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = (e: MediaQueryListEvent) => {
			document.documentElement.classList.toggle("dark", e.matches);
		};
		mediaQuery.addEventListener("change", handler);
		return () => mediaQuery.removeEventListener("change", handler);
	});

	// Persist settings to localStorage on every change
	$effect(() => {
		void settings.theme;
		void settings.autoSave;
		void settings.reviewerName;
		syncSettingsToStorage();
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<TooltipProvider>
	<div class="flex min-h-screen flex-col">
		<AppHeader
			showBack={headerConfig.showBack}
			breadcrumb={headerConfig.breadcrumb}
			showImport={headerConfig.showImport}
			onimportclick={headerConfig.onimportclick}
			showSave={headerConfig.showSave}
			onsaveclick={headerConfig.onsaveclick}
			showExport={headerConfig.showExport}
			onexportclick={headerConfig.onexportclick}
			exportMenuItems={headerConfig.exportMenuItems ?? []}
			headerState={headerConfig.headerState ?? "dashboard"}
			class="print:hidden"
		/>
		<main id="main-content" class="flex min-h-0 flex-1 flex-col">
			{@render children()}
		</main>
	</div>

	<ToastContainer class="print:hidden" />
</TooltipProvider>
