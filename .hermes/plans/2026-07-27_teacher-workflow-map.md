# SciPro Review — Teacher Workflow Map

> Ground-truth document. All Phase 2b UI decisions must be consistent with this workflow.

## Data Flow

```
┌─ Repository (git) ──────────────────────┐
│  data/                                   │
│  ├── assignments.yaml    ← assignment    │  in git
│  ├── grading_config.yaml ← registry      │  in git
│  └── criteria/           ← rubric defs   │  in git
│       ├── general.yaml                  │
│       └── soil_contamination.yaml        │
│                                          │
│  data/materials/<assignment-id>/         │  gitignored
│  ├── assignment.pdf      ← assignment    │  uploaded via web UI
│  ├── key.ipynb           ← reference     │  persisted across sessions
│  └── input_data/         ← data files    │
│       └── soil_samples.csv               │
│                                          │
│  data/submissions/<assignment-id>/       │  gitignored
│  ├── 2026SS_03.ipynb     ← student      │  uploaded via web UI
│  ├── 2026SS_07.ipynb     ← work          │  merge on re-upload
│  └── metadata.json       ← status store  │  auto-generated
└──────────────────────────────────────────┘

Note: In Docker mode (Phase 3+), these paths live in a named volume at /app/data/.
In Phase 2, the stub submissions-store.ts returns hardcoded data.
```

## Teacher Workflow Stages

### Stage 1: Assignment Setup (once per assignment, persists)

```
Dashboard shows: upload panel with 4 drop zones

  ┌──────────────────────────────────────────────────┐
  │  Assignment: [Soil Contamination ▼]              │
  │                                                   │
  │  ┌──────────────┐  ┌──────────────┐              │
  │  │ 📄 PDF       │  │ 🔑 Key       │              │
  │  │ Drop .pdf     │  │ Drop .ipynb  │              │
  │  └──────────────┘  └──────────────┘              │
  │                                                   │
  │  ┌──────────────┐  ┌──────────────┐              │
  │  │ 📊 Input Data │  │ 👥 Submissions│              │
  │  │ Drop .csv/... │  │ Drop .ipynbs │              │
  │  └──────────────┘  └──────────────┘              │
  │                                                   │
  │  [Upload All]                                     │
  └──────────────────────────────────────────────────┘

On upload:
  ├── PDF → data/materials/<assignment-id>/assignment.pdf
  ├── Key → data/materials/<assignment-id>/key.ipynb
  ├── Input → data/materials/<assignment-id>/input_data/
  ├── Submissions → data/submissions/<assignment-id>/<studentId>.ipynb
  └── metadata.json created with status: "pending"
```

### Stage 2: Batch Processing

```
After upload → dashboard shows submissions table

  [▶ Process All] triggers:
  1. Execute key.ipynb → cache cell outputs as reference
  2. For each pending .ipynb: execute via executor → status update
  3. If error: mark as "error" (auto-fix in Phase 4)

  [✨ Pre-evaluate All] (Phase 4):
  1. For each executed submission: LLM compares against reference + rubric
  2. Suggest initial dimension scores → show in "Pre-Eval" column

  Polling: every 2s while any submission is "pending" or "executing"
```

### Stage 3: Per-Submission Grading (the sequential workflow)

```
Open submission → /submissions/[id]/

  ┌───── Left Panel ────────┬───── Right Panel ────────────────────┐
  │                          │                                       │
  │  Header: student ID,     │  Rubric categories (scrollable)       │
  │  status badge            │  ┌─ ▼ Code Formatting ──────────────┐│
  │                          │  │  ☐ blank lines — consistent      ││
  │  [Suggest Grade]         │  │  ☐ concise, clean code    ✓      ││
  │  [Draft Notes]           │  │  ☒ line length — too long        ││
  │                          │  │  📝 Category notes: [textarea]   ││
  │  Reference Comparison    │  └──────────────────────────────────┘│
  │  (collapsible)           │  ┌─ ▼ Coding Concept ──────────────┐│
  │  6 cells · 1 divergence  │  │  ☐ list comprehension     ✓     ││
  │                          │  │  ☒ hardcoded file paths   ✓     ││
  │  ┌─ Cell 1 (code) ────┐ │  │  Deduction: [1.0]               ││
  │  │ source              │ │  └──────────────────────────────────┘│
  │  │ output              │ │  ...3 more categories...             │
  │  └─────────────────────┘ │                                       │
  │                          │  ┌─ Grading (collapsible) ─────────┐│
  │  ┌─ Cell 2 (diverges) ┐ │  │  Code Quality & Design:  N / 6  ││
  │  │ source   🔀 badge   │ │  │  ░░░░░░░░░░                     ││
  │  │ output              │ │  │  Code Execution:       N / 6   ││
  │  └─────────────────────┘ │  │  ...5 dimensions...              ││
  │                          │  │  ─────────────────────           ││
  │  ┌─ Cell 3 (error) ───┐ │  │  Grade: —  Total: 0 / 100       ││
  │  │ source              │ │  └──────────────────────────────────┘│
  │  │ ❌ NameError...      │ │                                       │
  │  └─────────────────────┘ │  [Export YAML] [Save Grade]          │
  └──────────────────────────┴──────────────────────────────────────┘
```

**The grading process is SEQUENTIAL:**
1. Walk cells in left panel, informed by reference comparison
2. Mark criteria in rubric (right panel top) — checkboxes, comments, deductions
3. Dial scores in grading sidebar (right panel bottom) — collapsible, summary always visible
4. Save grade / export YAML

### Stage 4: Post-Grading

```
When all submissions are graded:
  ┌─ Back to Dashboard ─────────────────────────────────────┐
  │  All submissions show final grades in "Your Grade" col  │
  │  [Export All Graded] → ZIP of YAML files                │
  │  Archive / delete old submissions                       │
  └─────────────────────────────────────────────────────────┘

Late submission handling:
  ┌─ Upload More → merge new .ipynb into existing batch ──┐
  │  New files get "pending" status                        │
  │  Re-run processing for new files only                  │
  │  Existing grades unaffected                            │
  └─────────────────────────────────────────────────────────┘
```

## Data Model for Submissions Metadata

```typescript
// Phase 3+ data model. Phase 2 uses hardcoded stub.
interface SubmissionMeta {
  id: string;                    // unique ID within assignment
  studentId: string;             // from filename (e.g., "2026SS_03")
  assignmentId: string;          // from upload dropdown
  status: "pending" | "executing" | "executed" | "error" | "pre-evaluated" | "graded";
  cellDiff?: string;             // indices of diverging cells (vs key)
  preEvalGrade?: number;         // LLM-suggested overall grade
  teacherGrade?: number;         // teacher's final grade
  createdAt: string;             // ISO timestamp of upload
  updatedAt: string;             // ISO timestamp of last status change
}

interface SubmissionDetail extends SubmissionMeta {
  cells: CellInfo[];             // executed notebook cells
  referenceCells?: CellInfo[];   // key's matching cells for comparison
}

interface CellInfo {
  index: number;
  type: "code" | "markdown";
  source: string;
  output?: string;
  error?: string;
  diverges?: boolean;            // differs from reference
  autoFixApplied?: boolean;      // Phase 4
}

// Metadata store (data/submissions/<assignment-id>/metadata.json)
interface AssignmentBatch {
  assignmentId: string;
  submissions: SubmissionMeta[];
  materials: {
    hasKey: boolean;
    hasPdf: boolean;
    hasInputData: boolean;
  };
  createdAt: string;
  updatedAt: string;
}
```

## Gitignore Strategy

```gitignore
# data/submissions/ — student work, never committed
data/submissions/

# data/materials/ — assignment keys, PDFs, input data — never committed
data/materials/

# Exception: keep the criteria, grading config, and assignment registry in git
!data/assignments.yaml
!data/grading_config.yaml
!data/criteria/
```

## Dashboard Page States

| State | Condition | UI |
|-------|-----------|----|
| First visit, no materials | No materials for selected assignment | Full upload panel (4 zones) + assignment selector |
| Has materials, no submissions | Materials exist, no .ipynbs uploaded | Upload panel (submissions zone only) + [Materials] link + empty state |
| Has materials + submissions | Both exist | Compact upload bar + submissions table + toolbar |
| Processing | Submissions in "pending"/"executing" | Table with live status + polling spinner |
| Errors | Some submissions failed execution | Error badges on affected rows + retry option |
| All graded | All submissions have teacher grades | Grade column populated + [Export All] enabled |
