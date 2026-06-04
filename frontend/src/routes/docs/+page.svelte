<script lang="ts">
	import DocsSidebar from "$lib/components/docs-sidebar.svelte";
	import DocsContent from "$lib/components/docs-content.svelte";
	import { headerConfig } from "$lib/stores/header.svelte.js";
	import { settings } from "$lib/stores/settings.svelte.js";

	let activeSection = $state<string | null>("getting-started");

	$effect(() => {
		headerConfig.showBack = true;
		headerConfig.breadcrumb = "Documentation";
		headerConfig.showImport = false;
		headerConfig.onimportclick = undefined;

		return () => {
			headerConfig.showBack = false;
			headerConfig.breadcrumb = undefined;
			headerConfig.showImport = false;
			headerConfig.onimportclick = undefined;
		};
	});

	let isTeacher = $derived(settings.mode === "teacher");

	let sectionIds = $derived([
		"getting-started",
		"starting-review",
		"completing-review",
		"saving",
		"importing",
		"exporting",
		"previewing",
		...(isTeacher ? ["teacher-mode", "shortcuts"] : []),
		"faq",
	]);

	let sectionLabels = $derived.by(() => {
		const all: Record<string, string> = {
			"getting-started": "Getting Started",
			"starting-review": "Starting a Review",
			"completing-review": "Completing a Review",
			saving: "Saving & Resuming",
			importing: "Importing Reviews",
			exporting: "Exporting Reviews",
			previewing: "Previewing Evaluations",
			"teacher-mode": "Teacher Mode",
			shortcuts: "Keyboard Shortcuts",
			faq: "FAQ",
		};
		const visible: Record<string, string> = {};
		for (const id of sectionIds) {
			visible[id] = all[id];
		}
		return visible;
	});

	function handleMobileNav(e: Event) {
		const target = e.target as HTMLSelectElement;
		activeSection = target.value;
		const el = document.getElementById(target.value);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	}

	$effect(() => {
		const sections = sectionIds
			.map((id) => document.getElementById(id))
			.filter((el): el is HTMLElement => el !== null);

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						activeSection = entry.target.id;
					}
				}
			},
			{ rootMargin: "-20% 0px -60% 0px" },
		);

		for (const section of sections) {
			observer.observe(section);
		}

		return () => observer.disconnect();
	});
</script>

<svelte:head>
	<title>Documentation — SciPro Review</title>
</svelte:head>

<div class="grid grid-cols-1 gap-8 px-6 py-8 md:px-10 lg:grid-cols-[16rem_1fr] lg:px-16 xl:px-24">
	<!-- Sidebar Navigation (Desktop) -->
	<aside class="hidden lg:block">
		<DocsSidebar {activeSection} />
	</aside>

	<!-- Mobile Nav -->
	<div class="mb-4 lg:hidden">
		<select
			onchange={handleMobileNav}
			class="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:ring-2 focus:ring-ring focus:outline-none"
			aria-label="Navigate to section"
		>
			{#each sectionIds as id (id)}
				<option value={id}>{sectionLabels[id]}</option>
			{/each}
		</select>
	</div>

	<!-- Documentation Content -->
	<div>
		<DocsContent />
	</div>
</div>
