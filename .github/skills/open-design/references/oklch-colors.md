# OKLCH Color Audit for Open Design Artifacts

## The Systematic Problem

When generating HTML prototypes with Open Design (especially using the shadcn design system), the generated artifacts consistently produce **hex colors in light mode** and **OKLCH in dark mode** for the same CSS variables. This is a systematic issue that affects ALL generated artifacts.

Additionally, OD uses **percentage-based OKLCH** (e.g., `oklch(50% ...)`) instead of the project's **0–1 decimal scale** (e.g., `oklch(0.5 ...)`).

## Canonical OKLCH Values

These values come from the shadcn-svelte `mist` theme in `layout.css`. When auditing OD artifacts, replace all hex and percentage values with these.

### Light Mode (`:root`)

| OD Variable | shadcn Equivalent | OKLCH Value | Notes |
|---|---|---|---|
| `--bg` | `--background` | `oklch(1 0 0)` | Pure white |
| `--fg` | `--foreground` | `oklch(0.148 0.004 228.8)` | Near-black |
| `--surface` | `--card` | `oklch(1 0 0)` | Same as bg |
| `--card-bg` | `--card` | `oklch(1 0 0)` | Same as bg |
| `--border` | `--border` | `oklch(0.925 0.005 214.3)` | Light gray |
| `--muted` | `--muted-foreground` | `oklch(0.56 0.021 213.5)` | **Not** muted bg |
| `--accent` | `--primary` | `oklch(0.508 0.118 165.612)` | Teal/green |
| `--destructive` | `--destructive` | `oklch(0.577 0.245 27.325)` | Red |
| `--skeleton` | `--muted` (bg) | `oklch(0.963 0.002 197.1)` | Very light gray |

### Dark Mode (`.dark`)

| OD Variable | shadcn Equivalent | OKLCH Value |
|---|---|---|
| `--bg` | `--background` | `oklch(0.148 0.004 228.8)` |
| `--fg` | `--foreground` | `oklch(0.987 0.002 197.1)` |
| `--surface` | `--card` | `oklch(0.218 0.008 223.9)` |
| `--card-bg` | `--card` | `oklch(0.218 0.008 223.9)` |
| `--border` | `--border` | `oklch(1 0 0 / 10%)` |
| `--muted` | `--muted-foreground` | `oklch(0.723 0.014 214.4)` |
| `--accent` | `--primary` | `oklch(0.432 0.095 166.913)` |
| `--destructive` | `--destructive` | `oklch(0.704 0.191 22.216)` |
| `--skeleton` | `--muted` (bg) | `oklch(0.275 0.011 216.9)` |

## Audit Procedure

### Step 1: Find hex colors in CSS variable blocks

Search all artifact HTML files for hex values in `:root`:

```bash
grep -n '#[0-9a-fA-F]\{3,8\}' <file> | grep -v 'src=\|href=\|url(\|data:'
```

Exclude `src=`, `href=`, `url()`, and `data:` to avoid matching hex in URLs/data URIs.

### Step 2: Find percentage-based OKLCH

Search for OKLCH values using percentages (N% where N > 1):

```bash
grep -n 'oklch([5-9][0-9]%' <file>
```

Common patterns to fix:
- `oklch(50% 0.018 240)` → `oklch(0.56 0.021 213.5)` (also fix hue/chroma to match canonical)
- `oklch(60% 0.018 240)` → `oklch(0.723 0.014 214.4)`
- `oklch(70% ...)` → `oklch(0.7 ...)`
- Scrollbar thumb values always use percentage → fix to decimal

### Step 3: Check for missing CSS variables

Verify these variables exist in `:root`:
- `--skeleton` — OD doesn't generate this; skeleton elements incorrectly use `--border`
- `--destructive` — sometimes missing; error states use hardcoded hex instead

### Step 4: Check for hardcoded colors in element styles

Common patterns:
- `#dc2626` / `#ef4444` in error/destructive badges → `var(--destructive)`
- `rgba(255, 255, 255, 0.8)` in header backgrounds → `oklch(1 0 0 / 0.8)`
- `#f3f4f6` in skeleton backgrounds → `var(--skeleton)`
- `#fef2f2` in destructive backgrounds → `oklch(0.97 0.015 25)`

### Step 5: Check prose/typography variables

If the artifact has `--prose-*` variables, verify they use OKLCH not hex:
- `--prose-headings` → `oklch(0.148 0.004 228.8)`
- `--prose-body` → `oklch(0.37 0.013 285.805)`
- `--prose-muted` → `oklch(0.56 0.021 213.5)`
- `--prose-bullets` → `oklch(0.925 0.005 214.3)`
- `--prose-blockquote` → `oklch(0.963 0.002 197.1)`
- `--prose-blockquote-border` → `oklch(0.925 0.005 214.3)`

## Variable Mapping: OD → shadcn-svelte

When handing off OD prototypes to the SvelteKit codebase, map OD CSS variables to shadcn-svelte equivalents:

| OD Variable | shadcn-svelte Variable | Same Value? |
|---|---|---|
| `--bg` | `--background` | Yes |
| `--fg` | `--foreground` | Yes |
| `--surface` | `--card` | Yes |
| `--card-bg` | `--card` | Yes |
| `--border` | `--border` | Yes |
| `--muted` | `--muted-foreground` | Yes (but OD sometimes maps to `--muted` bg) |
| `--accent` | `--primary` | Yes |
| `--destructive` | `--destructive` | Yes |
| `--skeleton` | `--muted` (background) | Yes |

## Prevention Checklist

After every OD artifact generation:
- [ ] No hex values in `:root` CSS variable blocks
- [ ] No percentage-based OKLCH (all values 0–1 decimal scale)
- [ ] `--skeleton` variable exists and is used for skeleton elements
- [ ] `--destructive` variable exists and is used for error states
- [ ] No hardcoded hex colors in element styles (use `var(--*)`)
- [ ] No `rgba()` in overlays (use OKLCH with alpha)
- [ ] `--muted` maps to `--muted-foreground` (not `--muted` background)
- [ ] Scrollbar thumb colors use decimal OKLCH
- [ ] Prose variables (if present) use OKLCH not hex