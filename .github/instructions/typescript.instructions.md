---
applyTo: "**/*.ts"
excludeAgent: "code-review"
---

# TypeScript Instructions (.ts)

This project uses **TypeScript 6.0+** with strict mode enabled. These instructions apply to plain `.ts` files (not `.svelte.ts` or `.svelte` files).

## Critical Rules

### ❌ No Runes in Plain `.ts` Files
`$state`, `$derived`, `$effect`, `$props` are **compiler transforms** that only work in `.svelte` and `.svelte.ts`/`.svelte.js` files. Using them in plain `.ts` will throw "is not defined" at runtime.

### ✅ Use `import type` for Type-Only Imports
With `verbatimModuleSyntax: true` in tsconfig, type-only imports must use `import type`:
```ts
import type { Component } from 'svelte';
import { someValue } from './module.js'; // runtime import
```

### ✅ Use `.js` Extension in Import Paths
TypeScript 6 with `moduleResolution: "bundler"` requires `.js` extensions in import paths (even when importing `.ts` files):
```ts
import { helper } from './utils/helper.js'; // ✅ correct
import { helper } from './utils/helper';    // ❌ wrong
```

## TypeScript 6 Best Practices

### Type Annotations
- Prefer `interface` over `type` for object shapes (better error messages, extends, implements)
- Use `type` for unions, intersections, and utility types
- Use `as const` for literal types and readonly tuples
- Use `satisfies` operator to type-check without widening: `const x = { a: 1 } satisfies Record<string, number>`

### Generics
- Use descriptive generic parameter names: `TItem`, `TResponse`, `TConfig`
- Constrain generics with `extends`: `function process<T extends { id: string }>(item: T)`
- Use generic defaults: `function createStore<T = unknown>()`

### Type Safety
- Avoid `any` — use `unknown` and type narrowing instead
- Use `as` casts sparingly and only when you're certain of the type
- Prefer type guards (`value is Type`) over type assertions
- Use ` satisfies` to validate types without widening

### Modern TypeScript Features
- Use `using` declarations for `Disposable` resources (TS 5.2+)
- Use `const` type parameters: `function getProps<const T>(props: T)` for literal inference
- Use `import ... with { type: 'json' }` for JSON imports
- Use `await using` for async disposable resources

## SvelteKit-Specific Type Patterns

### Route Types
```ts
// In +page.ts / +layout.ts files
import type { PageLoad, PageServerLoad, LayoutLoad, LayoutServerLoad } from './$types';
import type { PageProps, LayoutProps } from './$types'; // SvelteKit 2.16+
```

### Component Types
```ts
import type { Component, ComponentProps } from 'svelte';

// Type a component reference
let MyComponent: Component<{ name: string }>;

// Extract props from a component
type MyProps = ComponentProps<typeof MyComponent>;
```

### App-Wide Types (in `src/app.d.ts`)
```ts
declare global {
  namespace App {
    interface Error { message: string; code?: string; }
    interface Locals { user?: { id: string; name: string }; }
    interface PageData { title?: string; }
    interface PageState { modal?: boolean; }
    interface Platform { /* adapter-specific */ }
  }
}
export {};
```

## Project Conventions
- **Strict mode**: `strict: true` in tsconfig
- **Module resolution**: `"bundler"` (set by SvelteKit)
- **Target**: `"esnext"` (set by SvelteKit)
- **No barrel files** for `@lucide/svelte` — use direct path imports: `import { ArrowRight } from '@lucide/svelte/icons/arrow-right'`
- **No `tailwind.config.ts`** — Tailwind v4 uses CSS-based config
- **No `.eslintrc.*`** — ESLint v10+ uses flat config in `eslint.config.js`
