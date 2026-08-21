---
name: open-design
description: "Use when: creating, reviewing, or fixing HTML prototypes in Open Design; generating design artifacts with the OD daemon; writing prompts or briefs for OD generation; auditing OKLCH colors in generated HTML; working with OD MCP tools (create_artifact, get_artifact, get_file, search_files); setting up OD projects; choosing the right OD skill for a design task; applying design systems to prototypes; or extending generated artifacts into a SvelteKit codebase. Covers the full workflow from generation through audit to handoff."
argument-hint: "<task: generate | audit | fix | handoff | setup>"
---

# Open Design

Create, audit, fix, and hand off HTML prototypes using the local Open Design daemon and its MCP tools. This skill covers the full lifecycle: project setup → artifact generation → color/format audit → bug fixes → codebase handoff.

## When to Use

- Generating HTML prototypes via the OD daemon
- Writing prompts or briefs for OD artifact generation
- Choosing the right OD skill for a design task
- Reading or searching OD project files via MCP tools
- Auditing generated artifacts for color format issues (hex, percentage OKLCH)
- Fixing systematic bugs across multiple OD artifacts
- Handing off OD prototypes into a SvelteKit + Tailwind v4 codebase
- Setting up or troubleshooting the OD daemon

## Resource Map

```
open-design/
├── SKILL.md                 ← you're reading this
└── references/
    ├── prompting.md          ← how to write effective briefs, skill selection, prompt structure
    ├── oklch-colors.md       ← canonical OKLCH values, audit patterns, gotchas
    ├── mcp-tools.md          ← MCP tool reference, parameters, and usage patterns
    └── artifact-checklist.md  ← P0/P1/P2 quality gates for generated HTML
```

## Workflow

### 1. Setup — Verify Daemon & Project

1. Check daemon is running: `od status --json` (or `GET /api/health`)
2. If not running: `od --port 7456` or `pnpm tools-dev`
3. Identify the project: use `list_projects` or `get_active_context`
4. Note the project data dir (typically `~/.local/share/open-design/projects/<id>/`)

### 2. Generate — Create Artifacts

The daemon assembles a **prompt stack** from: the active `DESIGN.md`, the active `SKILL.md`, and the user's brief. The agent follows a 3-turn arc: discovery form → brand/plan branch → build + emit.

Read [references/prompting.md](./references/prompting.md) for the full prompting guide including skill selection, brief structure, and example prompts.

#### 2a. Choose the right skill

| You're Building | Skill |
|---|---|
| Landing page, marketing, hero | `web-prototype` |
| SaaS landing with hero/features/pricing/CTA | `saas-landing` |
| Admin dashboard, analytics | `dashboard` |
| Documentation site | `docs-page` |
| Blog post, editorial | `blog-post` |
| Pricing page | `pricing-page` |
| Mobile app screens | `mobile-app` |
| Presentation / slide deck | `guizang-ppt` |
| Product spec / PRD | `pm-spec` |
| Wireframe sketch (ideation) | `wireframe-sketch` |

Default: `web-prototype` for prototype mode, `guizang-ppt` for deck mode.

#### 2b. Write the brief

A good brief answers 6 questions upfront:

1. **What** — artifact type + page/screen structure
2. **Who** — target audience
3. **Tone** — visual direction (editorial, minimal, playful, brutalist)
4. **Brand** — existing brand spec, reference site, or "pick for me"
5. **Scale** — number of sections, screens, or slides
6. **Constraints** — must-haves (dark mode, responsive, no animations, etc.)

**Example brief:**
> Build a SaaS landing page for "DataPulse" — a real-time analytics platform. Audience: technical founders at mid-market companies. Tone: modern minimal, dark-first. Sections: hero with tagline + CTA, 3 feature cards with icons, social proof (4 logos), pricing table (3 tiers), footer. Brand: use the active design system. No emoji icons.

**Anti-patterns to avoid:**
- Too vague: "Make a nice website"
- Too prescriptive: "Use #3B82F6 for buttons with 8px border-radius" (fights the design system)
- No audience: "For everyone" (defaults to generic corporate)
- Invented metrics: "Show 10x faster" (agent fabricates data; use `—` placeholders)

#### 2c. Select the design system

The `DESIGN.md` controls visual identity. OD ships 71+ built-in systems. For SvelteKit + shadcn-svelte projects, select the **shadcn** system or create a custom `DESIGN.md` from your project's `layout.css` OKLCH values.

#### 2d. Generate and iterate

1. Send the brief via the OD web UI or CLI
2. The agent emits a discovery form — answer or skip if your brief already covers it
3. The agent builds the artifact and self-checks via 5-dimensional critique (Philosophy, Hierarchy, Execution, Specificity, Restraint — each must score ≥ 3/5)
4. Review the output — if it needs changes, send a follow-up tweak prompt
5. When generating via the coding agent (not the OD UI), use `create_artifact` to write the output

### 3. Audit — Check Generated Artifacts

**Always audit after generation.** Generated HTML has systematic issues. Read [references/oklch-colors.md](./references/oklch-colors.md) for the full color audit procedure.

Quick audit checklist:
1. **Hex in `:root`** — grep for `#[0-9a-fA-F]{3,8}` in CSS variable blocks → replace with OKLCH
2. **Percentage OKLCH** — grep for `oklch([0-9]+%` → convert to 0–1 decimal scale
3. **Missing variables** — check for `--skeleton`, `--destructive` in `:root`
4. **Hardcoded colors** — `#dc2626`, `rgba(...)` in element styles → use CSS variables
5. **Scrollbar thumbs** — always use percentage OKLCH → fix to decimal

Run the full checklist from [references/artifact-checklist.md](./references/artifact-checklist.md).

### 4. Fix — Apply Corrections

Fix issues systematically across all artifacts in the project:
1. Fix `:root` hex → OKLCH (all files at once)
2. Fix percentage OKLCH → decimal (scrollbar, `--muted`, etc.)
3. Add missing CSS variables (`--skeleton`, `--destructive`)
4. Replace hardcoded colors with `var(--*)` references
5. Fix dark mode inconsistencies

Use `multi_replace_string_in_file` for batch fixes across files.

### 5. Verify — Confirm Fixes

1. Grep for remaining hex in CSS variable blocks: should find zero
2. Grep for percentage OKLCH: should find zero
3. Open artifacts in browser to visually verify rendering
4. Test dark mode toggle on each artifact

### 6. Handoff — Extend into Codebase

When extending an OD design into the SvelteKit project:
1. Pull the full bundle once with `get_artifact` — don't fetch files one-by-one
2. Map OD CSS variables to shadcn-svelte variables (see [references/oklch-colors.md](./references/oklch-colors.md))
3. Convert HTML structure to Svelte 5 components (runes, snippets, events)
4. Replace inline styles with Tailwind utility classes
5. Use shadcn-svelte components instead of custom HTML equivalents

## Gotchas

- **Hex in light mode, OKLCH in dark mode**: OD generates hex for `:root` and OKLCH for `.dark`. Always audit `:root` blocks after generation.
- **Percentage OKLCH**: OD uses `oklch(50% ...)` instead of `oklch(0.5 ...)`. CSS allows both but project convention is 0–1 decimal.
- **`--muted` confusion**: OD maps `--muted` to the muted *background* color. Project convention maps it to `--muted-foreground`. Verify the mapping.
- **Missing `--skeleton`**: OD doesn't generate a skeleton variable. Skeleton elements use `--border` instead. Add `--skeleton` manually.
- **`rgba()` in overlays**: OD uses `rgba(255,255,255,0.8)` for header backgrounds. Replace with `oklch(1 0 0 / 0.8)`.
- **`od doctor` crashes in v0.8.0**: Use `od status --json` instead.
- **MCP `project` param is optional**: When omitted, tools default to the active project/file in OD. Pass explicitly to override.
- **`get_artifact` > multiple `get_file`**: Always prefer `get_artifact` to pull the entry file plus all referenced siblings in one call.
- **File references are relative**: OD project paths in MCP tools are relative to the project root, not absolute filesystem paths.
- **`search_files` is literal**: Not regex. Case-insensitive substring search only.

## MCP Tool Quick Reference

| Tool | Purpose | Key Params |
|------|---------|------------|
| `list_projects` | List all OD projects | — |
| `get_active_context` | Current project + file in OD UI | — |
| `get_project` | Project metadata | `project?` |
| `get_artifact` | Entry file + all referenced siblings | `entry?`, `include?`, `maxBytes?` |
| `get_file` | Single file content | `path?`, `offset?`, `limit?` |
| `list_files` | File metadata (mime, size, mtime) | `since?` |
| `search_files` | Case-insensitive literal substring search | `query`, `pattern?`, `max?` |
| `create_artifact` | Create new artifact entry file | `name`, `content`, `encoding?`, `artifactManifest?` |

See [references/mcp-tools.md](./references/mcp-tools.md) for detailed parameters and usage patterns.