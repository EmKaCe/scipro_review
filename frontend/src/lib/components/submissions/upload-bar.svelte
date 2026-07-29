<script lang="ts">
	import Upload from "@lucide/svelte/icons/upload";

	interface Props {
		/** Compact inline bar vs full-size empty state. */
		compact?: boolean;
		/** Called when the upload area is clicked. Parent controls the action. */
		onClick?: () => void;
	}

	let { compact = true, onClick }: Props = $props();
</script>

{#if compact}
	<!-- Compact upload bar — shown when submissions exist -->
	<button class="upload-bar-compact" onclick={onClick} aria-label="Upload files">
		<Upload size={14} />
		<span>Drop .ipynb files here or click to upload</span>
	</button>
{:else}
	<!-- Full-size empty state — shown when no submissions exist -->
	<div class="upload-empty-state">
		<div class="empty-icon-wrap">
			<Upload size={28} />
		</div>
		<h2 class="empty-title">No submissions yet</h2>
		<p class="empty-desc">Upload .ipynb files to get started.</p>
		<button class="btn-upload" onclick={onClick}>
			<Upload size={14} />
			Upload Files
		</button>
		<p class="empty-hint">Supports .ipynb files from SciPro assignments</p>
	</div>
{/if}

<style>
	/* ── Compact bar ── */
	.upload-bar-compact {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		padding: 8px 14px;
		border: 1.5px dashed var(--border);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--accent) 3%, transparent);
		color: var(--muted-foreground);
		font-size: 12px;
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s,
			color 0.15s;
	}
	.upload-bar-compact:hover {
		border-color: var(--accent);
		background: color-mix(in oklch, var(--accent) 6%, transparent);
		color: var(--fg);
	}

	/* ── Full empty state ── */
	.upload-empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 80px 40px;
		text-align: center;
	}
	.empty-icon-wrap {
		width: 64px;
		height: 64px;
		border-radius: var(--radius-xl);
		background: color-mix(in oklch, var(--accent) 8%, var(--bg));
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 20px;
	}
	.empty-title {
		font-size: 18px;
		font-weight: 600;
		color: var(--fg);
		margin-bottom: 8px;
	}
	.empty-desc {
		font-size: 13px;
		color: var(--muted-foreground);
		margin-bottom: 16px;
	}
	.btn-upload {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: transparent;
		font-size: 13px;
		font-weight: 500;
		color: var(--fg);
		cursor: pointer;
		transition:
			background 0.15s,
			border-color 0.15s;
	}
	.btn-upload:hover {
		background: var(--muted-bg);
		border-color: var(--muted-foreground);
	}
	.empty-hint {
		margin-top: 12px;
		font-size: 11px;
		color: var(--muted-foreground);
	}

	/* Responsive: reduce empty state padding on small screens */
	@media (max-width: 600px) {
		.upload-empty-state {
			padding: 40px 20px;
		}
	}
</style>
