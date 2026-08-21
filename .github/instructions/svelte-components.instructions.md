---
applyTo: "**/*.svelte"
---

# Svelte 5 Component Instructions (.svelte)

This project uses **Svelte 5.55+** with **runes mode** enabled. All `.svelte` files must use runes syntax — legacy Svelte 4 syntax (`export let`, `on:click`, `$:`, slots) is forbidden.

## Runes Rules

### `$state()` — Reactive State
- Use `let count = $state(0)` instead of implicit `let count = 0`
- Objects and arrays passed to `$state()` become deeply reactive proxies
- For large objects that are only reassigned (not mutated), use `$state.raw()`
- Use `$state.snapshot(proxy)` to get a static copy (e.g., for passing to external libraries)
- Class fields: `count = $state(0)` in class body or `this.count = $state(0)` in constructor
- **Cannot export reassigned `$state` from modules** — export a function or mutate properties of an exported object instead

### `$derived()` — Computed Values
- Use `let doubled = $derived(count * 2)` instead of `$: doubled = count * 2`
- Use `$derived.by(() => { ... })` for complex derivations
- **DO NOT use `$effect` to compute values** — that's what `$derived` is for
- Deriveds are writable as of Svelte 5.25 (can temporarily override for optimistic UI)
- Destructuring a derived: `let { a, b } = $derived(stuff())` creates reactive bindings

### `$effect()` — Side Effects (use sparingly)
- Use for: DOM manipulation, analytics, third-party library integration, `console.log`
- **DO NOT update state inside effects** — use `$derived` or callback props instead
- Effects run after DOM mount and in a microtask after state changes
- Return a cleanup function: `$effect(() => { const interval = setInterval(...); return () => clearInterval(interval); })`
- Use `$effect.pre()` to run code before DOM updates (rare)
- Effects do NOT run on the server

### `$props()` — Component Props
- Use `let { name, count = 0, ...rest } = $props()` instead of `export let`
- Type props with TypeScript: `let { name }: { name: string } = $props()`
- Use `interface Props { ... }` pattern for complex prop types
- Use `$bindable()` for two-way bindable props: `let { value = $bindable() } = $props()`
- Use `$props.id()` (5.20+) for generating unique component instance IDs (for `for`/`aria-labelledby`)

## Template Syntax

### Event Handlers
- Use `onclick={handler}` instead of `on:click={handler}`
- Use `onchange={handler}` instead of `on:change={handler}`
- Inline: `onclick={() => count++}`
- Shorthand: `<button {onclick}>` when handler variable is named `onclick`
- Event modifiers: wrap in functions instead of using `|` syntax
  - `preventDefault`: `event.preventDefault()` inside handler
  - `once`: create a wrapper function

### Snippets (replaces slots)
- Use `{#snippet name(params)}...{/snippet}` instead of `<slot>`
- Use `{@render name(params)}` to render a snippet
- Implicit `children` snippet: content inside component tags becomes `children`
- Type snippets: `import type { Snippet } from 'svelte'` then `children: Snippet`
- Optional snippets: `{@render children?.()}` or `{#if children}...{/if}`
- **Never use `<slot>`, `let:`, or `slot=` attributes**

### Control Flow
- `{#if condition}...{:else if}...{:else}...{/if}`
- `{#each items as item, index (item.id)}...{:else}...{/each}` — always use keyed each blocks
- `{#key expression}...{/key}` — destroys and recreates content when expression changes
- `{#await promise}...{:then value}...{:catch error}...{/await}`

### Bindings
- `bind:value={variable}` for inputs
- `bind:group={array}` for grouped radio/checkbox inputs
- `bind:this={domNode}` for DOM element references
- Function bindings: `bind:value={() => value, (v) => value = v}` for validation/transformation
- Component bindings: use `$bindable()` in child, `bind:prop` in parent

### Other Directives
- `class` attribute supports objects and arrays (clsx-style): `class={{ active: isActive, disabled: !enabled }}`
- `style:` directive: `style:color={myColor}` or `style:--custom-prop={value}`
- `use:action` — consider migrating to `{@attach}` for Svelte 5.29+
- `transition:fade`, `in:fly`, `out:slide` — transitions are local by default

## TypeScript in .svelte Files
- Use `<script lang="ts">` for TypeScript support
- Type-only features only (no enums, no decorators, no `public`/`private`/`protected` in constructors)
- Use `generics="T extends { ... }"` on `<script>` for generic components
- Import types from `svelte/elements` for wrapper components: `HTMLButtonAttributes`, `SvelteHTMLElements`
- Use `ComponentProps<typeof MyComponent>` to extract prop types

## Accessibility
- Every `<img>` must have `alt` attribute
- Every `<button>` should have text content or `aria-label`
- Interactive elements need keyboard handlers alongside click handlers
- Use `<svelte:head>` for page title and meta tags
- Use `aria-hidden="true"` on decorative icons (Lucide icons are aria-hidden by default)

## CSS in .svelte Files
- Styles are scoped by default using `:where(.svelte-xyz123)` for low specificity
- Use `:global(...)` to escape scoping
- Use CSS custom properties (`--prop`) for dynamic styling via `style:--prop={value}`
- Use `@apply` inside `:global` blocks when using Tailwind

## What NOT to Do
- ❌ `export let name` — use `$props()`
- ❌ `on:click` — use `onclick`
- ❌ `<slot>` — use `{#snippet}` and `{@render}`
- ❌ `let:` directive — use snippet parameters
- ❌ `$:` statements — use `$derived` or `$effect`
- ❌ `createEventDispatcher` — use callback props
- ❌ `<svelte:component>` — components are dynamic by default in Svelte 5
- ❌ `beforeUpdate`/`afterUpdate` — use `$effect.pre`/`$effect`
- ❌ `new Component(...)` — use `mount(Component, ...)` from `svelte`
