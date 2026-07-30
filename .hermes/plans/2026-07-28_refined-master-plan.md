# SciPro Review Teacher UI — Refined Master Plan

> **Status:** Active plan document. Supersedes `2026-07-25_214500-grading-copilot-mastra.md` (old Mastra plan), `2026-07-28_003000-phase-2-teacher-ui.md` (old Phase 2 plan), and `2026-07-28_ddr.md` (Design Decision Record — now outdated) where conflicts exist.
>
> **DDR note:** The DDR was authoritative for Phase 2 implementation but is now **superseded** by this master plan and the Phase 3 execution plan for all Phase 3+ decisions. The DDR remains a useful reference for component design tokens and state visuals.


---

## Ground Truth Decisions

These are durable decisions that all phases must be consistent with. If an earlier document contradicts these, this document wins.

### D1 — Assignment model: no scaffolding, open-ended

Students receive **task descriptions only** — not template code. Each student writes their own unique solution. This means:
- A "match" between student code and the reference key is **suspicious** (potential copying), not expected
- The default state of each cell comparison is **"different approach"** — this is neutral, not a flag
- The teacher evaluates **correctness and quality of the student's approach**, not fidelity to a reference
- The reference key is a **calibration tool for the teacher**, not an audit baseline

### D2 — Cell markers are about understanding, not auditing

| Marker | Meaning | Color | Default? | When |
|--------|---------|-------|----------|------|
| **Same approach** | Student used the same method/algorithm as the reference | Blue (info) | Rare | Only when approaches genuinely coincide |
| **Different approach** | Student solved it differently — neutral, expected | Gray (neutral) | **Default** | Most cells |
| **Questionable approach** | Student's approach is incorrect, suboptimal, or indicates misunderstanding | Amber (caution) | Exceptional | Wrong algorithm, logical errors, missing steps |
| **Error** | Code doesn't execute | Red (error) | Exceptional | Execution failure |

### D3 — Right panel is tabbed (Rubric | Grading | Copilot)

The per-submission review page's right panel shows **one section at a time** via tabs, not three stacked sections. This eliminates the stacking imbalance and lets each section use the full panel width.

- **Rubric tab**: Full rubric checklist with expandable categories, checkboxes, comments, deductions
- **Grading tab**: Dimension sliders, live grade computation, grade boundary warnings
- **Copilot tab** (Phase 4): Chat history, suggestion cards, tool call results, structured AI output

**Context-aware tab switching:**
- Teacher ticks a rubric checkbox → switches to Rubric tab
- Teacher adjusts a slider → switches to Grading tab
- Teacher asks AI or clicks an AI suggestion → switches to Copilot tab
- Teacher manually clicks a tab → stays on that tab until next explicit interaction
- Passive actions (scrolling, reading) → NEVER switch tabs

### D4 — Grading sidebar is always active in teacher mode

`GradingSidebar` renders with `disabled={false}` from day one. Stub data (zeros) in Phase 2, real grade persistence in Phase 3. The teacher adjusts scores as they review — sliders must be interactive immediately.

### D5 — Rubric checklist and grading sliders are separate concerns

The rubric checklist is **justification** (why this score). The grading sliders are **calibration** (what score). The teacher works both simultaneously — the tabs make this ergonomic by keeping each focused and full-width.

### D6 — Copilot is a Mastra agent runtime, not a chat widget (Phase 4)

The copilot runs on Mastra v1 and supports:
- Typed tool calling via `createTool()` with Zod schemas (`suggest-grade`, `draft-notes`, `get-submission-context`, `analyze-code`, `autofix`)
- Per-submission conversation memory via `resource` + `thread` isolation
- Streaming responses with structured events (text-delta, tool-call, tool-result)
- Rich rendering: suggestion cards with Accept/Dismiss, comparison tables, code diff previews, streaming text
- Inline suggestion chips: lightweight AI output near specific rubric items or cells
- Human-in-the-loop: teacher approves grade suggestions before they persist

### D7 — Reference comparison is an explainer, not an auditor

The reference comparison section (collapsible, placed above cells) shows **what the reference key does per cell** and **how the student's approach differs**, in plain language. Its purpose is to help the teacher quickly understand the student's choices, not to flag deviations. It defaults to collapsed — the teacher opens it when they need orientation.

### D8 — Phase 3 introduces the executor, Phase 4 introduces the copilot

Independent concerns. The executor (Phase 3) is a Python container that runs notebooks and returns cell outputs. The copilot (Phase 4) is a TypeScript Mastra agent that provides AI assistance. They don't depend on each other — the copilot can work with stub execution data, and the executor produces data the copilot can analyze.

---

## Architecture Overview

```
┌─ Browser (teacher) ──────────────────────────────────────┐
│                                                           │
│  SvelteKit (ADAPTER=node, port 8765)                      │
│                                                           │
│  Pages:                                                   │
│  ├── /submissions/                  (dashboard)           │
│  ├── /submissions/[id]/             (review page)         │
│  │     Left panel:  cell execution output                │
│  │     Right panel: tabbed (Rubric | Grading | Copilot)  │
│  └── /settings/                     (shared)             │
│                                                           │
│  Components (teacher additions):                          │
│  ├── submissions/submissions-dashboard.svelte             │
│  ├── submissions/execution-output.svelte                  │
│  ├── submissions/reference-comparison.svelte              │
│  ├── submissions/right-panel-tabs.svelte                  │
│  ├── submissions/copilot-panel.svelte      (Phase 4)     │
│  └── submissions/copilot-store.svelte.ts   (Phase 4)     │
│                                                           │
│  Student components reused as-is:                         │
│  ├── grading-sidebar.svelte             (disabled=false)  │
│  ├── rubric-category.svelte             (interactive)     │
│  ├── criteria-loader.ts                 (unchanged)      │
│  └── grade-slider.svelte                (unchanged)       │
│                                                           │
│  Data service (stub → real):                              │
│  └── services/submissions-store.ts       (Phase 2→3)     │
│                                                           │
│  Mastra (Phase 4):                                        │
│  └── mastra/index.ts                   (agent init)      │
│      mastra/tools/*.ts                 (tool defs)       │
│      mastra/agents/grading-agent.ts    (agent config)    │
└───────────────────────────────────────────────────────────┘

┌─ Executor (Python, port 8766, internal) ─── (Phase 3) ──┐
│  POST /execute       → run .ipynb from file              │
│  POST /execute/batch → scan dir, process all .ipynb     │
│  Cell-by-cell with 30s timeout, kernel cleanup           │
│  Shares /app/data/ volume with SvelteKit                 │
└──────────────────────────────────────────────────────────┘

┌─ /app/data/ (Docker named volume) ───────────────────────┐
│  submissions/<assignment-id>/                             │
│  ├── <studentId>.ipynb                                    │
│  └── metadata.json                                        │
│  materials/<assignment-id>/                               │
│  ├── assignment.pdf                                       │
│  ├── key.ipynb                                            │
│  └── input_data/                                          │
│  assignments.yaml              (from git)                 │
│  grading_config.yaml           (from git)                 │
│  criteria/                     (from git)                 │
└──────────────────────────────────────────────────────────┘
```

---

## Phase Overview

| Phase | Name | Delivers | Dependencies |
|-------|------|----------|--------------|
| 1 | ✅ Clean Separation | Remove legacy teacher mode, dual-adapter build | — |
| **2** | **Teacher UI Scaffold** | ✅ **Dashboard + per-submission page with stub data, tabbed right panel** | Phase 1 |
| **3** | **Real Data & Execution** | **Full backend pipeline: LLM pre-processing, notebook executor, 3c LLM tools, plagiarism check, real API routes** | Phase 2 |
| 4 | AI Copilot | Mastra agent, chat UI, suggestion cards, tool orchestration | Phase 3 |

**Updated scope note (2026-07-29):** Phase 3 now includes LLM-powered tools (auto-fix, suggest-grade, draft-notes, plagiarism check) via KI Connect NRW. These are built as standalone endpoints that Phase 4's Copilot calls as tools. Phase 4 is now exclusively the agentic chat UI and orchestration layer.

---

## Phase 2: Teacher UI Scaffold ✅ COMPLETED

**Status:** ✅ Complete. Submissions dashboard, per-submission review page, upload panel, TanStack Table, tabbed right panel, all 4 cell markers, reference comparison, rubric + grading tabs, error/loading states. Merged to `main`.

## Phase 3: Real Data & Execution ✅ IN PROGRESS

> **See dedicated plan:** `.hermes/plans/2026-07-29_phase-3-execution-and-data.md` for full breakdown.
>
> **Status:** Planning complete. Ready for implementation in 6 sub-phases.

**Scope:** The full backend pipeline. Every stub from Phase 2 becomes real. The LLM tools built here are called by Phase 4's agentic Copilot.

**Sub-phases:**

| Sub-phase | What it delivers |
|-----------|-----------------|
| **3a Foundation** | KI Connect client, Python executor (nbclient + FastAPI), LLM pre-processing, Docker Compose |
| **3b Data Layer** | 10 API endpoints, metadata/filesystem persistence, LLM-based cell comparison engine, grading export, grading slider wiring (replace no-op stubs with real `/api/submissions/[id]/save` calls) |
| **3c LLM Tools** | Auto-fix, Suggest Grade, Draft Notes — standalone endpoints, Phase 4 Copilot calls these |
| **3d Plagiarism Check** | Two-stage comparison (structural + LLM), dashboard modal results |
| **3e Frontend** | Store replacement, dashboard wiring, per-submission wiring, processing overlay, auto-fix inline UI |
| **3f Docs** | DDR corrections (mark as outdated), OD mockups for auto-fix card + plagiarism view |

**Key differences from the original Phase 3 plan:**
- No regex fallback — if KI Connect is unavailable, skip pre-processing
- Suggest Grade, Draft Notes, and Auto-Fix use KI Connect directly (not Mastra)
- Plagiarism check added (structural + LLM-assisted)
- Cell comparison uses LLM-based task grouping from Phase 3 start (position-based scrapped)
- Generate + Reset buttons added to per-submission page (Phase 3g)
- Grading slider stubs replaced with real API calls (Phase 3b)
- Phase 4 is now ONLY the agentic Copilot chat — all tools are Phase 3
- DDR is now outdated — master plan and Phase 3 plan are the source of truth

**Phase 3 does NOT include:** The Copilot chat UI, suggestion cards with Apply/Dismiss, Mastra agent setup, or tool orchestration. Those are Phase 4.

---

## Phase 4: AI Copilot

**Scope:** Mastra v1 agent that provides AI assistance throughout the grading workflow.

**Component additions:**
- `mastra/index.ts` — Mastra initialization
- `mastra/tools/suggest-grade.ts` — suggests dimension scores from rubric + cell analysis
- `mastra/tools/draft-notes.ts` — generates feedback text from rubric markings
- `mastra/tools/get-submission-context.ts` — fetches current submission state
- `mastra/tools/analyze-code.ts` — explains a specific cell's code
- `mastra/tools/autofix.ts` — suggests fixes for broken cells (optional)
- `mastra/agents/grading-agent.ts` — agent with all tools + memory config
- `submissions/copilot-panel.svelte` — chat + suggestion cards + tool call results
- `submissions/copilot-store.svelte.ts` — state for messages, suggestions, streaming

**UI additions:**
- **Copilot tab** becomes active in the right panel tab bar
- **Suggestion cards** with Accept/Dismiss buttons
- **Inline suggestion chips** near rubric items and cells (Phase 4.1 enhancement)
- **Pre-evaluate All** dashboard button — batch `suggest-grade` across all submissions
- **Suggest Grade** button on per-submission page — triggers single `suggest-grade` call
- **Draft Notes** button — triggers `draft-notes` tool
- **Chat input** in copilot tab for free-form questions

**Context-aware tab switching** goes live in Phase 4 — the copilot tab auto-activates when AI output arrives, and switches back when the teacher interacts with rubric/grading.

---

## Resolved Questions

| Question | Answer | Impact |
|----------|--------|--------|
| What does Karl's key.ipynb actually contain? | Karl's reference solution — what an optimal correct submission looks like. May include extra visualizations/explanations beyond expectations. A student could match if they followed teachings to the letter, but rare. | ✅ "Different approach" as default marker is correct. Key is a calibration tool, not an audit baseline. |
| What's the key's cell structure? | **37 cells** across **5 tasks** + extras: Task 1 (Data Prep), Task 2 (Clustering), Task 3 (Model Optimization), Task 4 (Prediction & Viz), Task 5 (Commentary). "Extra" cells are bonus. Students will have **different cell counts and organization** than the key. | ⚠️ **Critical**: Cell comparison must be **task-based, not position-based**. Compare by output semantics, not cell index. Reference comparison groups cells by task. |
|| How should task-based cell comparison work? | **LLM matching** — since assignments differ, tasks vary, and student submissions have non-standard layouts, structural matching won't generalize. LLM groups cells by task/content semantics. | ✅ Phase 3 uses the two-stage LLM pipeline (task segmentation → per-task comparison) from the start. No position-based fallback. |
|| Is Mastra installed/configured anywhere? | ✅ Already installed — `@mastra/core` and `@mastra/memory` are in `frontend/package.json` dependencies. The copilot tab (`copilot-panel.svelte`) + copilot store (`copilot-store.svelte.ts`) exist as stubs already in Phase 2. | 🔷 **Plan update**: Remove the \"Phase 4 installs Mastra\" assumption. Mastra deps + Copilot shell are already present. Phase 4 activates the Copilot tab with real agent logic. |
| What's the deadline for Phases 3 and 4? | "We'll see how far we can get" — no fixed phase deadlines. Work toward Aug 10. | Prioritize Phase 3 completion first. Phase 4 is a stretch goal. |
| Any Karl-specific grading format requirements? | Grading expectations are encoded in the rubric criteria checklists and the dimension score descriptions (e.g. "3 pts: Code somewhat follows scientific programming concepts"). These need to be surfaced as tooltips/descriptions in the grading UI. | **New data model requirement**: Add `descriptions` map to `GradeDimension`. |
| What's actually in `data/submissions/hw2/Cetin.ipynb`? | **11+ student submissions concatenated** into one file (476 cells, 225 code + 251 markdown). The filename doesn't reflect a single student — it's a teacher-facing batch already excluded from git. Includes Colab artifacts (`/content/...` paths, `!pip install`). | ✅ Dev artifact only — no action needed on file handling. Confirms the need for path normalization and Colab stripping in the pre-processor. |

## Open Questions

*(none — all resolved)*
