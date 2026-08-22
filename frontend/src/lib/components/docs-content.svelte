<script lang="ts">
	import Info from "@lucide/svelte/icons/info";
	import ImageIcon from "@lucide/svelte/icons/image";
</script>

<div class="doc-content max-w-3xl">
	<div class="mb-8">
		<h1 class="mb-2 text-2xl font-bold tracking-tight">Documentation</h1>
		<p class="text-muted-foreground">Teacher guide for setting up and using SciPro Review.</p>
	</div>

	<!-- Getting Started -->
	<section id="getting-started">
		<h2>Getting Started</h2>
		<p>
			SciPro Review's teacher mode is a self-hosted grading server for Jupyter notebook
			submissions in Scientific Programming in Python courses at the Bonn-Rhein-Sieg
			University of Applied Sciences. It runs on your own machine (or a server) with Docker
			and provides the teacher dashboard, the notebook execution pipeline, and the AI copilot.
			All data — submissions, results, settings — is stored in a local data directory that you
			control.
		</p>
		<h3>Prerequisites</h3>
		<ul>
			<li>
				<strong>Docker</strong> with Docker Compose (the <code>docker compose</code> plugin; on
				Windows/macOS use Docker Desktop)
			</li>
			<li><strong>git</strong> for cloning the repository and pulling updates</li>
			<li>
				A <strong>KI Connect NRW API key</strong> for LLM features (pre-evaluation, copilot)
			</li>
		</ul>
		<h3>Setup Steps</h3>
		<ol>
			<li>
				Clone the repository:
				<pre><code
						>git clone https://github.com/EmKaCe/scipro_review.git
cd scipro_review</code
					></pre>
			</li>
			<li>
				Create the environment file and add your API key:
				<pre><code>cp .env.example .env</code></pre>
				Then edit<code>.env</code> and set
				<code>KI_CONNECT_API_KEY=sk-...</code> to your KI Connect key.
			</li>
			<li>
				Start the stack:
				<pre><code>docker compose up -d</code></pre>
			</li>
			<li>
				Open <a href="http://localhost:4174">http://localhost:4174</a> in your browser. The
				app now shows the <strong>teacher dashboard</strong>.
			</li>
		</ol>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>First start:</strong> the first <code>docker compose up -d</code> builds both
				images (frontend + executor) and can take several minutes. Subsequent starts are fast.
			</p>
		</div>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Uploads fail with 403?</strong> Set <code>ORIGIN</code> in your
				<code>.env</code> to the address you actually use to reach the app. See
				<a href="#troubleshooting">Troubleshooting</a>.
			</p>
		</div>
	</section>

	<!-- Configuration -->
	<section id="configuration">
		<h2>Configuration</h2>
		<p>
			Configuration is split between the <code>.env</code> file (machine-level settings, read
			at container start) and the in-app settings page (runtime settings, stored in
			<code>data/settings.yaml</code>). Course content lives in YAML files under
			<code>data/</code>.
		</p>
		<p class="note">
			<strong>Deep reference:</strong> this page is the <em>how-to</em>. For the full
			architecture, data flow, how the data structures are wired, and the terminology, see the
			repo's <code>.github/references/</code> docs —
			<code>concepts.md</code> (the explainable mental model), <code>architecture.md</code>,
			<code>data-structures.md</code>, <code>developer-guide.md</code> — and for
			new-assignment / accuracy guidance, <code>assignment-calibration.md</code> and
			<code>quality-statement.md</code>.
		</p>
		<h3>Environment File (<code>.env</code>)</h3>
		<ul>
			<li>
				<strong><code>KI_CONNECT_API_KEY</code></strong> — Bearer token for the KI Connect NRW
				OpenAI-compatible API. Required for pre-evaluation and the copilot.
			</li>
			<li>
				<strong><code>ORIGIN</code></strong> — The public URL teachers use to reach the app.
				Required for uploads to pass the CSRF check; set it to
				<code>http://&lt;lan-ip&gt;:4174</code> when accessing from other devices (see
				<a href="#deployment">Deployment</a>).
			</li>
			<li>
				<strong><code>EXECUTOR_URL</code></strong> — How the frontend reaches the notebook
				executor. The Docker Compose default (<code>http://executor:8766</code>) works out
				of the box; change it only if you run the executor elsewhere.
			</li>
		</ul>
		<h3>Settings Page (<code>/settings</code>)</h3>
		<p>Runtime settings are edited in the app and saved to <code>data/settings.yaml</code>:</p>
		<ul>
			<li>
				<strong>Executor timeouts</strong> — per-notebook HTTP budget (<code
					>executor.notebook_timeout_ms</code
				>), single-request timeout (<code>executor.request_timeout_ms</code>), and per-cell
				limit (<code>executor.cell_timeout_s</code>)
			</li>
			<li>
				<strong>LLM model selection</strong> — choose the model for pre-evaluation and the
				copilot; the list is fetched live from KI Connect (with a static fallback), and the
				LLM timeout (<code>llm.timeout_ms</code>) is adjustable
			</li>
			<li>
				<strong>API key</strong> — view whether a key is configured and replace it; the key itself
				never leaves the server (it is shown masked)
			</li>
			<li>
				<strong>Copilot mode</strong> — approval mode, tool allow/deny lists, and session
				limits (see <a href="#copilot">AI Copilot</a>)
			</li>
		</ul>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Settings apply immediately.</strong> Saves on the settings page take effect
				without restarting the container. Environment variables are only a fallback for
				values not present in <code>data/settings.yaml</code>.
			</p>
		</div>
		<h3>Assignments (<code>data/assignments.yaml</code>)</h3>
		<p>
			Each assignment defines its ID, title, enabled state, the rubric criteria files, and the
			grading dimensions:
		</p>
		<pre><code
				>assignments:
  - id: soil_contamination
    title: Soil Contamination by Factories (NumPy, Pandas, SciPy, sklearn)
    enabled: true
    criteria_files:
      - data/criteria/general.yaml
      - data/criteria/soil_contamination.yaml
    dimensions:
      - code_quality_design
      - code_execution_results
      - assignment_requirements
      - scientific_programming
      - creativity</code
			></pre>
		<p>
			The <strong>criteria YAML files</strong> (e.g. <code>data/criteria/general.yaml</code>)
			define the rubric categories, main points, sub-points, and comments used in the review
			interface.
		</p>
		<h3>Grading Config (<code>data/grading_config.yaml</code>)</h3>
		<p>Dimension weights and grade boundaries control the live grade calculation:</p>
		<pre><code
				>dimensions:
  - key: code_quality_design
    title: Code Quality &amp; Design
    max_points: 6.0
    weight: 4.0

grade_boundaries:
  - min_percentage: 95
    grade: 1.0
    label: excellent
    us_equiv: A+</code
			></pre>
		<p>
			Change <code>weight</code> to rebalance dimensions and edit
			<code>grade_boundaries</code> to adjust the German 1.0–5.0 scale mapping.
		</p>
	</section>

	<!-- Uploading Submissions -->
	<section id="uploading">
		<h2>Uploading Submissions</h2>
		<p>
			The upload bar on the <a href="/submissions">submissions page</a> accepts multiple files
			at once — drag-and-drop them onto the bar or click to browse. Files are classified
			automatically and merge into the current batch; new submissions get a
			<code>pending</code> status.
		</p>
		<h3>File Naming</h3>
		<p>
			Students submit their notebooks as <code>&lt;semester&gt;_&lt;n&gt;.ipynb</code> — the
			semester prefix plus the assignment number, e.g. <code>2026SS_04.ipynb</code>.
		</p>
		<h3>Classification</h3>
		<ul>
			<li>
				<strong>Notebooks</strong> (<code>.ipynb</code>) are classified as
				<strong>submissions</strong> and appear in the submissions table
			</li>
			<li>
				<strong>Data files</strong> (CSV, text, images, …) are classified as
				<strong>materials</strong> and stored as input data for the assignment
			</li>
		</ul>
		<h3>Kind Override</h3>
		<p>
			Each file in the upload panel has a <strong>kind dropdown</strong>. If the automatic
			classification is wrong, reclassify the file manually before or after uploading — for
			example, force a file to be a submission or move it to the assignment materials.
		</p>
		<h3>Assignment Materials</h3>
		<p>Use the dedicated upload areas to provide course materials per assignment:</p>
		<ul>
			<li><strong>Assignment PDF</strong> — the task description shown to reviewers</li>
			<li>
				<strong>Reference key notebook</strong> — the solution used for the side-by-side cell
				comparison during grading
			</li>
			<li><strong>Input data files</strong> — copied into the executor sandbox</li>
		</ul>
		<div class="screenshot-placeholder mt-4 h-48">
			<span class="flex items-center gap-2">
				<ImageIcon size={16} />
				Upload panel with per-file classification illustration
			</span>
		</div>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Incremental uploads:</strong> adding files later merges them into the existing
				batch. Already-processed submissions are not re-processed automatically.
			</p>
		</div>
	</section>

	<!-- Running the Pipeline -->
	<section id="pipeline">
		<h2>Running the Pipeline</h2>
		<p>
			Once submissions are uploaded, the pipeline executes them and prepares them for grading.
			Both batch actions live in the dashboard toolbar on the
			<a href="/submissions">submissions page</a>.
		</p>
		<h3>Process</h3>
		<p>
			<strong>Process</strong> executes all pending submissions through the Python executor (each
			notebook in its own sandbox with the assignment's input data). A batch runs notebook-by-notebook
			— one failing or timing-out notebook does not block the rest; per-row status updates as each
			submission finishes.
		</p>
		<h3>Pre-evaluate All</h3>
		<p>
			<strong>Pre-evaluate All</strong> runs the LLM pre-evaluation over the executed
			submissions: it computes <strong>cell markers</strong> (same/different/questionable vs.
			the reference key), <strong>grade suggestions</strong> (dimension scores), and
			<strong>rubric suggestions</strong> (criteria selections). Pre-evaluation runs inside the
			app process, so it keeps working even if the executor is down.
		</p>
		<h3>Monitoring</h3>
		<ul>
			<li>
				<strong>Progress bar</strong> — shows done/total, the current student, and elapsed time
				while a batch is running
			</li>
			<li>
				<strong>Pipeline log</strong> — a collapsible panel with real-time log lines from the
				executor and the pre-evaluation runs, filterable by source
			</li>
		</ul>
		<h3>Auto-fix</h3>
		<p>
			During processing, the pipeline can <strong>automatically attempt fixes</strong> for errored
			cells: the executor asks the LLM for a suggestion, applies it to a private copy, and re-runs
			the whole notebook to verify. Verified fixes are shown in the cell view with a per-cell toggle
			— your grading view is never modified behind your back.
		</p>
		<h3>Single Submission Processing</h3>
		<p>
			From a <a href="/submissions">submission detail page</a> you can process, re-process, or pre-evaluate
			a single submission — useful after a manual upload or when only one notebook failed.
		</p>
	</section>

	<!-- Grading Workflow -->
	<section id="grading">
		<h2>Grading Workflow</h2>
		<p>
			Grading is a teacher-only activity. The workflow is sequential: review the cells, mark
			the rubric, dial the dimension scores, then save and export.
		</p>
		<h3>Open a Submission</h3>
		<p>
			Click <strong>Review</strong> in the submissions table to open the
			<a href="/submissions">submission detail page</a> with the notebook execution results.
		</p>
		<h3>Reference Comparison</h3>
		<p>
			The left panel shows the submission cells <strong
				>side-by-side with the reference key</strong
			>. Cell markers (from pre-evaluation) highlight cells that match, differ, or look
			questionable, and markdown/plots render inline.
		</p>
		<h3>Rubric</h3>
		<p>
			The rubric panel lists the assignment's criteria. Check each criterion, add comments
			where the category allows, and set point deductions where enabled.
		</p>
		<h3>Grading Sidebar</h3>
		<p>
			The grading sidebar stays visible while you work: dial the score for each dimension and
			see the <strong>live grade calculation</strong> (German 1.0–5.0 scale) update immediately.
		</p>
		<h3>Copilot Assistance</h3>
		<p>
			Use the AI copilot for suggestions, grading, and drafting student feedback at any point
			— see <a href="#copilot">AI Copilot</a>.
		</p>
		<h3>Save &amp; Export</h3>
		<ul>
			<li>
				<strong>Save</strong> — grading data persists to the server (per-submission results),
				so you can close the page and resume later
			</li>
			<li>
				<strong>Export</strong> — download the graded review as <strong>YAML</strong>,
				<strong>Markdown</strong>, or <strong>JSON</strong> for delivery to students or archiving
			</li>
		</ul>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Teacher-only:</strong> grading sliders and the grading sidebar are only interactive
				in teacher mode. In the student-facing build they are always read-only.
			</p>
		</div>
	</section>

	<!-- AI Copilot -->
	<section id="copilot">
		<h2>AI Copilot</h2>
		<p>
			The copilot is an LLM assistant that sees the submission's cells and the reference key
			and can operate on your behalf — suggesting grades, drafting feedback, checking
			plagiarism, and more. Every action it takes is governed by the approval mode.
		</p>
		<h3>Access</h3>
		<ul>
			<li>
				<strong>Assignment scope</strong> — the copilot button on the submissions table works
				across the whole assignment
			</li>
			<li>
				<strong>Per-submission</strong> — the copilot tab on the submission detail page is scoped
				to that student's notebook
			</li>
		</ul>
		<h3>How to Ask</h3>
		<p>
			The copilot is a chat assistant that picks the right tools automatically — there are no
			slash commands to memorize. Just ask in plain language, e.g.
			<em>“suggest grades and rubric selections for this submission”</em>,
			<em>“draft feedback for the student”</em>, or
			<em>“check this submission for plagiarism”</em>. A context meter shows how much of the
			conversation window is in use so you can steer long sessions.
		</p>
		<h3>Approval Modes</h3>
		<ul>
			<li>
				<strong>Ask</strong> (default) — every tool action is presented to you for approval before
				it runs
			</li>
			<li>
				<strong>Auto-approve all</strong> — the copilot executes permitted tools without asking;
				best for trusted, low-cost operations
			</li>
			<li>
				<strong>Read-only</strong> — the copilot can look and reason but cannot modify anything
			</li>
		</ul>
		<h3>Tool Permissions</h3>
		<p>
			The settings page has per-mode <strong>allow/deny lists</strong> for copilot tools. Some actions
			are hard-blocked regardless of mode (e.g. deleting an assignment, archiving a submission),
			and costly batch actions always require your approval.
		</p>
		<h3>Suggestions</h3>
		<p>
			The copilot delivers results as <strong>suggestions</strong>: apply them with one click
			or dismiss them. Nothing is written to a submission without an explicit apply.
		</p>
	</section>

	<!-- Backup & Restore -->
	<section id="backup">
		<h2>Backup &amp; Restore</h2>
		<p>
			Backups capture the entire data directory in a single ZIP file — the machine migration
			path for moving to a new computer or keeping a safety copy.
		</p>
		<ul>
			<li>
				<strong>Download</strong> — the <strong>Download Backup</strong> button zips the whole
				data directory, including submissions, execution results, copilot threads, settings, criteria
				files, and the grading config
			</li>
			<li>
				<strong>Restore</strong> — upload a backup ZIP to restore all data. Existing data is replaced
				by the backup's contents
			</li>
		</ul>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Take a backup before upgrading</strong> — and before restoring on a new machine,
				make sure the app version matches the backup's format.
			</p>
		</div>
	</section>

	<!-- Troubleshooting -->
	<section id="troubleshooting">
		<h2>Troubleshooting</h2>
		<table>
			<thead>
				<tr>
					<th>Symptom</th>
					<th>Fix</th>
				</tr>
			</thead>
			<tbody>
				<tr>
					<td>Uploads return <code>403</code></td>
					<td>
						Set <code>ORIGIN</code> in <code>.env</code> to the URL you use to reach the
						app (e.g. <code>http://&lt;lan-ip&gt;:4174</code>) and restart with
						<code>docker compose up -d</code>
					</td>
				</tr>
				<tr>
					<td>Executor not healthy</td>
					<td>
						Check <code>docker compose ps</code> — the executor must be running (<code
							>healthy</code
						>). If it is down, start it with
						<code>docker compose up -d</code> and inspect
						<code>docker compose logs executor</code>
					</td>
				</tr>
				<tr>
					<td>KI Connect auth failed</td>
					<td>
						Verify <code>KI_CONNECT_API_KEY</code> in <code>.env</code> is correct and not
						empty, then restart the stack
					</td>
				</tr>
				<tr>
					<td>LLM requests time out</td>
					<td>
						Increase <code>llm.timeout_ms</code> on the settings page — larger models can
						need longer to respond
					</td>
				</tr>
				<tr>
					<td>Notebook execution timeout</td>
					<td>
						Increase <code>executor.notebook_timeout_ms</code> in settings; the budget must
						also cover auto-fix re-runs
					</td>
				</tr>
				<tr>
					<td>Pre-evaluation takes too long</td>
					<td>
						Switch to a faster model in the settings page (LLM model selection) and
						re-run pre-evaluation
					</td>
				</tr>
			</tbody>
		</table>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Still stuck?</strong> The pipeline log panel shows executor and pre-evaluation
				output in real time — it usually points at the failing step.
			</p>
		</div>
	</section>

	<!-- Deployment -->
	<section id="deployment">
		<h2>Deployment</h2>
		<h3>Local</h3>
		<p>Start the stack with Docker Compose; the app is then available on port 4174:</p>
		<pre><code>docker compose up -d</code></pre>
		<h3>LAN Access</h3>
		<p>
			To grade from another computer on your network, set <code>ORIGIN</code> to your machine's
			LAN address before starting:
		</p>
		<pre><code>ORIGIN=http://&lt;lan-ip&gt;:4174 docker compose up -d</code></pre>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Warning:</strong> the app has <strong>no authentication</strong>. Binding to
				the LAN means anyone who can reach <code>&lt;lan-ip&gt;:4174</code> can see
				submissions, grades, and settings. Only do this on a trusted network — and add
				authentication plus TLS before any Internet-facing exposure. See
				<a href="#security">Security &amp; Trust Boundaries</a>.
			</p>
		</div>
		<h3>Tailscale</h3>
		<p>
			If the machine is on your tailnet, you can reach the app from anywhere on the tailnet
			via its Tailscale IP — set <code>ORIGIN</code> to
			<code>http://&lt;tailscale-ip&gt;:4174</code> accordingly.
		</p>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Same rule as LAN:</strong> a tailnet still grants every member access to an app
				with no login — there is no per-user security inside the app. Keep it to people you trust,
				or add authentication first.
			</p>
		</div>
		<h3>Data Persistence</h3>
		<p>
			Both containers bind the repo's <code>./data</code> directory directly to
			<code>/app/data</code> — <strong>no named volume, no copy step</strong>. Tracked config
			(assignments, criteria, scoring, grading config, settings) lives in your git tree;
			runtime state (<code>submissions/</code>, <code>materials/</code>,
			<code>copilot/</code>,
			<code>plagiarism/</code>, <code>docs-index/</code>) lives in the same tree but is
			gitignored. Everything survives container restarts and recreated containers. Use
			<a href="#backup">Backup &amp; Restore</a> for off-machine copies.
		</p>
		<h3>Upgrading</h3>
		<p>Pull the latest code and rebuild the images:</p>
		<pre><code
				>git pull
docker compose up -d --build</code
			></pre>
		<div
			class="callout mt-4 flex items-start gap-3 rounded-lg border border-primary/10 bg-primary/5 p-4"
		>
			<Info size={16} class="mt-0.5 shrink-0 text-primary" />
			<p class="m-0 text-sm text-foreground">
				<strong>Back up first:</strong> download a backup ZIP before upgrading so you can restore
				if anything goes wrong.
			</p>
		</div>
	</section>

	<!-- Security & Trust Boundaries -->
	<section id="security">
		<h2>Security &amp; Trust Boundaries</h2>
		<p>
			SciPro Review is a <strong
				>single-operator grading tool, not a multi-user web service</strong
			>. Read this section before changing any port binding or deployment.
		</p>
		<h3>Loopback-only by default, no authentication</h3>
		<ul>
			<li>
				The teacher app binds <code>127.0.0.1:4174</code> only (loopback) and has
				<strong>no authentication or access control</strong> — the port <em>is</em> the permission.
				Anyone who can reach it can read submissions, grades, and settings.
			</li>
			<li>
				The loopback-only model therefore protects exactly <strong>one machine</strong>: the
				one the app runs on.
			</li>
			<li>
				<strong
					>Never expose the app on the LAN or the Internet without first adding
					authentication and TLS.</strong
				> The compose file pins the loopback bind for this reason; widening it is a deliberate,
				security-relevant change.
			</li>
			<li>
				If you do widen access, <code>ORIGIN</code> must match the address teachers actually
				use, or adapter-node's CSRF guard rejects form POSTs (uploads, materials) with a
				<code>403</code>. See <a href="#troubleshooting">Troubleshooting</a>.
			</li>
		</ul>
		<h3>The executor sandbox — and its limit</h3>
		<ul>
			<li>
				Student notebooks are <strong>untrusted code</strong>. The executor container runs
				with no Linux capabilities (<code>cap_drop: ALL</code>),
				<code>no-new-privileges</code>, a read-only rootfs, a <code>tmpfs</code>
				<code>/tmp</code>, and a pids cap (fork-bomb guard) — but it is
				<strong>not hardened sandboxing</strong>.
			</li>
			<li>
				<strong>Residual vector:</strong> the executor shares the Docker bridge (<code
					>app-net</code
				>) with the frontend container, so a malicious notebook could attempt to reach the
				frontend's own port. This is a documented, accepted risk for the localhost-only
				model — another reason the whole stack must stay loopback-only.
			</li>
		</ul>
		<h3>Untrusted notebook content</h3>
		<ul>
			<li>
				Notebook text is <strong>screened before it enters any LLM prompt</strong>
				(instruction-smuggling guard). On a hit the flagged cells are stripped from the prompt
				and the row is marked <code>needs_review</code>. The guard fails open — grading
				never breaks because it erred.
			</li>
		</ul>
		<h3>Secrets and the docs index</h3>
		<ul>
			<li>
				API keys belong only in <code>.env</code> (or the runtime Settings → Execution &amp;
				AI page) — <strong>never</strong> in <code>data/settings.yaml</code> and never committed.
			</li>
			<li>
				The prebuilt docs index is published as a <strong
					>publicly downloadable GitHub release (~680 MB)</strong
				> — a bandwidth consideration, not a secret.
			</li>
		</ul>
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

	.doc-content .note {
		border-left: 3px solid var(--accent);
		background: color-mix(in oklch, var(--accent) 6%, transparent);
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius);
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

	.doc-content code {
		font-size: 0.875rem;
		font-family: ui-monospace, "Fira Code", monospace;
		background: var(--background);
		border: 1px solid var(--border);
		padding: 0.125rem 0.25rem;
		border-radius: 0.25rem;
	}

	.doc-content pre {
		margin: 0.75rem 0;
		padding: 0.875rem 1rem;
		border-radius: var(--radius);
		background: var(--background);
		border: 1px solid var(--border);
		overflow-x: auto;
	}

	.doc-content pre code {
		padding: 0;
		border: none;
		background: transparent;
		font-size: 0.8125rem;
		line-height: 1.6;
	}

	.doc-content a {
		color: var(--primary);
		text-decoration: underline;
		text-underline-offset: 2px;
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
