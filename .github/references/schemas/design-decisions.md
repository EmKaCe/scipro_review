# Design Decisions & Lessons Learned

> **Status**: v2 — Rationale for the clean-slate schema design, based on
> experience with the legacy JSON web app and the Svelte prototype.

## Background

The SciPro grading system has gone through two iterations before this v2
clean-slate design:

1. **v1 — JSON Web App** (`scipro_assignments_grading/`): A vanilla JS web app
   with JSON criteria files, flat key-value exports, and a `references.json`
   configuration registry.
2. **v1.5 — Svelte Prototype** (`svelte_review/`): A SvelteKit exploration that
   introduced YAML criteria files, comment/point-deduction flags, and a
   partial assignments registry.

Both had significant design issues that informed the v2 decisions below.

---

## Decision 1: YAML Everywhere

**Choice**: All configuration, criteria, and grading data stored as `.yaml` files.

**Why not JSON?**
- JSON requires excessive quoting and escaping for the long, natural-language
  text in criteria sub-points
- JSON doesn't support comments, making criteria files harder to annotate
- JSON's trailing-comma sensitivity and strict quoting cause frequent syntax
  errors when hand-editing
- YAML is more readable for the non-technical graders who edit criteria

**Why not TOML?**
- TOML doesn't handle deeply nested structures as cleanly as YAML
- The criteria format has 4 levels of nesting (category → sentiment → main
  point → sub-point), which is awkward in TOML's flat `[section]` syntax

**Trade-off**: YAML parsers are more complex and have more edge cases than
JSON parsers. We mitigate this by using a strict YAML subset (no anchors,
no complex keys, no implicit typing).

---

## Decision 2: One Assignment = One Criteria File

**Choice**: Each assignment gets a single YAML file bundling all its
assignment-specific categories under `categories:`.

**Why not one category per file?** (v1 approach)
- 5 assignment-specific categories × N assignments = 5N files to manage
- File naming was inconsistent (`user_defined_functions.json` vs
  `callingFunction.json`)
- The `references.json` registry had to list each file separately
- Loading required merging N separate files with different formats

**Why not one file with `general:` / `assignment_specific:` split?** (v1.5 approach)
- The split was confusing: the loader had to handle two different key patterns
- Categories under `general:` in assignment files were actually assignment-specific
- The `assignment_specific: []` key was always empty but had to be present
- It created an artificial distinction that didn't match the mental model

**Trade-off**: Assignment criteria files are larger (5 categories in one file
vs. 5 separate files). But this is actually an advantage — related categories
are co-located and can be reviewed together.

---

## Decision 3: `categories:` Top-Level Key

**Choice**: All criteria files use `categories:` as the single top-level key.

**Why not `general:` / `assignment_specific:`?** (v1.5 approach)
- The split created a false dichotomy: "general" categories in assignment
  files were actually assignment-specific
- The loader needed special-case code to handle both keys
- It required `assignment_specific: []` as a mandatory empty placeholder

**Why not bare categories at the top level?**
- A top-level key makes the file's purpose self-documenting
- It allows future extension (e.g., `metadata:` for file-level info)
- It's consistent with how `assignments.yaml` and `grading_config.yaml`
  use top-level keys

---

## Decision 4: Explicit Sub-Points

**Choice**: Sub-points are always objects with a `text` field. `comment` and
`point_deduction` are explicit boolean flags, not inferred from text patterns.

**Why not bare strings?** (v1 approach)
- Bare strings can't carry metadata (comment flag, deduction flag)
- The v1 web app inferred comment fields from trailing colons in text, which
  was fragile and surprising
- Converting between string and object format required special handling in
  every consumer

**Why not infer `comment` from trailing `:`?** (v1 approach)
- Text like "execution - the code does not run because of the following
  problem(s):" naturally ends with `:` but isn't always a comment trigger
- The inference was invisible — graders couldn't predict which items would
  show comment fields
- Explicit flags are self-documenting and can be validated

---

## Decision 5: Consistent `snake_case`

**Choice**: All keys everywhere use `snake_case`. No camelCase, no
`snake_case_with_and`, no `camelCase-grading`.

**Why?** The v1 system had four different key conventions in use simultaneously:

| Context | Convention | Example |
|---------|-----------|---------|
| JSON criteria keys | camelCase | `codeFormatting` |
| JSON export keys | camelCase-grading | `codequality-grading` |
| YAML config keys | snake_case | `code_quality_design` |
| YAML frontmatter keys | snake_case with "and" | `code_quality_and_design` |

This required mapping tables in `md_to_json.py` and was a constant source of
bugs. A single convention eliminates all mapping logic.

**Trade-off**: `snake_case` is slightly more verbose than `camelCase`, but
consistency outweighs brevity. YAML naturally reads better with `snake_case`.

---

## Decision 6: Structured Export

**Choice**: Evaluation output uses nested objects, not flat scoped keys.

**Why not flat key-value?** (v1 approach)
- Flat keys like `codeFormatting-positive-Formatting is done well, which
  includes-concise, clean and clearly written code` are:
  - **Fragile**: Any change to the criteria text breaks the key
  - **Unreadable**: The key is a long string with no structure
  - **Non-queryable**: You can't select "all positive items for code formatting"
    without string parsing
  - **Lossy**: The flat format can't represent comments or deductions
    associated with specific items

**Why nested objects?**
- Each piece of data has a clear path: `feedback.code_formatting.checked`
- No text-matching needed — category keys are stable identifiers
- Comments and deductions are naturally associated with their sub-points
- The structure is self-documenting and queryable

**Trade-off**: Nested objects are slightly more complex to serialize/deserialize
than flat key-value pairs. But modern YAML/JSON libraries handle this trivially,
and the readability and robustness benefits far outweigh the cost.

---

## Decision 7: Self-Contained Assignments

**Choice**: The `assignments.yaml` registry includes criteria files and
dimensions directly in each assignment entry.

**Why not separate `references.json`?** (v1 approach)
- `references.json` was a separate file that only listed criteria file paths
- It had no assignment metadata (title, enabled flag)
- The web app had a hardcoded assignment list separate from `references.json`
- Three places to update when adding an assignment: `references.json`, the
  web app code, and the criteria files

**Why include dimensions?**
- Different assignments might use different grading dimensions
- Having dimensions in the registry makes each assignment self-describing
- It eliminates the assumption that all assignments use all 5 dimensions

---

## Decision 8: Evaluation MD as Rendering, Not Source

**Choice**: The structured YAML/JSON output is the canonical format. The
evaluation Markdown file is a human-readable rendering of the same data.

**Why not MD-first?** (v1 approach)
- In v1, the evaluation MD was the primary format and `md_to_json.py` parsed
  it back into structured data
- Parsing Markdown is inherently fragile (checkbox format, indentation,
  heading levels)
- The `md_to_json.py` script needed fuzzy matching to handle text differences
  between the MD and the criteria JSON
- Round-tripping (MD → JSON → MD) was lossy

**Why structured-first?**
- The app produces structured data natively
- Rendering structured data as MD is straightforward and deterministic
- Parsing MD back to structured data is only needed for legacy imports
- The structured format is the single source of truth

---

## Summary of v1 Pain Points → v2 Solutions

| v1 Pain Point | v2 Solution |
|---------------|-------------|
| 4 different key conventions | 1 convention: `snake_case` |
| Flat scoped keys break on text changes | Nested objects with stable keys |
| `references.json` + hardcoded list + criteria files | `assignments.yaml` self-contained |
| One category per JSON file | One assignment per YAML file |
| Implicit comment detection (`:` suffix) | Explicit `comment: true` flag |
| `general:` / `assignment_specific:` confusion | Single `categories:` key |
| MD-first with fragile parsing | Structured-first with MD rendering |
| No assignment metadata in registry | `id`, `title`, `enabled`, `dimensions` |
| JSON quoting/escaping for long text | YAML natural text handling |