# Component Organization

This directory contains all Svelte UI components for the SciPro review app.

## Directory Structure

```
components/
├── ui/               # shadcn-svelte primitives (generated)
│   ├── button.svelte
│   ├── dialog.svelte
│   ├── dropdown-menu.svelte
│   ├── custom-checkbox.svelte
│   └── ...
├── settings/         # Settings page card components
│   ├── about-card.svelte
│   ├── appearance-card.svelte
│   ├── data-card.svelte
│   └── keys-card.svelte
├── skeleton/         # Loading skeleton placeholders
│   └── ...
├── app-footer.svelte
├── app-header.svelte
├── confirmation-dialog.svelte
├── docs-content.svelte
├── docs-sidebar.svelte
├── evaluation-action-bar.svelte
├── evaluation-metadata.svelte
├── faq-accordion.svelte
├── format-card.svelte
├── grade-slider.svelte
├── grading-sidebar.svelte
├── import-dialog.svelte
├── new-review-form.svelte
├── quick-nav.svelte
├── review-footer.svelte
├── reviews-table.svelte
├── rubric-category.svelte
├── rubric-item.svelte
├── rubric-section.svelte
├── saved-reviews.svelte
└── toast-container.svelte
```

## Import Rules

- **shadcn-svelte components** must be imported from `$lib/components/ui/<name>`,
  **never** from the `@huntabyte/shadcn-svelte` npm package. They are vendored
  locally for customization.

    ```svelte
    <!-- ✅ Correct -->
    import Button from "$lib/components/ui/button.svelte";

    <!-- ❌ Wrong — don't import from the npm package -->
    import {Button} from "@huntabyte/shadcn-svelte";
    ```

- **Custom components** use direct relative or `$lib` path imports:

    ```svelte
    import ImportDialog from "$lib/components/import-dialog.svelte"; import RubricCategory from
    "$lib/components/rubric-category.svelte";
    ```

## Frequently Used Components

### `ImportDialog` — File import dialog

Used across the landing page and review page to import YAML/JSON evaluation files.

```svelte
<script lang="ts">
	import ImportDialog from "$lib/components/import-dialog.svelte";

	let showImportDialog = $state(false);
</script>

<ImportDialog
	open={showImportDialog}
	onclose={() => (showImportDialog = false)}
	onimport={(file, readOnly) => handleSingleImport(file, readOnly)}
	onbulkimport={(files, readOnly) => handleBulkImport(files, readOnly)}
/>
```

**Props**:
| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Dialog visibility |
| `onclose` | `() => void` | Close callback |
| `onimport` | `(file: File, readOnly: boolean) => void` | Single-file import |
| `onbulkimport` | `(files: File[], readOnly: boolean) => void` | Multi-file (bulk) import |

### `RubricCategory` — Rubric category card

The core interactive component used in the review page. Renders a collapsible
category with sentiment sections, checkboxes, comments, deductions, and an
optional rich-text notes editor (TipTap).

```svelte
<script lang="ts">
	import RubricCategory from "$lib/components/rubric-category.svelte";
</script>

<RubricCategory
	{entry}
	{selections}
	expanded={openCategories.has(entry.key)}
	disabled={readOnly}
	onToggle={() => toggleCategory(entry.key)}
	onToggleCheckbox={(key, checked) => handleCheckbox(entry.key, key, checked)}
	onUpdateComment={(key, value) => handleComment(entry.key, key, value)}
	onUpdateDeduction={(key, value) => handleDeduction(entry.key, key, value)}
	onUpdateNotes={(value) => handleNotes(entry.key, value)}
/>
```

**Props**:
| Prop | Type | Description |
|------|------|-------------|
| `entry` | `CategoryEntry` | Rubric category key + data |
| `selections` | `CategorySelections` | Current selection state |
| `expanded` | `boolean` | Whether the card is expanded |
| `disabled` | `boolean` | Read-only mode |
| `onToggle` | `() => void` | Expand/collapse callback |
| `onToggleCheckbox` | `(key: string, checked: boolean) => void` | Checkbox toggle |
| `onUpdateComment` | `(key: string, value: string) => void` | Comment update |
| `onUpdateDeduction` | `(key: string, value: number) => void` | Deduction update |
| `onUpdateNotes` | `(value: string) => void` | Notes update |

### `GradeSlider` — Grading dimension slider

A single grading dimension slider with visual bar color, score display, and
weighted contribution calculation.

```svelte
<script lang="ts">
	import GradeSlider from "$lib/components/grade-slider.svelte";
</script>

<GradeSlider
	{dimension}
	value={scores[dimension.key]}
	disabled={readOnly}
	onChange={(key, value) => handleGradeChange(key, value)}
/>
```

**Props**:
| Prop | Type | Description |
|------|------|-------------|
| `dimension` | `GradeDimension` | Dimension definition (key, title, max, weight) |
| `value` | `number` | Current score value |
| `disabled` | `boolean` | Read-only mode |
| `onChange` | `(key: string, value: number) => void` | Value change callback |

### `ConfirmationDialog` — Confirmation modal

A modal dialog for confirming destructive or important actions. Supports
a `requireTyping` prop for high-stakes operations (e.g., "delete").

```svelte
<script lang="ts">
	import ConfirmationDialog from "$lib/components/confirmation-dialog.svelte";
</script>

<ConfirmationDialog
	open={showConfirmDelete}
	title="Delete Review"
	message="This action cannot be undone. The review will be permanently removed."
	confirmLabel="Delete"
	variant="danger"
	requireTyping="delete"
	onconfirm={handleDelete}
	oncancel={() => (showConfirmDelete = false)}
/>
```

**Props**:
| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Dialog visibility |
| `title` | `string` | Dialog title |
| `message` | `string` | Body message |
| `confirmLabel` | `string` | Confirm button label (default: "Confirm") |
| `variant` | `"danger" \| "default"` | Visual style (default: "default") |
| `requireTyping` | `string` | If set, user must type this to enable confirm |
| `onconfirm` | `() => void` | Confirm callback |
| `oncancel` | `() => void` | Cancel callback |

## Component Conventions

All components follow Svelte 5 conventions:

- **Props**: Declared with `$props()` interface, not `export let`
- **Events**: Inline handlers like `onclick`, `onchange`, not `on:click`
- **Slots**: Use `{#snippet}` / `{@render}` instead of `<slot>`
- **State**: `$state()`, `$derived()`, `$effect()` for reactivity
- **Icons**: Import from `@lucide/svelte/icons/<name>` (no barrel imports)
- **Styling**: Tailwind CSS v4 classes + OKLCH color variables
- **Accessibility**: All interactive elements have `aria-label` or proper ARIA roles

## Adding a New Component

1. Create the `.svelte` file in the appropriate subdirectory
2. If it's a shadcn-svelte primitive, use `pnpm dlx shadcn-svelte@latest add <name>`
3. Follow Svelte 5 runes syntax
4. Export a typed `Props` interface and use `$props()`
5. Add Tailwind classes for styling (OKLCH colors only)
6. Document the component in this file if it's commonly reused
