<script lang="ts">
	import { toasts, removeToast, exitingToasts } from "$lib/stores/toast.svelte.js";
	import CheckCircle from "@lucide/svelte/icons/check-circle";
	import XCircle from "@lucide/svelte/icons/x-circle";
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import Info from "@lucide/svelte/icons/info";
	import type { Component } from "svelte";
	import type { ToastType } from "$lib/types/index.js";

	interface Props {
		/** Additional CSS class names. */
		class?: string;
	}

	let { class: className = "" }: Props = $props();

	const iconMap: Record<ToastType, Component> = {
		success: CheckCircle,
		error: XCircle,
		warning: AlertTriangle,
		info: Info,
	};

	const colorMap: Record<ToastType, string> = {
		success: "text-success",
		error: "text-error",
		warning: "text-warning",
		info: "text-info",
	};

	const borderMap: Record<ToastType, string> = {
		success: "border-success/20",
		error: "border-error/20",
		warning: "border-warning/20",
		info: "border-info/20",
	};
</script>

<div
	class="toast-container pointer-events-none fixed top-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 {className}"
	role="status"
	aria-live="polite"
	aria-label="Notifications"
>
	{#each toasts as toast (toast.id)}
		{@const Icon = iconMap[toast.type]}
		{@const isExiting = exitingToasts.has(toast.id)}
		<div
			class="pointer-events-auto flex items-start gap-3 rounded-[var(--radius)] border bg-card p-3 shadow-sm {isExiting
				? 'toast-exit'
				: 'toast-enter'} {borderMap[toast.type]}"
		>
			<Icon size={18} class="mt-0.5 shrink-0 {colorMap[toast.type]}" />
			<p class="flex-1 text-sm leading-relaxed text-foreground">{toast.message}</p>
			<button
				onclick={() => removeToast(toast.id)}
				class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
				aria-label="Dismiss"
			>
				<XCircle size={14} />
			</button>
		</div>
	{/each}
</div>

<style>
	@keyframes slideInRight {
		from {
			transform: translateX(100%);
			opacity: 0;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}

	@keyframes fadeOut {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}

	.toast-enter {
		animation: slideInRight 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
	}

	.toast-exit {
		animation: fadeOut 0.2s ease-in forwards;
	}
</style>
