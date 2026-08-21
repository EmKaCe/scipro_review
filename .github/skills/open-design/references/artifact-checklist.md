# Artifact Quality Checklist

Use this checklist after generating or fixing Open Design HTML artifacts. Inspired by the OD web-prototype skill's P0/P1/P2 structure.

## P0 — Must Pass

- [ ] **No hex in `:root` CSS variable blocks**: All color values use OKLCH format
- [ ] **No percentage OKLCH**: All OKLCH lightness values use 0–1 decimal scale (not N%)
- [ ] **`--skeleton` variable exists**: Skeleton/loading elements use `var(--skeleton)`, not `var(--border)`
- [ ] **`--destructive` variable exists**: Error/destructive elements use `var(--destructive)`, not hardcoded hex
- [ ] **No hardcoded hex in element styles**: `#dc2626`, `#ef4444`, `#f3f4f6` etc. → use CSS variables
- [ ] **No `rgba()` in overlays**: Header backgrounds, backdrops use OKLCH with alpha (`oklch(1 0 0 / 0.8)`)
- [ ] **`--muted` maps to foreground**: Not to muted background color
- [ ] **Dark mode variables use OKLCH**: No hex values in `.dark` block
- [ ] **Scrollbar colors use decimal OKLCH**: Not percentage
- [ ] **Self-contained HTML**: No external dependencies that break offline rendering (CDN fonts are acceptable)
- [ ] **Dark mode toggle works**: `.dark` class toggle renders correctly
- [ ] **No horizontal scroll at 920px**: Mobile reflow works

## P1 — Should Pass

- [ ] **Prose variables use OKLCH**: `--prose-headings`, `--prose-body`, etc. not hex
- [ ] **Consistent theme toggle approach**: All pages use the same JS method (not mixing Tailwind `dark:block` with JS `classList.toggle`)
- [ ] **Version strings consistent**: Same version across all pages
- [ ] **Destructive backgrounds use OKLCH**: `--destructive-bg` not hex like `#fef2f2`
- [ ] **No redundant CSS variables**: Remove duplicates like `--footer-text` that equal `--muted`
- [ ] **`data-od-id` on sections**: Enables OD comment mode on top-level sections
- [ ] **Accent used sparingly**: At most twice per screen
- [ ] **No emoji as feature icons**: Use inline SVG monoline marks
- [ ] **No filler copy**: No "Feature One / Feature Two" or lorem ipsum
- [ ] **Numerics use monospace**: Prices, stats, version numbers in tabular figures

## P2 — Nice to Have

- [ ] **`text-wrap: pretty` / `balance`**: For long paragraphs / headings
- [ ] **`color-mix()` for derived tones**: Avoid extra token variables
- [ ] **Frosted glass on sticky nav**: `backdrop-filter: blur()` with OKLCH alpha
- [ ] **System-first fonts**: Only load Google Fonts if specified in DESIGN.md
- [ ] **Hover states on all interactive elements**: Buttons, links, cards
- [ ] **Focus-visible outlines**: Keyboard navigation support
- [ ] **ARIA labels on icon-only buttons**: Theme toggle, close buttons, etc.

## Audit Commands

Run these after fixing artifacts to verify:

```bash
# Check for hex in CSS variables (exclude URLs and data URIs)
grep -n '#[0-9a-fA-F]\{3,8\}' <file> | grep -v 'src=\|href=\|url(\|data:'

# Check for percentage OKLCH
grep -n 'oklch([5-9][0-9]%' <file>

# Check for skeleton using --border
grep -n 'background.*var(--border)' <file>

# Check for rgba in overlays
grep -n 'rgba(' <file>
```