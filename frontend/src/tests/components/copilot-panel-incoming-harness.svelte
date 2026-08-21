<script lang="ts">
	import CopilotPanel from "$lib/components/submissions/copilot-panel.svelte";
	import type { ComponentProps } from "svelte";

	/**
	 * CopilotPanel props minus the bindable `incomingPrompt`, which is
	 * OWNED here so the panel's consume-and-reset round-trip is observable
	 * from the test (`export { incomingPrompt }` compiles to an instance
	 * getter/setter — see references/svelte5-bindable-testing.md).
	 */
	type PanelProps = Omit<ComponentProps<typeof CopilotPanel>, "incomingPrompt">;

	let { submissionId, assignmentId, onapply }: PanelProps = $props();

	let incomingPrompt = $state("");

	export { incomingPrompt };
</script>

<CopilotPanel {submissionId} {assignmentId} {onapply} bind:incomingPrompt />
