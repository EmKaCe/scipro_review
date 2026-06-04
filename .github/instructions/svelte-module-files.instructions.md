---
applyTo: "**/*.svelte.ts,**/*.svelte.js"
---

# Svelte Module File Instructions (.svelte.ts / .svelte.js)

These files are special — they behave like regular `.ts`/`.js` modules but **can use Svelte 5 runes** (`$state`, `$derived`, `$effect`). They are the only place outside `.svelte` files where runes are valid.

## Critical Rules

### ✅ Allowed: Exporting `$state` objects
You CAN export objects/arrays created with `$state()`:
```ts
export const counter = $state({ count: 0 });
export function increment() { counter.count += 1; }
```

### ❌ Forbidden: Exporting reassigned `$state` directly
You CANNOT export a `$state` variable that gets reassigned:
```ts
// ❌ WRONG — will break at runtime
export let count = $state(0);
export function increment() { count += 1; }
```

Instead, either:
- Wrap in an object: `export const state = $state({ count: 0 })`
- Export a getter function: `export function getCount() { return count; }`

### ❌ Forbidden: Exporting `$derived` values
You CANNOT export `$derived` values:
```ts
// ❌ WRONG — compiler error
export const doubled = $derived(count * 2);
```

Instead, export a function that returns the derived value:
```ts
export function isAuthenticated(): boolean { return authState.user !== null; }
```

### ✅ Allowed: Using `$derived` internally
You CAN use `$derived` inside `.svelte.ts` files for internal computation:
```ts
const count = $state(0);
const doubled = $derived(count * 2); // OK — not exported
```

## Best Practices

### Shared State (Replacing Stores)
Use `.svelte.ts` files instead of Svelte stores for shared reactive state:
```ts
// user.svelte.ts
export const userState = $state({
  name: '',
  isLoggedIn: false
});
```

### Reactive Classes
Use `$state` in class fields:
```ts
class Todo {
  done = $state(false);
  text = $state('');

  constructor(text: string) {
    this.text = text;
  }

  toggle = () => { this.done = !this.done; };
}
```

### Reactive Built-ins
Use reactive versions from `svelte/reactivity` instead of plain built-ins:
- `SvelteMap` instead of `Map`
- `SvelteSet` instead of `Set`
- `SvelteDate` instead of `Date`
- `SvelteURL` instead of `URL`
- `MediaQuery` for reactive media queries

### Testing with Runes
Test files can use runes if the filename includes `.svelte`:
- `counter.svelte.test.ts` — ✅ runes work
- `counter.test.ts` — ❌ runes don't work

Wrap effect-based tests in `$effect.root()`:
```ts
const cleanup = $effect.root(() => {
  // test code with $effect
});
cleanup();
```

## What NOT to Do
- ❌ Use `$state`/`$derived`/`$effect` in plain `.ts` files — only in `.svelte.ts`/`.svelte.js`
- ❌ Export `$derived` values — export functions instead
- ❌ Export reassigned `$state` — export objects or getter functions
- ❌ Import from `svelte/store` for new code — use `$state` in `.svelte.ts` instead
