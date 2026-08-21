# Directive: Implement a truly turn-based pre-evaluation pipeline

**Status:** Required reading for the next Hermes session that touches `frontend/src/lib/server/copilot/pre-evaluation.ts` or the rubric-selection pipeline.

**Background:** Three iterations of pipeline hardening have produced excellent supporting modules (post-processing, cohort calibration, deterministic pre-analysis, legacy grading-form export), but the core LLM contract for rubric selection is still single-shot. The user explicitly wants an unlimited-call, turn-based, living-document architecture. Previous sessions re-interpreted "turn-based" as "more phases inside one response." This directive removes that ambiguity.

---

## 1. The non-negotiable contract

The rubric-selection phase MUST be implemented as a **repeated call-and-repair loop** where the LLM edits a markdown worksheet, the code validates the edit, and on failure the LLM is asked to fix *that specific failure*. This is not optional. Do not implement a "new batch JSON output" or "bigger single prompt" as a substitute.

Specifically:

- **One category per LLM call.** Never ask the model to fill more than one rubric category in a single response. The unlimited qwen3/gpt-oss quota exists precisely so we can make 14 calls per submission instead of cramming 14 categories into 3.
- **The output is the edited markdown worksheet itself.** The model returns the full worksheet section for that category with `[x]` marks and notes filled in. The code parses it and validates it against the rubric. No JSON summary of what the model thinks it checked.
- **On validation failure, send the parse errors back to the same model and ask it to correct the worksheet.** Repeat up to a max iteration count (default 3). Each retry receives: the original worksheet section, the parse errors, and one concrete instruction per error.
- **Only after the worksheet parses cleanly against the rubric do we proceed.** A category that cannot be parsed cleanly after max retries must be flagged in the envelope so the UI shows "needs review" — never silently dropped or post-processed into validity.

---

## 2. Why previous attempts failed (do not repeat)

| Mistake | What it looked like | Why it did not work |
|---------|--------------------|---------------------|
| Batch filling | "Fill these 3-4 categories and return JSON" | Model cannot keep 50+ exact rubric texts straight while also reasoning about the notebook. |
| JSON-as-output | Worksheet shown in prompt, JSON emitted | The JSON item text drifts from the rubric; fuzzy-matching then hides or misassigns evidence. |
| One-shot verify | A second model prunes the first model's output | Pruning deletes hallucinated items but never retrieves the items that should have been checked. |
| Post-process as primary fix | 6 deterministic passes patch the LLM output | Patches cannot reconstruct reasoning the model never produced. They fill gaps with generic notes. |
| N/A as escape hatch | "Use N/A when unsure" | Model opts out of hard categories, leaving them empty. |

The next implementation must not do any of these.

---

## 3. Concrete architecture

### 3.1 Data structure: the living worksheet

Keep a single markdown document per submission in the pipeline state. It contains:

```markdown
# Pre-Evaluation Worksheet: <submission_id>

## Context
- Assignment: soil_contamination
- Cells: 22 (14 code, 8 markdown)
- Pre-analysis: 2 issue(s) found: imports are not alphabetically ordered; no interpretation language detected
- Cell markers: ...
- Dimension scores: code_quality_design: 4.0, code_execution_results: 5.0, ...

## Rubric: code_formatting — Code Formatting
### Positive
- [ ] imports - libraries were alphabetized
- [ ] naming - descriptive objects/variables ...
...
### Negative
- [ ] imports - not alphabetized
...
### Neutral
...
### Additional Notes
_(to be filled)_
```

The LLM is never asked to produce the whole document at once. It is asked to edit **one section at a time**.

### 3.2 Per-category call protocol

For each category `c` in the rubric:

1. Build a prompt containing:
   - The full worksheet as context (so the model sees adjacent decisions).
   - A highlighted request: "Fill ONLY the `## Rubric: c — title` section."
   - The deterministic pre-analysis facts as a bullet list.
   - A strict instruction: return the **complete edited section** for this category only, from `## Rubric:` through `### Additional Notes`, preserving all un-checked items verbatim.

2. Send to the model (qwen3-30b is acceptable here because the task is now tiny; gpt-oss-120b is also fine). Temperature 0.2 for selection.

3. Parse the returned section with the existing `parseWorksheetSection` from `worksheet.ts`. Record:
   - Valid selections.
   - Unmatched checked texts.
   - Whether mutual-exclusion pairs were co-checked.
   - Whether the section header matches.
   - Whether the additional notes are present and grounded.

4. If validation fails:
   - Construct a retry prompt containing the returned section and the exact validation errors.
   - Example: "You checked both 'imports - libraries were alphabetized' and 'imports - not alphabetized'. These are mutually exclusive. The pre-analysis fact says importsNotAlphabetized=true. Remove the positive and keep the negative. Return the corrected section."
   - Send the retry.
   - Repeat until clean or max retries exhausted.

5. Merge the clean section into the living worksheet.

6. Continue to the next category.

### 3.3 Deterministic validation rules (code-enforced)

The parser must enforce, and the retry loop must preserve:

- **Mutual exclusion within a category.** Define logical-opposite pairs per category in configuration (e.g. code_formatting: `imports - libraries were alphabetized` vs `imports - not alphabetized`). Co-checked opposites → validation error.
- **No unknown sub-point text.** A checked item whose text does not match any sub-point in the category → unmatched error.
- **No N/A escape hatch.** There is no N/A verdict. Every category must receive at least one checked item or a non-empty additional note. If the model returns a section with no checkboxes and no note, treat it as a validation error and retry with: "This category has applicable sub-points. Choose the single best-matching item and explain why in the notes."
- **Sentiment consistency.** Within a category, checked items should not span positive and negative sentiments unless the rubric explicitly allows mixed sentiment for that category. The current rubric does not. If mixed, ask the model to pick the dominant sentiment and remove the others.

### 3.4 Model choice and temperature

- **Per-category selection:** qwen3-30b at T=0.2. The task is now small enough that qwen3's conditional-reasoning weakness is less relevant. Use gpt-oss-120b only if qwen3 still fails validation after retries on a test sample.
- **Dimension scoring:** keep gpt-oss-120b, but derive scores from evidence lists if possible.
- **No verify/critique passes on rubric selection.** The retry loop IS the verification. Adding a separate model pass that edits the same worksheet is banned by this directive.

---

## 4. Minimal first milestone

Before touching the full 19-submission cohort, implement the new contract for **one submission** and one rubric category.

1. Pick a single submission and one rubric category (e.g. `code_formatting`).
2. Write a standalone script or route that runs the per-category protocol above.
3. Compare the resulting worksheet section to a reference grading (rubric keys map to "checked", dimension keys, notes) for that submission.
4. Iterate until the section matches the reference.

Only after that single-category milestone is met should the implementation expand to all categories and all submissions.

---

## 5. What the next Hermes session is allowed to do

- Modify `frontend/src/lib/server/copilot/pre-evaluation.ts` to replace the batch worksheet filling with the per-category retry loop.
- Modify `frontend/src/lib/server/copilot/worksheet.ts` as needed to expose section-level parsing and validation for the retry loop.
- Add mutual-exclusion pair configuration to the criteria schema or hard-code it for the 14 categories initially.
- Update tests in `frontend/src/tests/copilot/pre-evaluation.test.ts` to expect per-category calls, not batch calls.
- Use a reference grading (rubric keys + dimension scores + notes) as ground truth for the single-submission milestone.

## 6. What the next Hermes session is NOT allowed to do

- Replace batch filling with "one JSON per category." The output must be the edited markdown section.
- Add a separate verify/critique model pass instead of the retry loop.
- Broaden the N/A option or use it as a fallback.
- Skip the single-category milestone and immediately run the full cohort.
- Increase `CHUNK_SIZE`, batch size, or per-call item count to reduce call count.

---

## 7. Success criteria

The pipeline is correct when:

1. A single submission's pre-evaluation produces a worksheet where **every category section parses cleanly with zero unmatched items and zero mutual-exclusion violations**.
2. The rubric selections for a reference submission match a reference grading within a small tolerance (≤2 selection differences per category, no missing mandatory categories).
3. The total number of LLM calls per submission is **≥14 for rubric selection alone** (one per category), not ≤4.
4. No post-processing pass is needed to make the rubric selections valid — they are valid before post-processing runs.

---

## 8. References

- `frontend/src/lib/server/copilot/pre-evaluation.ts` — current pipeline.
- `frontend/src/lib/server/copilot/worksheet.ts` — worksheet generation/parsing.
- `frontend/src/lib/server/copilot/post-process.ts` — existing deterministic passes (must become unnecessary for rubric validity, still useful for policy rules like stripping plagiarism language).

