<script lang="ts">
	import Sun from "@lucide/svelte/icons/sun";
	import Moon from "@lucide/svelte/icons/moon";
	import Monitor from "@lucide/svelte/icons/monitor";
	import { settings, setTheme } from "$lib/stores/settings.svelte.js";

	type ThemeOption = "light" | "dark" | "system";

	const themes: { value: ThemeOption; label: string; icon: typeof Sun }[] = [
		{ value: "light", label: "Light", icon: Sun },
		{ value: "dark", label: "Dark", icon: Moon },
		{ value: "system", label: "System", icon: Monitor },
	];

	function handleThemeChange(value: ThemeOption) {
		setTheme(value);
		if (value === "dark") {
			document.documentElement.classList.add("dark");
		} else if (value === "light") {
			document.documentElement.classList.remove("dark");
		} else {
			const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
			document.documentElement.classList.toggle("dark", prefersDark);
		}
	}
</script>

<div class="overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-sm">
	<div class="p-5 pb-3">
		<h2 class="text-base font-semibold tracking-tight">Appearance</h2>
		<p class="mt-1 text-sm text-muted-foreground">Choose your preferred color scheme.</p>
	</div>
	<div class="px-5 pb-5">
		<div
			class="flex items-center gap-2 rounded-[var(--radius)] border border-border bg-background p-1"
			role="radiogroup"
			aria-label="Color scheme"
		>
			{#each themes as theme (theme.value)}
				<input
					type="radio"
					name="theme"
					id="theme-{theme.value}"
					value={theme.value}
					class="theme-radio sr-only"
					checked={settings.theme === theme.value}
					onchange={() => handleThemeChange(theme.value)}
				/>
				<label
					for="theme-{theme.value}"
					class="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[calc(var(--radius)-2px)] border border-transparent text-sm font-medium text-foreground transition-all select-none hover:bg-black/5 dark:hover:bg-white/5 {settings.theme ===
					theme.value
						? 'border-primary bg-primary/10'
						: ''}"
				>
					<theme.icon size={14} />
					{theme.label}
				</label>
			{/each}
		</div>
	</div>
</div>

<style>
	.theme-radio:checked + label {
		border-color: var(--primary);
		background-color: color-mix(in oklch, var(--primary) 10%, transparent);
	}
</style>
