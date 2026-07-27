<script lang="ts">
	import Info from "@lucide/svelte/icons/info";
	import ImageIcon from "@lucide/svelte/icons/image";
	import FaqAccordion from "$lib/components/faq-accordion.svelte";
</script>

<div class="doc-content max-w-3xl">
	<div class="mb-8">
		<h1 class="mb-2 text-2xl font-bold tracking-tight">Documentation</h1>
		<p class="text-muted-foreground">Learn how to use SciPro Review effectively.</p>
	</div>

	<!-- Getting Started -->
	<section id="getting-started">
		<h2>Getting Started</h2>
		<p>
			SciPro Review is a peer-review and grading tool for Jupyter notebook submissions in
			Scientific Programming in Python courses at the Bonn-Rhein-Sieg University of Applied
			Sciences. It is designed as a client-side application:
			<strong>all data stays in your browser</strong> and nothing is ever sent to a server.
		</p>
		<ol>
			<li>Open the app in any modern browser (Chrome, Firefox, Safari, Edge).</li>
			<li>Start a new review by entering a student ID and selecting an assignment.</li>
			<li>Use the rubric to evaluate the submission across multiple categories.</li>
			<li>Generate an evaluation report when you're done.</li>
			<li>Export your review as YAML or Markdown for backup or sharing.</li>
		</ol>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Privacy first:</strong> All data is stored locally using IndexedDB. Clearing your
				browser data will erase all saved reviews. Export important reviews regularly.
			</p>
		</div>
	</section>

	<!-- Starting a Review -->
	<section id="starting-review">
		<h2>Starting a Review</h2>
		<p>From the landing page, enter the required information to begin:</p>
		<ul>
			<li>
				<strong>Student ID</strong> — Automatically prefixed with the current semester
				(e.g.,
				<code>2026SS_</code>). Toggle "Custom ID" if you need a non-standard format.
			</li>
			<li>
				<strong>Assignment</strong> — Select from the dropdown populated from
				<code>assignments.yaml</code>. Only enabled assignments are shown.
			</li>
			<li>
				<strong>Start Review</strong> — Click the primary button to open the review page.
			</li>
		</ul>
		<div class="screenshot-placeholder mt-4 h-48">
			<span class="flex items-center gap-2">
				<ImageIcon size={16} />
				Landing page form illustration
			</span>
		</div>
	</section>

	<!-- Completing a Review -->
	<section id="completing-review">
		<h2>Completing a Review</h2>
		<p>
			The review interface is organized into <strong>categories</strong>. Each category
			contains three sentiment sections: <strong>Positive</strong>, <strong>Neutral</strong>,
			and
			<strong>Negative</strong>.
		</p>
		<h3>Rubric Structure</h3>
		<ul>
			<li><strong>Main points</strong> are bold headings that group related criteria.</li>
			<li>
				<strong>Sub-points</strong> are individual checkboxes you toggle to indicate whether the
				criterion is met.
			</li>
			<li>
				When a sub-point has a comment enabled and is checked, a
				<strong>comment textarea</strong> appears below it.
			</li>
			<li>
				When a sub-point has point deduction enabled and is checked, a
				<strong>numeric deduction input</strong> appears.
			</li>
			<li>
				Some categories offer an <strong>Additional Notes</strong> textarea for free-form feedback.
			</li>
		</ul>
		<h3>Navigation</h3>
		<p>
			Use the <strong>Category Quick-Nav</strong> bar below the header to jump between
			categories. Completed categories show a green dot; incomplete categories show a gray
			circle. Click
			<strong>Expand All / Collapse All</strong> to toggle all category cards.
		</p>
		<h3>Progress</h3>
		<p>
			The header shows a progress indicator like
			<span class="text-sm font-medium">4/11 categories</span> with a mini progress bar. Categories
			are considered complete when all required sub-points have been evaluated.
		</p>
	</section>

	<!-- Saving & Resuming -->
	<section id="saving">
		<h2>Saving &amp; Resuming</h2>
		<p>
			Your review is automatically saved to IndexedDB as you work. A debounced save fires
			after each interaction, so you rarely need to manually save.
		</p>
		<ul>
			<li>
				<strong>Auto-save</strong> — Triggered automatically after changes. Look for the subtle
				save indicator in the header.
			</li>
			<li>
				<strong>Manual Save</strong> — Press <kbd>Ctrl+S</kbd> (or <kbd>Cmd+S</kbd> on macOS)
				to force an immediate save.
			</li>
			<li>
				<strong>Resuming</strong> — Return to the landing page and click
				<strong>Open</strong> on any saved review in the table.
			</li>
			<li>
				<strong>Multiple Reviews</strong> — You can work on multiple reviews concurrently. Each
				is saved independently.
			</li>
		</ul>
	</section>

	<!-- Importing -->
	<section id="importing">
		<h2>Importing Reviews</h2>
		<p>
			You can import previously exported reviews to continue working or to view another
			reviewer's evaluation.
		</p>
		<ul>
			<li><strong>Supported formats</strong> — YAML v2 Evaluation format and legacy JSON.</li>
			<li>
				<strong>Trigger</strong> — Click the <strong>Import</strong> button (Upload icon) in the
				app header.
			</li>
			<li>
				<strong>Read-only</strong> — Imported reviews open in read-only mode by default. To
				edit, click <strong>Edit</strong> on the review page.
			</li>
			<li>
				<strong>Validation</strong> — The app validates the file against the expected schema and
				shows an error if parsing fails.
			</li>
		</ul>
	</section>

	<!-- Exporting -->
	<section id="exporting">
		<h2>Exporting Reviews</h2>
		<p>Export your review to share it, back it up, or archive it.</p>
		<ul>
			<li>
				<strong>YAML (v2 Evaluation)</strong> — A structured data file that preserves the full
				review state. Can be re-imported later.
			</li>
			<li>
				<strong>Markdown (Evaluation Report)</strong> — A human-readable report with YAML frontmatter
				and checkbox sections. Ideal for sharing with students.
			</li>
			<li>
				<strong>JSON (Session Data)</strong> — A complete JSON snapshot of the review session.
				Can be re-imported to continue editing.
			</li>
			<li>
				<strong>File naming</strong> — The default filename follows the pattern
				<code>{"{{student_id}}_{{assignment}}_eval.{{ext}}"}</code>.
			</li>
		</ul>
	</section>

	<!-- Previewing Evaluations -->
	<section id="previewing">
		<h2>Previewing Evaluations</h2>
		<p>
			Once you have completed enough categories, click <strong>Generate Evaluation</strong> to produce
			a formatted report.
		</p>
		<ul>
			<li>
				<strong>Positive Observations</strong> — All checked positive sub-points, grouped by category,
				with comments.
			</li>
			<li><strong>General Observations</strong> — Neutral items and general notes.</li>
			<li>
				<strong>Areas for Improvement</strong> — Negative items, with point deductions shown inline.
			</li>
			<li>
				<strong>Copy to Clipboard</strong> — Use the action bar to copy the report as Markdown.
			</li>
			<li>
				<strong>Grading Summary</strong> — A detailed breakdown of dimension scores is included.
			</li>
		</ul>
	</section>

	<!-- Keyboard Shortcuts -->
	<section id="shortcuts">
		<h2>Keyboard Shortcuts</h2>
		<table>
			<thead>
				<tr>
					<th>Shortcut</th>
					<th>Action</th>
				</tr>
			</thead>
			<tbody>
				<tr>
					<td><kbd>Ctrl</kbd> + <kbd>S</kbd></td>
					<td>Save the current review</td>
				</tr>
				<tr>
					<td><kbd>Ctrl</kbd> + <kbd>Z</kbd></td>
					<td>Undo last action</td>
				</tr>
				<tr>
					<td><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></td>
					<td>Redo last undone action</td>
				</tr>
			</tbody>
		</table>
	</section>

	<!-- FAQ -->
	<section id="faq">
		<h2>FAQ</h2>
		<FaqAccordion />
	</section>

	<!-- Footer spacer -->
	<div class="h-16"></div>
</div>

<style>
	/* Prose docs styling */
	.doc-content h2 {
		font-size: 1.25rem;
		font-weight: 600;
		line-height: 1.3;
		letter-spacing: -0.025em;
		margin-top: 2.5rem;
		margin-bottom: 0.75rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--border);
		color: var(--foreground);
	}

	.doc-content h3 {
		font-size: 1rem;
		font-weight: 600;
		line-height: 1.4;
		margin-top: 1.5rem;
		margin-bottom: 0.5rem;
		color: var(--foreground);
	}

	.doc-content p {
		margin-bottom: 0.75rem;
		line-height: 1.7;
		color: var(--muted-foreground);
		font-size: 0.9375rem;
	}

	.doc-content ul {
		list-style-type: none;
		padding-left: 0;
		margin-bottom: 1rem;
	}

	.doc-content ul li {
		position: relative;
		padding-left: 1.25rem;
		margin-bottom: 0.5rem;
		color: var(--muted-foreground);
		line-height: 1.6;
		font-size: 0.9375rem;
	}

	.doc-content ul li::before {
		content: "";
		position: absolute;
		left: 0.25rem;
		top: 0.6rem;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--primary);
	}

	.doc-content ol {
		padding-left: 1.25rem;
		margin-bottom: 1rem;
		color: var(--muted-foreground);
		line-height: 1.7;
		font-size: 0.9375rem;
	}

	.doc-content ol li {
		margin-bottom: 0.5rem;
		padding-left: 0.25rem;
	}

	.doc-content kbd {
		display: inline-block;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background: var(--background);
		border: 1px solid var(--border);
		font-family: ui-monospace, "Fira Code", monospace;
		font-size: 0.8125rem;
		color: var(--foreground);
	}

	.doc-content code {
		font-size: 0.875rem;
		font-family: ui-monospace, "Fira Code", monospace;
		background: var(--background);
		border: 1px solid var(--border);
		padding: 0.125rem 0.25rem;
		border-radius: 0.25rem;
	}

	.doc-content table {
		width: 100%;
		border-collapse: collapse;
		margin: 1rem 0;
		font-size: 0.875rem;
	}

	.doc-content th {
		text-align: left;
		padding: 0.625rem 0.75rem;
		font-weight: 600;
		border-bottom: 2px solid var(--border);
		color: var(--foreground);
	}

	.doc-content td {
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid var(--border);
		color: var(--muted-foreground);
	}

	.doc-content tr:last-child td {
		border-bottom-width: 2px;
		border-color: var(--border);
	}

	.screenshot-placeholder {
		border: 2px dashed var(--border);
		border-radius: var(--radius);
		background: var(--background);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted-foreground);
		font-size: 0.875rem;
	}
</style>
