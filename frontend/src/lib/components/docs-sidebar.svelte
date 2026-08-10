<script lang="ts">
	/** Props for the documentation sidebar navigation component. */
	interface Props {
		/** ID of the currently active/visible documentation section. */
		activeSection: string | null;
	}

	let { activeSection }: Props = $props();

	interface NavItem {
		id: string;
		label: string;
	}

	const navItems: NavItem[] = [
		{ id: "getting-started", label: "Getting Started" },
		{ id: "configuration", label: "Configuration" },
		{ id: "uploading", label: "Uploading Submissions" },
		{ id: "pipeline", label: "Running the Pipeline" },
		{ id: "grading", label: "Grading Workflow" },
		{ id: "copilot", label: "AI Copilot" },
		{ id: "backup", label: "Backup & Restore" },
		{ id: "troubleshooting", label: "Troubleshooting" },
		{ id: "deployment", label: "Deployment" },
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
