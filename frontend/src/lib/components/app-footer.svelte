<script lang="ts">
	interface Props {
		/** Additional CSS class names. */
		class?: string;
	}

	let { class: className = "" }: Props = $props();
</script>

<footer class="mt-auto border-t border-border py-6 text-center {className}"></footer>
