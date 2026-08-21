# Prompting Open Design — How to Write Effective Briefs

## The OD Generation Pipeline

When you send a prompt to Open Design, the daemon assembles a **prompt stack** — a layered composition, not a simple "system + user" prompt:

1. **DISCOVERY directives** — from the discovery form answers (dominant, overrides later layers)
2. **Identity charter** — `OFFICIAL_DESIGNER_PROMPT` + anti-AI-slop guidelines
3. **Active `DESIGN.md`** — design system tokens (color, typography, spacing, etc.)
4. **Active `SKILL.md`** — workflow instructions for the artifact type
5. **Project metadata** — kind, fidelity, speaker notes, animations
6. **Skill side files** — `assets/template.html`, `references/*.md` (auto-injected pre-flight)

The agent follows a 3-turn arc:
- **Turn 1**: Emit a `<question-form id="discovery">` to clarify visual direction
- **Turn 2**: Branch on brand answers → brand-spec extraction or `TodoWrite` plan
- **Turn 3+**: Execute plan, build, self-check, emit `<artifact>`

## Choosing the Right Skill

OD ships 132+ built-in skills. Pick the one that matches your artifact type:

| You're Building | Skill | Mode |
|---|---|---|
| Landing page, marketing, hero | `web-prototype` | prototype |
| SaaS landing with hero/features/pricing/CTA | `saas-landing` | prototype |
| Admin dashboard, analytics | `dashboard` | prototype |
| Documentation site | `docs-page` | prototype |
| Blog post, editorial long-form | `blog-post` | prototype |
| Pricing page with comparison tables | `pricing-page` | prototype |
| Mobile app screens (iPhone/Pixel frame) | `mobile-app` | prototype |
| Mobile onboarding flow | `mobile-onboarding` | prototype |
| Presentation / slide deck | `guizang-ppt` | deck |
| Team weekly update deck | `weekly-update` | deck |
| Product spec / PRD | `pm-spec` | prototype |
| OKR tracker | `team-okrs` | prototype |
| Meeting notes | `meeting-notes` | prototype |
| Invoice | `invoice` | prototype |
| Wireframe sketch (ideation) | `wireframe-sketch` | prototype |

**Default**: If no skill matches, `web-prototype` is used for prototype mode and `guizang-ppt` for deck mode.

## Writing an Effective Brief

### Structure

A good brief answers these questions upfront so the discovery form can be shorter:

1. **What** — The artifact type and page/screen structure
2. **Who** — Target audience (students, enterprise admins, consumers)
3. **Tone** — Visual direction (editorial, minimal, playful, brutalist)
4. **Brand** — Existing brand spec, reference site, or "pick for me"
5. **Scale** — How many sections, screens, or slides
6. **Constraints** — Anything the agent must know (no animations, must support dark mode, etc.)

### Example Briefs

**SaaS Landing Page:**
> Build a SaaS landing page for "DataPulse" — a real-time analytics platform for e-commerce. Audience: technical founders and CTOs at mid-market companies. Tone: modern minimal, dark-first. Sections: hero with tagline + CTA, 3 feature cards with icons, social proof (4 logos), pricing table (3 tiers), footer. Brand: use the active design system. No emoji icons.

**Dashboard:**
> Create an admin dashboard for a peer-review grading tool called "SciPro Review". Audience: university physics professors. Tone: clean, information-dense, no decoration. Sections: sidebar nav (5 items), top bar with search + user avatar, main area with KPI cards (4), recent reviews table (8 columns), activity feed. Must support light/dark mode toggle. Use monospace for all numerics.

**Mobile App:**
> Design a 3-screen mobile app prototype for "FocusFlow" — a Pomodoro timer with task management. Audience: knowledge workers. Tone: playful but not childish, warm colors. Screens: splash with logo, active timer with task list, settings. iPhone 15 Pro frame. Must show timer in both running and paused states.

**Documentation Page:**
> Build a docs page for a CLI tool called "od" (Open Design). Audience: developers integrating OD into their workflow. Tone: engineering, clean, no fluff. Sections: 3-column layout with inline-start nav, scrollable article body, inline-end TOC. Cover: installation, quickstart, configuration, API reference, contributing. Use code blocks with syntax highlighting.

**Presentation Deck:**
> Create a 10-slide product walkthrough deck for "DataPulse". Tone: magazine editorial, serif display font, cream background. Slides: cover, problem, solution overview, 3 feature deep-dives, architecture diagram, pricing, roadmap, CTA. Speaker notes on every slide.

### What to Include vs. Omit

**Include:**
- Real product name and tagline
- Specific section names and content hints
- Target audience (affects tone, density, vocabulary)
- Visual tone preference
- Number of sections/screens/slides
- Must-have features (dark mode, responsive, etc.)

**Omit:**
- CSS implementation details (the skill handles this)
- Specific color values (the design system provides these)
- Layout pixel measurements (the skill's template handles spacing)
- Font names (unless overriding the design system)

### Anti-Patterns in Briefs

- **Too vague**: "Make a nice website" → agent defaults to generic choices
- **Too prescriptive**: "Use #3B82F6 for buttons with 8px border-radius" → fights the design system
- **Contradictory**: "Minimal but with lots of animations" → agent can't resolve
- **No audience**: "For everyone" → agent defaults to generic corporate tone
- **Invented metrics**: "Show 10x faster performance" → agent will fabricate data; use `—` or labeled placeholders instead

## Design System Selection

The design system (`DESIGN.md`) controls the visual identity. OD ships 71+ built-in systems:

- **Neutral Modern** — hand-authored starter, clean and generic
- **Warm Editorial** — hand-authored starter, serif-forward, cream tones
- **69 product systems** — imported from `awesome-design-md`, grouped by category (AI & LLM, Developer Tools, Productivity, Backend, Design Tools, Fintech, E-Commerce, Media, Automotive)

When using OD with a SvelteKit + shadcn-svelte project:
- Select the **shadcn** design system if available
- Or create a custom `DESIGN.md` from your project's `layout.css` OKLCH values
- The design system's color tokens will be injected into the agent's prompt, reducing (but not eliminating) the hex-in-light-mode issue

## 5-Dimensional Self-Critique

Before emitting an artifact, the agent silently scores itself 1–5 on:

| Dimension | Question | Score 3+ Means |
|---|---|---|
| **Philosophy** | Does the visual posture match the requested style? | Not defaulting to a preferred style |
| **Hierarchy** | Does the eye land on an obvious focal point? | Elements don't compete for attention |
| **Execution** | Is typography, spacing, alignment precise? | No sloppy gaps or misalignment |
| **Specificity** | Is every word/number tailored to the brief? | No generic filler or lorem ipsum |
| **Restraint** | Are accents decisive and limited? | Not over-decorated |

If any dimension < 3, the agent revises and rescores. Two passes is normal.

## After Generation: Always Audit

The design system reduces but does not eliminate systematic issues. After every generation:

1. Run the OKLCH color audit (see [oklch-colors.md](./oklch-colors.md))
2. Run the artifact checklist (see [artifact-checklist.md](./artifact-checklist.md))
3. Fix any issues found
4. Verify visually in browser with dark mode toggle