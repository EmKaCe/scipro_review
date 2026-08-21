<script lang="ts">
	/**
	 * @file Criteria YAML upload.
	 *
	 * File input (.yaml) + upload button backed by the uploadCriteria client
	 * wrapper. Server 400 messages are shown inline; on success the
	 * onUploaded(fileName) callback fires so the parent form can append the
	 * new path to its criteria_files list.
	 */

	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import FileUp from "@lucide/svelte/icons/file-up";
	import Loader from "@lucide/svelte/icons/loader";

	import { Button } from "$lib/components/ui/button/index.js";
	import { uploadCriteria } from "$lib/services/submissions-api.js";

	interface Props {
		/** Assignment the criteria file belongs to. */
		assignmentId: string;
		/** Invoked with the persisted relative path (data/criteria/<name>.yaml). */
		onUploaded: (fileName: string) => void;
	}

	let { assignmentId, onUploaded }: Props = $props();

	let file = $state<File | null>(null);
	let uploading = $state(false);
	let error = $state<string | null>(null);
	let inputRef: HTMLInputElement | undefined = $state(undefined);

	function handleFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		file = input.files?.[0] ?? null;
		error = null;
	}

	async function handleUpload() {
		if (!file || uploading) return;
		uploading = true;
		error = null;
		try {
			const { fileName } = await uploadCriteria(assignmentId, file);
			onUploaded(fileName);
			file = null;
			if (inputRef) inputRef.value = "";
		} catch (err) {
			error = err instanceof Error ? err.message : "Upload failed";
		} finally {
			uploading = false;
		}
	}
</script>

<div class="criteria-upload">
	<div class="row">
		<input
			class="file-input"
			type="file"
			accept=".yaml,.yml,text/yaml,application/yaml"
			bind:this={inputRef}
			onchange={handleFileChange}
			aria-label="Criteria YAML file"
		/>
		<Button
			variant="outline"
			size="sm"
			type="button"
			onclick={handleUpload}
			disabled={!file || uploading}
		>
			{#if uploading}
				<span class="spinner"><Loader size={14} /></span>
				Uploading…
			{:else}
				<FileUp size={14} />
				Upload criteria
			{/if}
		</Button>
	</div>
	{#if file}
		<p class="file-name">{file.name}</p>
	{/if}
	{#if error}
		<p class="upload-error">
			<CircleAlert size={13} />
			{error}
		</p>
	{/if}
	<p class="hint">
		Validated v2 criteria YAML (categories with title / additional_notes / positive / neutral /
		negative). Category keys must not collide with general.yaml.
	</p>
</div>

<style>
	.criteria-upload {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.file-input {
		max-width: 260px;
		font-size: 13px;
	}
	.file-name {
		margin: 0;
		font-size: 12.5px;
		color: var(--fg);
	}
	.upload-error {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: 12.5px;
		color: var(--destructive);
	}
	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.spinner {
		display: inline-flex;
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
