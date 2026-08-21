<script lang="ts">
	import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
	import X from "@lucide/svelte/icons/x";
	import Check from "@lucide/svelte/icons/check";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Tooltip, TooltipTrigger, TooltipContent } from "$lib/components/ui/tooltip/index.js";

	/** Props for the confirmation dialog modal component. */
	interface Props {
		/** Whether the dialog is currently visible. */
		open: boolean;
		/** Dialog title text. */
		title: string;
		/** Dialog body message. */
		message: string;
		/** Label for the confirm button (default: "Confirm"). */
		confirmLabel?: string;
		/** Visual variant — "danger" uses destructive styling. */
		variant?: "danger" | "default";
		/** If set, user must type this exact string before confirming. */
		requireTyping?: string;
		/** Callback invoked when the user confirms the action. */
		onconfirm: () => void;
		/** Callback invoked when the user cancels the dialog. */
		oncancel: () => void;
	}

	let {
		open,
		title,
		message,
		confirmLabel = "Confirm",
		variant = "default",
		requireTyping,
		onconfirm,
		oncancel,
	}: Props = $props();

	let dialogRef: HTMLDivElement | undefined = $state();
	let typingValue = $state("");
	/** Element focused before the dialog opened — focus returns here on close. */
	let previouslyFocused: HTMLElement | null = null;

	$effect(() => {
		if (open) typingValue = "";
	});

	$effect(() => {
		if (open) {
			// Remember the trigger so focus can be restored on close (WCAG 2.1 AA 2.4.3).
			previouslyFocused = document.activeElement as HTMLElement | null;
			if (dialogRef) {
				const focusable = dialogRef.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
				);
				if (focusable.length > 0) {
					focusable[0].focus();
				} else {
					dialogRef.focus();
				}
			}
		} else if (previouslyFocused) {
			previouslyFocused.focus();
			previouslyFocused = null;
		}
	});

	let canConfirm = $derived(!requireTyping || typingValue === requireTyping);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			oncancel();
			return;
		}
		if (e.key === "Tab" && dialogRef) {
			const focusable = dialogRef.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	function handleConfirm() {
		if (canConfirm) onconfirm();
	}
	function handleOverlayClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			oncancel();
		}
	}
</script>

{#if open}
	<div
		bind:this={dialogRef}
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="confirm-dialog-title"
		aria-describedby="confirm-dialog-desc"
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm transition-opacity duration-200"
		onclick={handleOverlayClick}
		onkeydown={handleKeydown}
	>
		<div
			class="mx-4 w-full max-w-md transform rounded-[var(--radius)] border border-border bg-card shadow-xl transition-transform duration-200 {open
				? 'scale-100'
				: 'scale-95'}"
		>
			<div class="p-6">
				<div class="flex items-start gap-3">
					<div
						class="mt-0.5 shrink-0 rounded-full p-2 {variant === 'danger'
							? 'bg-destructive/10 text-destructive'
							: 'bg-primary/10 text-primary'}"
					>
						<AlertTriangle size={20} />
					</div>
					<div class="flex-1">
						<div class="flex items-start justify-between">
							<h3
								id="confirm-dialog-title"
								class="text-lg font-semibold tracking-tight"
							>
								{title}
							</h3>
							<Tooltip>
								<TooltipTrigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon"
											class="h-7 w-7 shrink-0"
											onclick={oncancel}
											aria-label="Close"
										>
											<X size={16} />
										</Button>
									{/snippet}
								</TooltipTrigger>
								<TooltipContent>Close</TooltipContent>
							</Tooltip>
						</div>
						<div
							id="confirm-dialog-desc"
							class="mt-1 text-sm leading-relaxed text-muted-foreground"
						>
							<!-- eslint-disable svelte/no-at-html-tags -- Messages are trusted/internal HTML -->
							{@html message}

							{#if requireTyping}
								<div class="mt-4">
									<label
										for="confirm-typing"
										class="mb-1.5 block text-sm font-medium"
									>
										Type <span class="font-mono font-bold">{requireTyping}</span
										> to confirm
									</label>
									<input
										id="confirm-typing"
										type="text"
										bind:value={typingValue}
										class="h-10 w-full rounded-[var(--radius)] border border-border bg-background px-3 font-mono text-sm transition-shadow focus:ring-2 focus:ring-ring focus:outline-none"
										autocomplete="off"
										spellcheck="false"
									/>
								</div>
							{/if}
						</div>
					</div>
				</div>

				<div class="mt-6 flex justify-end gap-2">
					<Button variant="outline" onclick={oncancel}>Cancel</Button>
					<Button
						variant={variant === "danger" ? "destructive" : "default"}
						onclick={handleConfirm}
						disabled={!canConfirm}
						autofocus
					>
						{#if variant === "danger"}
							<Trash2 size={14} />
						{:else}
							<Check size={14} />
						{/if}
						{confirmLabel}
					</Button>
				</div>
			</div>
		</div>
	</div>
{/if}
