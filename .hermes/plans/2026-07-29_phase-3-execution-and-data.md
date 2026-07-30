# Phase 3: Real Data & Execution

> **Status:** 📝 Plan ready for review. Phase 2 delivers the teacher UI scaffold with stub data. Phase 3 builds the entire backend pipeline — LLM-powered pre-processing, notebook execution, auto-fix tool, cell comparison, grade persistence, and export. The Phase 4 agentic copilot calls the tools Phase 3 creates.
>
> **Prerequisites:** Phase 2 ✅ — all 12 implementation items complete. Submissions dashboard, per-submission review, upload panel, TanStack Table, tabbed right panel, all 4 cell markers, reference comparison, rubric + grading tabs, error/loading states.
>
> **Dependencies:** Docker, Python 3.11+, KI Connect NRW API access (qwen3-30b-a3b-instruct model).
>
> **Goal:** Replace every stub with real data flows. Build the full teacher backend: LLM-based notebook pre-processing (via KI Connect), file-backed execution pipeline, auto-fix tools, API routes, and data persistence. Everything that was a toast placeholder becomes real. The auto-fix and LLM services are built as tools that Phase 4's agentic copilot will call.
>
> **Phase 4 boundary:** Phase 4 is ONLY the agentic copilot — Mastra agent, chat UI, suggestion cards, streaming, tool orchestration. Everything else (LLM integration, auto-fix, pre-processing, KI Connect client) is Phase 3.

---

## Ground Truth Decisions

These decisions are consistent with the Phase 1–4 master plan and Design Decision Record (DDR). If a conflict arises, the DDR wins.

### D1 — Phase 3 tools are standalone; Phase 4 orchestrates them

All LLM-powered capabilities (pre-processing, auto-fix, cell analysis) are built in Phase 3 as **standalone tools** with clean API interfaces. Each tool:
- Has its own endpoint or function signature
- Can be called directly by the teacher via the UI
- Returns structured, typed results
- Is independent of the agentic copilot

Phase 4 (the Mastra agent) **calls these same tools** as its toolchain. It adds orchestration, conversation memory, streaming, and the chat UI — but no new backend capabilities.

| Capability | Phase 3 delivers | Phase 4 adds |
|------------|-----------------|--------------|
| Notebook pre-processing | LLM-based analysis + normalization (KI Connect) | — (same tool) |
| Auto-fix | Tool that fixes broken cells, returns diff | Agent orchestrates multi-cell fixes |
| Cell comparison | LLM-based task segmentation + per-task comparison | — (same pipeline, richer context) |
| Error detection | Structured error capture | — (same data) |
| Suggest grade | LLM-powered via KI Connect, logged to console | Agent presents in Copilot tab with rubric context |
| Draft notes | LLM-powered via KI Connect, logged to console | Agent generates from rubric selections in Copilot tab |
| Generate feedback text | [Generate] button compiles rubric + grading into editable text | — (same, surfaced in Copilot tab) |
| Reset review | [Reset] button clears all selections for next student | — (same) |
| Grading sliders (teacher mode) | Wired to `/api/submissions/[id]/save` via Phase 3b | — (same) |
| Pre-evaluate | — | Agent batch-suggests grades across submissions |
| Chat | — | Conversation UI with tool calls |

### D2 — The data boundary is the `submissions-store.ts` file

Phase 2's stub service (`listSubmissions()`, `getSubmission(id)`) has a clean interface. Phase 3 replaces the implementation with `fetch()` calls to `/api/submissions` endpoints. The **call sites don't change** — only the store implementation.

### D3 — Phase 3 is additive: all Phase 2 code stays

The `IS_PHASE_2_STUB` flag pattern in components gets removed in favor of real data fetching. The `submissions-store.ts` stub functions stay as a fallback in static builds (where `__TEACHER_MODE__` is false). In the node build, the store is replaced with API calls.

### D4 — No authentication in Phase 3

The teacher app runs locally (Docker desktop or dev server). There is no multi-user auth. The `app.d.ts` `Locals` interface stays empty. Security boundaries (CORS, file access) are at the Docker level, not the app level.

### D5 — Status polling, not WebSockets

Batch processing uses short polling: the dashboard polls `GET /api/submissions` every 2 seconds while any submission has status `pending` or `executing`. This is simpler than WebSockets for a local Docker deployment and avoids adding Socket.io or similar.

### D6 — Cell comparison uses LLM-based task grouping from Phase 3 start

The two-stage LLM pipeline (detailed design below) handles the full diversity of student notebook structures — inconsistent headings, single-cell solutions, extra tasks, missing tasks, and multi-file submissions. Phase 3 ships with this working.

The approach is:
1. **Stage 1 — Task segmentation**: KI Connect analyzes the student notebook alone, groups cells into logical task segments
2. **Stage 2 — Per-task comparison**: For each segment, KI Connect compares the student's cells against the corresponding key cells
3. **Fallback**: If KI Connect is unavailable, cell comparison defaults to "different approach" for all cells (no position-based matching)

---

## Phase 3 Architecture

```
┌─ Browser ───────────────────────────────────────────────────────┐
│                                                                  │
│  SvelteKit (ADAPTER=node, port 4174)                             │
│                                                                  │
│  Pages:      /submissions/ (dashboard)   /submissions/[id]/      │
│                                                                  │
│  API routes:                                                     │
│  ┌─ /api/submissions ──────────────────────────────────────┐     │
│  │  GET /, POST /upload, POST /process, [id]/ GET/POST     │     │
│  └─────────────────────────────────────────────────────────┘     │
│  ┌─ /api/assignments ──────────────────────────────────────┐     │
│  │  GET /, [id]/materials (GET+POST)                        │     │
│  └─────────────────────────────────────────────────────────┘     │
│  ┌─ /api/auto-fix ─────────────────────────────────────────┐     │
│  │  POST / → fix broken cell → returns diff + suggestion    │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
│  SvelteKit services:                                             │
│  ┌─ Cell Comparison Engine ───────────────────────────────┐     │
│  │  compareCells() → markers + summary                     │     │
│  └─ KI Connect client ────────────────────────────────────┘     │
│  │  kiConnectClient.analyze(cells, context)                    │     │
│  │  kiConnectClient.autofix(cell, error)                       │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
│  Data: /app/data/ (shared named volume)                          │
│  ├── assignments.yaml   ├── criteria/        ├── materials/      │
│  └── submissions/<id>/{.ipynb, metadata.json, results.json}     │
└──────────────────────────────────────────────────────────────────┘
         │ internal HTTP
         ▼
┌─ Executor (Python, port 8766, internal) ─────────────────────────┐
│                                                                   │
│  POST /execute        → pre-process + run .ipynb                  │
│  POST /auto-fix       → LLM-based cell fix suggestion             │
│  GET  /health         → health check                             │
│                                                                   │
│  Internal pipeline per notebook:                                  │
│  ┌─ 1. Pre-process (LLM via KI Connect) ──────────────────────┐  │
│  │  • Analyze notebook structure, imports, paths, shell cmds   │  │
│  │  • Normalize paths (absolute → relative)                    │  │
│  │  • Strip Colab imports                                      │  │
│  │  • Strip harmful shell commands (!pip, !wget)               │  │
│  │  • Generate structured annotations per cell                 │  │
│  │  • Returns: normalized notebook + annotation list           │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  ┌─ 2. Execute (nbclient) ───────────────────────────────────┐  │
│  │  • Run normalized notebook cell by cell (30s timeout)      │  │
│  │  • Capture source, output, error, execution_count           │  │
│  │  • Kernel lifecycle: create → execute → shutdown            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  ┌─ 3. Post-process (LLM via KI Connect) ─────────────────────┐  │
│  │  • Detect error patterns in failed cells                   │  │
│  │  • Generate fix suggestions for auto-fix tool               │  │
│  │  • Enrich cell comparison data                              │  │
│  │  • Returns: fix suggestions + enriched annotations          │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  KI Connect client (in executor):                                 │
│  • Base: https://chat.kiconnect.nrw/api/v1                        │
│  • Model: qwen3-30b-a3b-instruct-2507                            │
│  • Skip if unavailable: notebook runs without LLM pass            │
│                                                                   │
│  Shared /app/data/ volume with SvelteKit                          │
└───────────────────────────────────────────────────────────────────┘
```

**Key change from earlier drafts:** The executor now calls KI Connect directly for pre-processing and post-processing. The SvelteKit layer also has a KI Connect client for lightweight analysis tasks (cell comparison enrichment). The auto-fix tool is a POST endpoint that the Phase 4 Copilot will call as a tool.

**Phase 3 capabilities summary:**
| Component | LLM? | Purpose |
|-----------|------|---------|
| Notebook pre-processor | ✅ KI Connect | Analyze, normalize, annotate before execution |
| Auto-fix tool | ✅ KI Connect | Suggest cell fixes based on error + context |
| Cell comparison engine | Optional KI Connect | Enrich comparison with semantic analysis |
| Error detection | ❌ Deterministic | Structured capture of execution errors |
| File upload/classification | ❌ Regex-based | Classify by filename pattern |
| Grade persistence | ❌ Filesystem | metadata.json CRUD |

---
---

## Phase 3 Breakdown — 8 Sub-Phases

Phase 3 is divided into eight sequentially-dependent sub-phases. Each builds on the previous one. Within each sub-phase, work can be parallelized.

| Phase | What it delivers | Design before build? |
|-------|-----------------|---------------------|
| **3a Foundation** | KI Connect client, Python executor (nbclient + FastAPI), LLM pre-processing, Docker Compose | — (infrastructure) |
| **3b Data Layer** | 10 API endpoints, metadata/filesystem persistence, cell comparison engine, grading export | — (API design decisions) |
| **3c LLM Tools** | Auto-fix, Suggest Grade, Draft Notes — standalone endpoints | — (API design decisions) |
| **3d Plagiarism** | Two-stage comparison (structural + LLM), API endpoints | — (API design decisions) |
| **3e Auto-Fix UI** | OD mockup → inline Suggest Fix card on execution-output.svelte | ✅ Mockup before build |
| **3f Plagiarism UI** | OD mockup → dashboard modal with expandable flagged pairs | ✅ Mockup before build |
| **3g Frontend** | Store replacement, dashboard/per-submission wiring, processing overlay | — (existing Phase 2 UI, wire to real API) |
| **3h Docs** | DDR corrections, master plan updates | — (capture what got built) |

Key principle: infrastructure and API work don't need mockups — the data shapes are already defined by the Phase 2 types. Only the two new UI surfaces (auto-fix card, plagiarism modal) need OD mockups before implementation.

---

### Phase 3a — Foundation (KI Connect + Executor + Docker)

**Goal:** Get the core infrastructure running: LLM client, notebook executor, sandbox, Docker containers.

| WP | What | Files | Depends on |
|----|------|-------|-----------|
| 3a.1 | **KI Connect client** (Python + TypeScript) | `executor/ki_connect.py`, `src/lib/server/ki-connect.ts` | — |
| 3a.2 | **Python executor** (FastAPI + nbclient) | `executor/main.py`, `executor/runner.py`, `executor/requirements.txt` | 3a.1 |
| 3a.3 | **Pre-processing pipeline** (LLM-based sanitization) | `executor/preprocessor.py` | 3a.1, 3a.2 |
| 3a.4 | **Docker infrastructure** | `frontend/Dockerfile`, `executor/Dockerfile`, `docker-compose.yml`, `docker-compose.override.yml`, `docker-compose.prod.yml`, `.dockerignore` | 3a.2, 3a.3 |

**Deliverable:** `docker compose up` starts both containers, executor responds to `/execute` and `/health`, KI Connect client can make test calls.

---

### Phase 3b — Data Layer (API Routes + Persistence)

**Goal:** All CRUD operations work against real filesystem data. The dashboard and per-submission page load real data.

| WP | What | Files | Depends on |
|----|------|-------|-----------|
| 3b.1 | **Server modules** | `src/lib/server/metadata.ts`, `src/lib/server/file-service.ts`, `src/lib/server/executor-client.ts`, `src/lib/server/yaml-loader.ts` | 3a.4 |
| 3b.2 | **Cell comparison engine** — LLM-based | `src/lib/server/cell-comparison.ts` | KI Connect needed |
| 3b.3 | **API routes** (submissions, assignments, upload, process, save, grade) | `src/routes/api/submissions/`, `src/routes/api/assignments/` | 3b.1, 3b.2 |
| 3b.4 | **Export service** | `src/lib/server/export-service.ts` + `GET /api/submissions/[id]/export` | 3b.3 |

**API surface (10 endpoints):**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/submissions` | GET | List all submissions for active assignment |
| `/api/submissions/[id]` | GET | Full detail: cells + markers + reference comparison |
| `/api/submissions/upload` | POST | Upload files (multipart), classify, persist |
| `/api/submissions/process` | POST | Batch execute pending submissions |
| `/api/submissions/[id]/process` | POST | Execute single submission |
| `/api/submissions/[id]/save` | POST | Save grading state (rubric + slider positions) |
|
|**Grading slider wiring:** The `handleUpdateDimension` no-op and hardcoded `totalDeductions = 0` in `submissions/[id]/+page.svelte` are replaced by real API calls to `/api/submissions/[id]/save`. Grading input changes trigger the save endpoint; the grade slider values persist across page loads.
| `/api/submissions/[id]/grade` | POST | Finalize grade, update status to "graded" |
| `/api/submissions/[id]/export` | GET | Download grading YAML |
| `/api/assignments` | GET | List assignments from YAML |
| `/api/assignments/[id]/materials` | GET+POST | Check/upload materials (pdf, key, data) |

**Deliverable:** Dashboard loads real submissions from API. [Process All] triggers executor. [Save Grade] persists to metadata.json. [Export YAML] downloads real data.

#### Cell comparison engine — detailed design

**File:** `src/lib/server/cell-comparison.ts`

**When it runs:** On `GET /api/submissions/[id]` — the endpoint loads the student's executed cells and the key cells, runs comparison, returns markers + summary + reference notes.

**The approach:** Two-stage LLM pipeline that separates segmentation from comparison, with a fallback for edge cases.

**Stage 1 — Task segmentation** (1 KI Connect call per student notebook):

Send only the student notebook to KI Connect with a segmentation prompt. No key context needed. Return a list of detected tasks with cell index ranges:

```json
{
  "tasks": [
    { "id": 1, "title": "Data Preparation", "cell_range": [3, 7], "confidence": 0.95 },
    { "id": 2, "title": "Clustering and Visualization", "cell_range": [8, 12], "confidence": 0.92 },
    { "id": 3, "title": "Model Parameter Optimization", "cell_range": [13, 17], "confidence": 0.88 },
    { "id": 4, "title": "Prediction and Visualization", "cell_range": [18, 22], "confidence": 0.85 },
    { "id": 5, "title": "Comments on Results", "cell_range": [23, 24], "confidence": 0.90 },
    { "id": -1, "title": "Additional Analysis", "cell_range": [25, 27], "confidence": 0.70 }
  ],
  "unassigned_cells": [0, 1, 2],
  "notebook_structure": "well_structured" | "single_cell" | "no_headings" | "mangled"
}
```

This stage is lightweight — it only needs to understand the student's notebook structure, not compare anything. Cell ranges are 0-based indices into the flat cell array.

**Stage 2 — Per-task comparison** (up to 5 parallel KI Connect calls):

For each detected task from Stage 1, send a focused comparison prompt with:
- The student's cells for that task (sources + outputs)
- The key's cells for the same task (sources + outputs)
- The task description from the assignment rubric

These calls are **independent and can run in parallel** — all 5 tasks compared simultaneously:

```
Compare this student's Task 2 work against the key's Task 2 work.

Student Task 2 cells:
  [source: kmeans = KMeans(n_clusters=3)
   output: KMeans(n_clusters=3)]
  [source: df['cluster'] = kmeans.fit_predict(...)
   output: ]
  [source: plt.scatter(df['x'], df['y'], c=df['cluster'])
   output: [scatter plot image]]

Key Task 2 cells:
  [source: k_means(...)
   output: ...]

Return a JSON:
- marker: "same" | "different" | "questionable" | "error"
- explanation: brief comparison text for the teacher
- summary_line: single line for the dashboard overview
```

Each call returns a single marker for that task. The five markers are then aggregated into the summary string.

**Fallback — Combined approach:**

If Stage 1 segmentation fails (confidence < 0.5 for all tasks, or notebook structure detected as "mangled"), fall back to a single combined call that sends both notebooks together. This handles the edge cases where segmentation alone can't determine the student's task layout:

```json
{
  "notebook_structure": "mangled",
  "analysis": "Combined single-cell submission with markdown embedded in code comments",
  "segments": [
    { "task": 1, "cells": [0], "marker": "different", "note": "Data loading in lines 1-10 of the single cell" },
    { "task": 2, "cells": [0], "marker": "same", "note": "KMeans clustering in lines 11-25" },
    ...
  ]
}
```

**Edge cases the segmentation prompt must handle:**

| Student submission style | How Stage 1 handles it | Stage 2 fallout |
|-------------------------|----------------------|-----------------|
| Clean `## Task N` headings | Easy segmentation | Normal comparison |
| Inconsistent headings (`**Task 1**`, `### (a)`, `1.`) | Content + topic analysis | Normal comparison |
| No headings, code in multiple cells | Segments by code transitions (`pd.read_csv` → `KMeans` → `curve_fit`) | Normal comparison |
| **Everything in one code cell** | Splits by logical blocks, comments, blank lines | Single cell may map to multiple tasks |
| Markdown in raw/code cells | Detects markdown syntax inside code content | Treated as content |
| Mixed cell types | All cells analyzed uniformly by content | Normal comparison |
| Extra tasks | Listed as `additional_work` | No key to compare against |
| Missing tasks | Task not found in segmentation | Listed as `not_found` |

**Why two-stage over single call:**

| | Single combined call | Two-stage |
|--|---------------------|-----------|
| Tokens per call | Both notebooks ~2000+ cells | Segmentation: 1 notebook (half the tokens). Comparison: 2 tasks (smaller) |
| Parallelism | None — one sequential call | 5 comparison calls in parallel |
| Debugging | Hard to tell if segmentation or comparison failed | Stage 1 output is inspectable independently |
| Edge case handling | One prompt must handle everything | Fallback to combined if Stage 1 fails |
| Total latency | ~10-20s sequential | ~3-5s segmentation + max(~5s parallel) = ~8-10s |
| Total cost | 1 LLM call | 1 + N parallel LLM calls (more total calls but each is smaller) |

**Caching:** Cache both the segmentation result (Stage 1) and the comparison results (Stage 2) in `cells.json` alongside execution data. Re-run only when the student notebook or key changes. Segmentation is cached separately from comparison — if only the key changes (e.g., teacher uploads a corrected key), only Stage 2 re-runs.

---

### Phase 3c — LLM Tools (Auto-Fix, Suggest Grade, Draft Notes)

**Goal:** Three standalone LLM-powered tools, each with a clean API surface. Phase 4's Copilot calls these same endpoints.

| WP | What | Files | Depends on |
|----|------|-------|-----------|
| 3c.1 | **Auto-fix tool** | `executor/auto_fix.py`, `src/routes/api/auto-fix/+server.ts` | 3b.3 (needs API infra) |
| 3c.2 | **Suggest Grade tool** | `src/routes/api/suggest-grade/+server.ts` | 3b.3, 3a.1 |
| 3c.3 | **Draft Notes tool** | `src/routes/api/draft-notes/+server.ts` | 3b.3, 3a.1 |

**Tool API surface:**

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/api/auto-fix` | POST | `{ cell_source, cell_error, cell_index, context_cells[] }` | `{ suggestion, explanation, confidence }` |
| `/api/suggest-grade` | POST | `{ rubric, cells[], grading_config, assignment_id }` | `{ dimension_scores, grade, explanation }` |
| `/api/draft-notes` | POST | `{ rubric_selections, grading_inputs, cells[] }` | `{ notes: string }` |

**Phase 3 behavior:** All three tools call KI Connect and log results to browser console (console.debug). No inline UI — the buttons exist, call the API, and the result is visible to developers.

**Phase 4 behavior:** The Copilot agent calls these same endpoints as Mastra tools, presenting results in the chat UI with suggestion cards.

**Deliverable:** Clicking [Suggest Grade] on the per-submission page calls KI Connect and logs the suggested scores. Clicking [Draft Notes] logs generated feedback. Clicking [Suggest Fix] on an error cell logs a fix suggestion.

---

### Phase 3d — Plagiarism Check

**Goal:** Batch comparison of all executed submissions to detect similar approaches (potential copying). LLM-assisted semantic comparison + structural code fingerprinting.

**Comparison strategy (two-stage):**

1. **Structural pass** (deterministic, fast): Compare all submission pairs using:
   - Cell count similarity
   - Variable name overlap
   - Comment similarity (exact text match)
   - Import statement overlap
   - Code structure fingerprint (AST-based)

2. **LLM pass** (KI Connect, targeted): For pairs flagged by the structural pass above a threshold, send to KI Connect for semantic analysis:
   - "Are these two submissions doing the same thing in the same way?"
   - "Do they share unusual variable names or code structure?"
   - Return a similarity score + explanation

| WP | What | Files | Depends on |
|----|------|-------|-----------|
| 3d.1 | **Structural comparison engine** | `src/lib/server/plagiarism/structural.ts` | — (pure logic, testable standalone) |
| 3d.2 | **LLM comparison client** | `src/lib/server/plagiarism/semantic.ts` (uses KI Connect) | 3a.1 |
| 3d.3 | **API routes** | `src/routes/api/plagiarism/check/+server.ts`, `src/routes/api/plagiarism/results/+server.ts` | 3d.1, 3d.2 |

**API surface:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/plagiarism/check` | POST | Trigger pairwise comparison of all executed submissions |
| `/api/plagiarism/results` | GET | Return similarity matrix + flagged pairs |
| `/api/plagiarism/results/[id]` | GET | Return detailed comparison for a specific submission pair |

**Data model:**

```typescript
interface PlagiarismResult {
  status: "pending" | "checking" | "done" | "error";
  pairs: PlagiarismPair[];
  generated_at: string;
}

interface PlagiarismPair {
  student_a: string;       // studentId
  student_b: string;       // studentId
  structural_score: number;  // 0.0–1.0 from structural pass
  semantic_score?: number;   // 0.0–1.0 from LLM pass (null if not checked)
  combined_score: number;    // weighted combination
  flags: string[];           // e.g., ["same_variable_names", "same_comments", "same_cell_structure"]
  details: {
    cell_count_diff: number;
    shared_variable_names: string[];
    shared_comments: string[];
    shared_imports: string[];
  };
}
```

**Result view (dashboard modal):**
- Button on dashboard: "Check Plagiarism"
- Modal shows: pairwise similarity matrix or flagged pairs list
- Each flagged pair expandable for detail: which cells match, variable name overlap, LLM assessment
- Same pattern as processing overlay — modal, not a new page

**Deliverable:** Dashboard has a "Check Plagiarism" button. Clicking it triggers batch comparison. Results appear in a modal with flagged pairs ordered by similarity score.

---

### Phase 3e — Auto-Fix Inline UI

**Goal:** One button + inline card on the existing `execution-output.svelte` component. Teacher clicks [Suggest Fix] on an error cell, sees the suggestion, can Apply or Dismiss.

| WP | What | Files | Depends on |
|----|------|-------|-----------|
| 3e.1 | **Auto-fix card mockup** | OD mockup for the suggestion card | — (design first) |
| 3e.2 | **Auto-fix inline UI** | Modify `execution-output.svelte` | 3c.1 (auto-fix endpoint), 3e.1 (mockup) |

**Auto-fix UI detail:**

The auto-fix result belongs on the cell itself, not in a separate panel:

```
┌─ Cell 4 (error) ────────────────────────────────────────┐
│  source: result = curve_fit(model_func, x_data, y_data)  │
│                                                          │
│  ❌ NameError: name 'curve_fit' is not defined           │
│     from scipy.optimize import curve_fit ← Did you mean? │
│                                                          │
│  [Suggest Fix]                                           │
│                                                          │
│  (after clicking)                                        │
│  ┌─ Suggested fix ──────────────────────────────────┐    │
│  │  Add: from scipy.optimize import curve_fit        │    │
│  │  Confidence: 92%                                  │    │
│  │  [Apply] [Dismiss]                                │    │
│  └───────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

This is one button + one inline card on the existing `execution-output.svelte`. No new panel, no tab, no chat. The Phase 4 Copilot can call the same `/api/auto-fix` endpoint independently.

**Deliverable:** Teacher clicks [Suggest Fix] on any error cell → inline card shows suggestion → Apply/Dismiss buttons work.

---

### Phase 3f — Plagiarism Results UI

**Goal:** Dashboard modal that displays the plagiarism comparison results with expandable flagged pairs.

| WP | What | Files | Depends on |
|----|------|-------|-----------|
| 3f.1 | **Plagiarism results mockup** | OD mockup for the results modal | 3d.3 (plagiarism API exists) |
| 3f.2 | **Plagiarism results UI** | Modal component + dashboard button | 3d.3, 3f.1 |

**Result view (dashboard modal):**
- Button on dashboard: "Check Plagiarism"
- Modal shows: pairwise similarity matrix or flagged pairs list
- Each flagged pair expandable for detail: which cells match, variable name overlap, LLM assessment
- Same overlay pattern as processing overlay — modal, not a new page

---

### Phase 3g — Frontend Integration

**Goal:** Everything connects. The UI loads real data, buttons trigger real actions, processing overlay shows live status.

| WP | What | Files | Depends on |
|----|------|-------|-----------|
| 3g.1 | **Store replacement** | `src/lib/services/submissions-api.ts`, `src/lib/services/assignments-api.ts`, modify `submissions-store.ts` | 3b.3 |
| 3g.2 | **Dashboard wiring** | Modify `src/routes/submissions/+page.svelte` | 3g.1 |
| 3g.3 | **Per-submission wiring** | Modify `src/routes/submissions/[id]/+page.svelte` | 3g.1 |
| 3g.4 | **Processing overlay** | `src/lib/components/submissions/processing-overlay.svelte` | 3g.2 |
| 3g.5 | **Generate + Reset buttons** | Add [Generate] button (inline textarea, editable before saving) and [Reset] button to per-submission page header. Wire to `reviewStore.generateText()` and `reviewStore.reset()`. The Generate button shows the compiled feedback inline rather than navigating away. | 3g.3 |

**Deliverable:** Full end-to-end flow works: upload → process → view cells → suggest fix → generate feedback → save grade → export.

---

### Phase 3h — Documentation Refresh

**Goal:** Update DDR and OD mockups to reflect current reality. Done last since it captures what got built.

| WP | What | Files | Depends on |
|----|------|-------|-----------|
| 3h.1 | **DDR corrections** | Update `.hermes/plans/2026-07-28_ddr.md` — stub matrix, new UI elements | All prior phases |
| 3h.2 | **Update master plan** | Resolved questions in `refined-master-plan.md` | All prior phases |

---

### Implementation Order by Sub-Phase

| Order | Phase | What it unlocks |
|-------|-------|----------------|
| 1 | **3a.1** KI Connect client | Everything LLM-related depends on this |
| 2 | **3a.2** Python executor | Core execution pipeline |
| 3 | **3a.3** Pre-processing | Clean notebook execution |
| 4 | **3a.4** Docker | Integration testing environment |
| 5 | **3b.1** Server modules | All API routes |
| 6 | **3b.2** Cell comparison | Execution results become meaningful |
| 7 | **3b.3** API routes | Frontend can load real data |
| 8 | **3b.4** Export service | Teacher can download grades |
| 9 | **3c.1–3c.3** LLM Tools | Auto-fix, suggest, draft all work |
| 10 | **3d.1–3d.3** Plagiarism | Batch comparison engine |
| 11 | **3e.1** Auto-fix mockup | Visual spec for inline card |
| 12 | **3e.2** Auto-fix inline UI | Teacher can fix broken cells |
| 13 | **3f.1** Plagiarism mockup | Visual spec for modal |
| 14 | **3f.2** Plagiarism results UI | Teacher can review flagged pairs |
| 15 | **3g.1–3g.4** Frontend wiring | Full end-to-end flow |
| 16 | **3h.1–3h.2** Docs refresh | Documentation matches reality |

**Parallelization opportunities:**
- 3b.2 (cell comparison) and 3b.4 (export) are pure logic — can start alongside 3b.1
- 3d.1 (structural plagiarism) is pure logic — can start after 3b.2
- 3e.1 (auto-fix mockup) can start as soon as the auto-fix endpoint spec is clear (after 3c.1)
- 3f.1 (plagiarism mockup) can start as soon as the plagiarism API spec is clear (after 3d.3)

---

## What Phase 4 Covers (Only the Agentic Copilot)

Phase 4 is exclusively the **agentic orchestration layer**. Every tool it uses is built in Phase 3.

| Feature | Phase 3 status | Phase 4 adds |
|---------|---------------|--------------|
| AI Copilot chat interface | — | Real chat UI with Mastra agent |
| Suggestion cards (Apply/Dismiss) | — | Rendered in Copilot tab |
| Suggest Grade button | ✅ Calls KI Connect, logs to console | Agent calls with full rubric context, shows in Copilot tab |
| Draft Notes button | ✅ Calls KI Connect, logs to console | Agent generates from rubric selections, shows in Copilot tab |
| Pre-evaluate All button | Toast: "coming in Phase 4" | Batch agent orchestration |
| Apply Fix button | ✅ Calls `/api/auto-fix`, inline card on cell | Agent presents in suggestion card with full context |
| Plagiarism check | ✅ Dashboard button + modal results | Agent can discuss flagged pairs conversationally |
| Apply Grade Change | Toast | Agent updates grading sliders |
| Context-aware tab switching | Manual click only | Agent-driven tab switching |
| LLM cell comparison (task grouping) | Structural + KI Connect enrichment | Full semantic task grouping |
| Mastra agent setup | — | Installed and configured |
| Tool orchestration | Tools exist as standalone endpoints | Agent chains them conversationally |

**Phase 3 ships with:** Auto-fix (inline card on cells), Suggest Grade (console), Draft Notes (console), Plagiarism Check (dashboard modal). All powered by KI Connect. The Copilot tab stays stub. Phase 4 builds the conversational Copilot UI on top of these same endpoints.

## Python Environment & Edge Case Handling

### 3.1 Executor Python dependencies

Based on analysis of Karl Kirschner's full course material (39 notebooks, 1086 code cells across the curriculum) and past assignment criteria from `scipro_assignments_grading`:

**Core — required for execution:**
| Library | Notebooks using it | Course topics |
|---------|-------------------|--------------|
| `numpy` | Virtually every notebook | Arrays, polynomials, random numbers, ML |
| `pandas` | Pandas, numpy, ML, stats notebooks | DataFrames, CSV loading, merging |
| `matplotlib` | Every visualization notebook | Plotting, figure customization |
| `scipy` | scipy_intro, existing_functions, styles, t-test | `integrate`, `interpolate`, `constants`, `optimize` |
| `scikit-learn` | ml_intro, ml_shallow, soil assignment | `cluster`, `linear_model`, `metrics`, `preprocessing` |
| `seaborn` | seaborn_visualization, t-test, ml_shallow | Statistical visualization |
| `sympy` | sympy notebook | Symbolic math, physics units |
| `ipykernel` | Required by nbclient | Jupyter kernel for execution |

**Assignment-specific — include for broader compatibility:**
| Library | Used in | Why include |
|---------|---------|-------------|
| `torch` | pytorch_intro, pytorch_nn_perceptron | Deep learning assignments (`sklearn_pytorch` criteria) |
| `sigfig` | styles notebook, sigfig criteria | Significant figures handling |
| `pytest` | testing_exceptions_unit notebooks | Unit testing assignments |

**Stdlib — already available, no install needed:**
`csv`, `math`, `random`, `os`, `sys`, `re`, `json`, `collections`, `typing`, `dataclasses`, `enum`, `pathlib`, `statistics`, `itertools`, `functools`, `decimal`, `copy`, `datetime`, `warnings`

**Final requirements.txt:**
```text
fastapi>=0.115.0
uvicorn[standard]>=0.34.0
nbformat>=5.10.0
nbclient>=0.10.0
jupyter-client>=8.6.0
ipykernel>=6.29.0
numpy>=2.1.0
pandas>=2.2.0
scipy>=1.14.0
scikit-learn>=1.5.0
matplotlib>=3.9.0
seaborn>=0.13.0
sympy>=1.13.0
torch>=2.4.0
sigfig>=1.3.0
pytest>=8.0.0
pydantic>=2.10.0
pydantic-settings>=2.7.0
httpx>=0.28.0
```

**Why torch despite its size:** PyTorch is ~800MB, but it's explicitly in the curriculum (two full notebooks + perceptron lab) and a past assignment category (`sklearn_pytorch`). Without it, PyTorch-based submissions fail entirely. The image size increase is acceptable for a teacher tool.

### 3.2 Google Colab import handling

Students frequently forget to remove Colab-specific imports. The executor handles these:

**Detection + stripping pattern** (in `executor/runner.py`):

```python
COLAB_PATTERNS = [
    r"from\s+google\.colab",
    r"import\s+google\.colab",
    r"from\s+google\.drive",
    r"import\s+google\.drive",
]

def sanitize_cells(cells: list[dict]) -> tuple[list[dict], list[int]]:
    """Strip environment-specific imports. Returns (modified_cells, indices_of_stripped_cells)."""
    stripped = []
    for i, cell in enumerate(cells):
        if cell.get("cell_type") != "code":
            continue
        source = cell.get("source", "")
        if isinstance(source, list):
            source = "".join(source)
        lines = source.split("\n")
        new_lines = []
        for line in lines:
            if any(re.search(p, line) for p in COLAB_PATTERNS):
                new_lines.append(f"# [SciPro] Stripped: {line.strip()}")
                if i not in stripped:
                    stripped.append(i)
            else:
                new_lines.append(line)
        cells[i]["source"] = "\n".join(new_lines)
    return cells, stripped
```

The executor returns `stripped_cells` info in the response. The SvelteKit cell comparison engine marks stripped cells as "different approach" and logs the stripping in the reference comparison UI.

### 3.3 Path normalization — auto-fix with annotations

Instead of guessing paths at execution time, the executor runs a **pre-execution sanitization** pass that normalizes all file paths in the student's code to a single standard, and annotates each change with a comment about the original practice.

**How it works:**

Before execution, scan every code cell for data-access calls (`pd.read_csv`, `pd.read_excel`, `np.loadtxt`, `np.genfromtxt`, `open`, `pd.to_csv`, `np.savetxt`, etc.):

```python
ACCESS_PATTERNS = [
    (r"(pd\.read_csv)\([\"']([^\"']+)[\"']",    "read"),
    (r"(pd\.read_excel)\([\"']([^\"']+)[\"']",   "read"),
    (r"(pd\.read_table)\([\"']([^\"']+)[\"']",   "read"),
    (r"(np\.loadtxt)\([\"']([^\"']+)[\"']",      "read"),
    (r"(np\.genfromtxt)\([\"']([^\"']+)[\"']",   "read"),
    (r"(open)\([\"']([^\"']+)[\"']",             "read|write"),
    (r"(pd\.to_csv)\([\"']([^\"']+)[\"']",       "write"),
    (r"(np\.savetxt)\([\"']([^\"']+)[\"']",      "write"),
    (r"(\.to_csv)\([\"']([^\"']+)[\"']",         "write"),
    (r"(\.to_excel)\([\"']([^\"']+)[\"']",       "write"),
]
```

For each path found, classify and annotate:

| Original path | Classification | Action | Annotation |
|---|---|---|---|
| `soil_contamination.csv` | ✅ Good (relative, matches data) | Leave as-is | `# SciPro: relative path ✓` |
| `./soil_contamination.csv` | ✅ Good (relative, matches data) | Leave as-is | `# SciPro: relative path ✓` |
| `./data/soil_contamination.csv` | ✅ Good (relative, subdirectory) | Create `data/` in sandbox, place file | `# SciPro: relative path ✓` |
| `/content/drive/.../soil_contamination.csv` | ⚠️ Absolute (mappable) | Rewrite to `soil_contamination.csv` | `# SciPro: normalized — was "{original}"` |
| `C:\Users\...\soil_contamination.csv` | ⚠️ Absolute (mappable) | Rewrite to `soil_contamination.csv` | `# SciPro: normalized — was "{original}"` |
| `/data/mystery.xyz` | ⚠️ Unknown file | Rewrite filename to match data, or leave | `# SciPro: unknown file — may fail` |
| `some_var` / f-strings | ❌ Dynamic (unparseable) | Leave as-is | No annotation (will succeed or fail naturally) |

**Annotation format:**

The annotation is inserted as a code comment **on the line before** the data-access call:

```python
# SciPro: relative path ✓
df = pd.read_csv("soil_contamination.csv")
```

```python
# SciPro: normalized — was "/content/drive/My Drive/soil_contamination.csv"
df = pd.read_csv("soil_contamination.csv")
```

```python
# SciPro: stripped Google Colab import — was "from google.colab import files"
# SciPro: normalized — was "/content/drive/My Drive/soil_contamination.csv"
df = pd.read_csv("soil_contamination.csv")
```

**Where annotations appear:**

The annotated notebook is **not** shown to the teacher directly (the review page shows the student's original code). Instead, the annotations are:

1. Stored as metadata alongside each cell's execution result
2. Surfaced in the **Reference Comparison** UI as per-cell notes under the diff explanation
3. Summarized in the submission header: "3 paths normalized, 1 Colab import stripped"

This means the teacher can see during review which paths were adjusted, without the annotations cluttering the student's original code display.

**What the teacher sees in the review UI:**

```
Cell 3: pd.read_csv("soil_contamination.csv")  [Executed ✓]
  └─ Path: normalized (was absolute path on line 12)
     → Relative path resolves to sandbox root ✓
```

**Key principles:**
- The student's original source code is preserved in the submitted notebook — annotations only exist in the execution result metadata
- Normalization is a best-effort convenience, not a guarantee of correctness
- If a path can't be resolved to a known data file, the cell executes as-is and either succeeds or fails naturally
- The annotation system is the bridge to Phase 4's AI-powered autofix: the same pattern detection feeds into `suggest-grade` and `autofix` tools

### 3.4 Input data isolation & cleanup

Student notebooks may write to or modify shared input data files. The executor prevents this:

1. **Sandbox creation**: Before execution, create a temp directory and copy all input data files into it
2. **Working directory**: Execute the notebook with its working directory set to the sandbox
3. **Post-execution diff**: Compare all files in the sandbox against the originals
4. **Modified file detection**: Report any detected modifications in the execution response
5. **Discard changes**: The sandbox is cleaned up after execution — only cell output results are captured

```python
import tempfile, shutil, filecmp
from pathlib import Path

def create_sandbox(data_paths: list[Path], notebook_path: Path) -> Path:
    """Create temp sandbox with copies of input data and notebook. Returns sandbox path."""
    sandbox = Path(tempfile.mkdtemp(prefix="scipro_"))
    for f in data_paths:
        if f.is_file():
            shutil.copy2(f, sandbox / f.name)
    # Copy notebook into sandbox
    shutil.copy2(notebook_path, sandbox / notebook_path.name)
    return sandbox

def detect_data_modifications(sandbox: Path, originals: list[Path]) -> list[str]:
    """Return list of filenames that were modified during execution."""
    modified = []
    for orig in originals:
        if not orig.is_file():
            continue
        sandbox_file = sandbox / orig.name
        if sandbox_file.exists() and not filecmp.cmp(orig, sandbox_file, shallow=False):
            modified.append(orig.name)
    return modified
```

### 3.4a Deterministic sanitization vs LLM pre-processing — clarification

The plan uses **two separate layers** that must not be confused:

| Layer | What it does | Method | When skipped |
|---|---|---|---|
| **Deterministic sanitization** | Strip Colab imports, normalize file paths, detect `!pip` commands | Regex patterns (always runs) | Never — these are local, safe operations |
| **LLM pre-processing** | Analyze notebook structure, generate per-cell annotations, segment tasks | KI Connect API call | Skipped if KI Connect is unavailable (`preprocessing: "skipped"`) |

**Key principle:** The "no regex fallback" decision refers only to the LLM pre-processing layer — if KI Connect is down, we skip LLM analysis entirely rather than attempt a poor regex imitation. The deterministic sanitization (Colab stripping, path normalization) always runs because it's purely mechanical and doesn't depend on any external service.

### 3.5 Error detection & auto-fix pipeline

The auto-fix pipeline is documented in **WP1c** above. In summary:

- **Phase 3:** The auto-fix tool is a standalone service. After execution, the post-processor captures structured error metadata from every failed cell and passes it to KI Connect for fix suggestions. The `/api/auto-fix` endpoint can be called directly from the UI.
- **Phase 4:** The Copilot agent calls the same `/api/auto-fix` endpoint as a Mastra tool, presenting suggestions in the chat UI with Apply/Dismiss cards.

Error types captured and their handling:

| Error type | Captured data | Phase 3 action | Phase 4 action |
|-----------|---------------|----------------|----------------|
| `ModuleNotFoundError` | Module name, import line | Log + optional retry | Autofix tool suggests fix |
| `FileNotFoundError` | Missing path | Log, mark as error | Autofix tool rewrites path |
| `SyntaxError` | Line, col, text | Log, mark as error | Autofix tool suggests correction |
| `NameError` | Variable name | Log, mark as error | Autofix tool suggests import |
| Timeout | Cell index, partial output | Log, kill kernel | Retry with longer timeout |

---

## Open Questions & New Gaps

| Question | Status |
|----------|--------|
| Should the executor be FastAPI or Flask? | ✅ FastAPI (already built by subagent) |
| Should docker-compose.yml live at repo root or in docker/? | ✅ Repo root (already created) |
| Does the static build need to gracefully degrade API imports? | ❌ No — build tree-shakes server code |
| Should the cell comparison engine be standalone or inline? | ✅ Service module in `$lib/server/` |
| Soil Contamination assignment library requirements? | ✅ numpy, pandas, scipy, sklearn, matplotlib |
| Processing overlay — partial failures? | ✅ Per-cell error capture, submission marked "error" |
| KI Connect API details? | ✅ Verified: `https://chat.kiconnect.nrw/api/v1`, OpenAI-compatible, Bearer auth |
| KI Connect rate limits for batch pre-processing? | ⚠️ Unknown — need to test parallel throughput |
| What if KI Connect is down? | ✅ Execute without pre-processing, flag as `preprocessing: "skipped"` |
| Suggest Grade / Draft Notes in Phase 3? | ✅ Yes — built as tools, results logged to console for debugging |
| Where do auto-fix/suggest/draft results display? | ✅ Browser console — Phase 4 builds the Copilot suggestion card UI |
| Does the Copilot tab stay fully stub in Phase 3? | ✅ Yes — chat UI is Phase 4 only |
| Regex fallback for pre-processing? | ❌ No — invest in good system prompt instead. If KI Connect is down, skip pre-processing |
| Docker executor needs outbound internet? | ✅ Yes — confirmed, standard Docker networking |

---

## Appendix A — Docker Infrastructure (Reference)

Already created by the Phase 2 subagent. Files committed to the repo:

| File | Purpose |
|------|---------|
| `frontend/Dockerfile` | Multi-stage Node build with pnpm, tini, health check |
| `executor/Dockerfile` | Python 3.12-slim, nbclient, FastAPI, non-root user |
| `docker-compose.yml` | Base: shared named volume `svelte-review-data`, internal network, health checks |
| `docker-compose.override.yml` | Dev: bind-mount `./data/`, expose executor on 8766, uvicorn --reload |
| `docker-compose.prod.yml` | Production: resource limits, no executor exposure, restart: always |
| `.env.example` | Template with `KI_CONNECT_API_KEY`, `EXECUTOR_URL`, Phase 4 LLM placeholders |
| `.dockerignore` | Excludes node_modules, build output, data dirs, git |
| `executor/app.py` | FastAPI stub with models, `/execute` + `/health` endpoints, CORS |

## Appendix B — Executor API Surface (Reference)

**Internal endpoints (executor container, port 8766):**

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/execute` | POST | `{"file_path": "/app/data/submissions/soil/2026SS_03.ipynb"}` | `{"cells": [{index, source, output, error, execution_count, annotations}], "preprocessing": "llm"\|"skipped"}` |
| `/execute/batch` | POST | `{"file_paths": [...], "timeout_per_cell": 30}` | `{"results": [{"file_path": ..., "status": "ok|error", "cells": [...]}]}` |
| `/auto-fix` | POST | `{"cell_source": "...", "cell_error": "...", "context_cells": [...]}` | `{"suggestion": "...", "explanation": "...", "confidence": 0.92}` |
| `/health` | GET | — | `{"status": "ok"}` |

`/execute` runs the full pipeline: pre-process (LLM) → execute (nbclient) → post-process (error detection → LLM auto-fix suggestions).

## Appendix C — Pre-Processing Pipeline (Reference)

The pre-processor calls KI Connect with a structured prompt containing:
- The notebook's code cells and their sources
- Assignment ID and available data files
- Known installed libraries

The LLM returns a JSON object with:
- `cells` — modified notebook cells (normalizations applied)
- `annotations` — per-cell structured notes
- `summary` — aggregate counts

**KI Connect availability:** If the LLM is unreachable, the notebook executes without pre-processing (flagged as `preprocessing: "skipped"`). No regex fallback.

The LLM has access to Python tool calling inside the container (`importlib`, `pathlib`, `ast`, `nbformat`) via the OpenAI-compatible `tool_calls` mechanism.

## Appendix D — Route Group Layout (Reference)

```
routes/api/
├── submissions/
│   ├── +server.ts            # GET /api/submissions
│   ├── upload/+server.ts     # POST /api/submissions/upload
│   ├── process/+server.ts    # POST /api/submissions/process
│   └── [id]/
│       ├── +server.ts         # GET /api/submissions/[id]
│       ├── process/+server.ts # POST /api/submissions/[id]/process
│       ├── save/+server.ts    # POST /api/submissions/[id]/save
│       ├── grade/+server.ts   # POST /api/submissions/[id]/grade
│       └── export/+server.ts  # GET /api/submissions/[id]/export
├── assignments/
│   ├── +server.ts            # GET /api/assignments
│   └── [id]/materials/+server.ts  # GET+POST materials
├── auto-fix/+server.ts       # POST /api/auto-fix
├── suggest-grade/+server.ts  # POST /api/suggest-grade
├── draft-notes/+server.ts    # POST /api/draft-notes
└── plagiarism/
    ├── check/+server.ts      # POST /api/plagiarism/check
    └── results/
        ├── +server.ts        # GET /api/plagiarism/results
        └── [id]/+server.ts   # GET /api/plagiarism/results/[id]
```

## Appendix E — Server Module Layout (Reference)

```
src/lib/server/
├── ki-connect.ts           # KI Connect client (TypeScript)
├── metadata.ts              # metadata.json CRUD
├── file-service.ts          # File upload, classification, persistence
├── executor-client.ts       # HTTP client to Python executor
├── cell-comparison.ts       # Student vs key cell comparison
├── export-service.ts        # Grading YAML generation
├── yaml-loader.ts           # Server-side YAML loading
└── plagiarism/
    ├── structural.ts        # Structural code comparison
    └── semantic.ts          # LLM-assisted semantic comparison
```
