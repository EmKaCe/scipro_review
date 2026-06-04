<script lang="ts">
	import ChevronDown from "@lucide/svelte/icons/chevron-down";

	interface FaqItem {
		question: string;
		answer: string;
	}

	const faqItems: FaqItem[] = [
		{
			question: "Where is my data stored?",
			answer: "All data is stored locally in your browser using IndexedDB. Nothing is sent to a server. This ensures complete privacy, but also means your data is tied to this browser profile.",
		},
		{
			question: "Can I use this on my phone?",
			answer: "The app is responsive and works on mobile devices, but it is optimized for desktop use. The review page in particular benefits from a larger screen for the two-column layout and category navigation.",
		},
		{
			question: "How do I share a review with someone else?",
			answer: "Export the review as YAML or Markdown and share the file. The recipient can import the YAML file into their own SciPro Review instance to view or continue the review.",
		},
		{
			question: "What happens if I clear my browser data?",
			answer: "All saved reviews will be permanently lost. Consider exporting important reviews as YAML files to your local file system before clearing browser data.",
		},
	];

	let openIndex = $state<number | null>(null);

	function toggle(index: number) {
		openIndex = openIndex === index ? null : index;
	}
</script>

<div class="overflow-hidden rounded-lg border border-border">
	{#each faqItems as item, index (index)}
		<div class="accordion-item {openIndex === index ? 'open' : ''}">
			<button
				onclick={() => toggle(index)}
				class="accordion-trigger flex w-full cursor-pointer items-center justify-between border-none bg-transparent px-4 py-4 text-left font-[inherit] text-sm font-medium text-foreground transition-colors hover:text-primary"
				aria-expanded={openIndex === index}
				aria-controls="faq-content-{index}"
			>
				<span>{item.question}</span>
				<ChevronDown
					size={16}
					class="accordion-chevron shrink-0 text-muted-foreground transition-transform duration-200 {openIndex ===
					index
						? 'rotate-180'
						: ''}"
				/>
			</button>
			<div
				id="faq-content-{index}"
				class="accordion-grid overflow-hidden transition-all duration-300 {openIndex ===
				index
					? 'open'
					: ''}"
				aria-hidden={openIndex !== index}
			>
				<div class="accordion-inner min-h-0">
					<p class="m-0 px-4 pb-4 text-sm leading-relaxed text-muted-foreground">
						{item.answer}
					</p>
				</div>
			</div>
		</div>
	{/each}
</div>

<style>
	.accordion-item {
		border-bottom: 1px solid var(--border);
	}

	.accordion-item:last-child {
		border-bottom: none;
	}

	.accordion-grid {
		display: grid;
		grid-template-rows: 0fr;
		transition:
			grid-template-rows 0.3s ease-in-out,
			opacity 0.3s ease-in-out;
		opacity: 0;
	}

	.accordion-grid.open {
		grid-template-rows: 1fr;
		opacity: 1;
	}

	.accordion-inner {
		min-height: 0;
	}
</style>
