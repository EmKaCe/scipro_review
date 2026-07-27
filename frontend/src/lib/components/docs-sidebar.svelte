<script lang="ts">
	import Lock from "@lucide/svelte/icons/lock";

	/** Props for the documentation sidebar navigation component. */
	interface Props {
		/** ID of the currently active/visible documentation section. */
		activeSection: string | null;
	}

	let { activeSection }: Props = $props();

	interface NavItem {
		id: string;
		label: string;
		icon?: boolean;
	}

	const navItems: NavItem[] = [
		{ id: "getting-started", label: "Getting Started" },
		{ id: "starting-review", label: "Starting a Review" },
		{ id: "completing-review", label: "Completing a Review" },
		{ id: "saving", label: "Saving & Resuming" },
		{ id: "importing", label: "Importing Reviews" },
		{ id: "exporting", label: "Exporting Reviews" },
		{ id: "previewing", label: "Previewing Evaluations" },
		{ id: "shortcuts", label: "Keyboard Shortcuts" },
		{ id: "faq", label: "FAQ" },
	];

	function handleClick(id: string, e: MouseEvent) {
		e.preventDefault();
		const el = document.getElementById(id);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	}
</script>

<nav class="sticky top-[5rem] max-h-[calc(100vh-6rem)] space-y-0.5 overflow-y-auto pr-2">
	{#each navItems as item (item.id)}
		<a
			href="#{item.id}"
			onclick={(e) => handleClick(item.id, e)}
			class="nav-link block rounded-lg py-1.5 pl-4 text-sm text-muted-foreground transition-colors hover:bg-black/[0.02] hover:text-foreground dark:hover:bg-white/[0.02] {activeSection ===
			item.id
				? 'active font-medium text-foreground'
				: ''}"
		>
			<span class="flex items-center gap-1.5">
				{item.label}
				{#if item.icon}
					<Lock size={10} class="shrink-0" />
				{/if}
			</span>
		</a>
	{/each}
</nav>

<style>
	.nav-link {
		position: relative;
	}

	.nav-link::before {
		content: "";
		position: absolute;
		left: 0;
		top: 50%;
		transform: translateY(-50%);
		width: 2px;
		height: 0;
		background: var(--primary);
		border-radius: 999px;
		transition: height 0.2s ease;
	}

	.nav-link.active::before {
		height: 1.25rem;
	}
</style>
