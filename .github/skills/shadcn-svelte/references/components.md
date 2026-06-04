# shadcn-svelte Component Reference

## Installation

All components are installed via CLI from `frontend/`:

```bash
pnpm dlx shadcn-svelte@latest add <component>
```

Overwrite existing: add `--overwrite`. Install all: add `--all`.

## Component Catalog

| Category | Components |
|----------|-----------|
| Form & Input | Button, Button Group, Calendar, Checkbox, Combobox, Date Picker, Field, Form, Input, Input Group, Input OTP, Label, Native Select, Radio Group, Select, Slider, Switch, Textarea |
| Layout & Navigation | Accordion, Breadcrumb, Navigation Menu, Resizable, Scroll Area, Separator, Sidebar, Tabs |
| Overlays & Dialogs | Alert Dialog, Command, Context Menu, Dialog, Drawer, Dropdown Menu, Hover Card, Menubar, Popover, Sheet, Tooltip |
| Feedback & Status | Alert, Badge, Empty, Progress, Skeleton, Sonner, Spinner |
| Display & Media | Aspect Ratio, Avatar, Card, Carousel, Chart, Data Table, Item, Kbd, Table, Typography |
| Misc | Collapsible, Pagination, Range Calendar, Toggle, Toggle Group |

## Component API Patterns

### Button

```svelte
<script>
  import { Button } from "$lib/components/ui/button";
</script>

<Button variant="outline" size="sm">Small Outline</Button>
```

Variants: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`
Sizes: `default`, `sm`, `lg`, `icon`

### Dialog

```svelte
<script>
  import {
    Dialog, DialogContent, DialogDescription,
    DialogFooter, DialogHeader, DialogTitle, DialogTrigger
  } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
</script>

<Dialog>
  <DialogTrigger asChild let:builder>
    <Button builders={[builder]}>Open</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Are you sure?</DialogTitle>
      <DialogDescription>This action cannot be undone.</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button>Confirm</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### Table

```svelte
<script>
  import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow
  } from "$lib/components/ui/table";
</script>

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Status</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>Item 1</TableCell>
      <TableCell>Active</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

For advanced data tables with sorting/filtering, use the Data Table component (built on TanStack Table).

### Form (Formsnap + Superforms + Zod)

**Schema** (`src/routes/<page>/schema.ts`):

```ts
import { z } from "zod";

export const formSchema = z.object({
  username: z.string().min(2).max(50),
});
export type FormSchema = typeof formSchema;
```

**Server load** (`+page.server.ts`):

```ts
import type { PageServerLoad } from "./$types.js";
import { superValidate } from "sveltekit-superforms";
import { formSchema } from "./schema";
import { zod4 } from "sveltekit-superforms/adapters";

export const load: PageServerLoad = async () => {
  return {
    form: await superValidate(zod4(formSchema)),
  };
};
```

**Server action** (`+page.server.ts`):

```ts
import type { Actions } from "./$types.js";
import { fail } from "@sveltejs/kit";
import { superValidate } from "sveltekit-superforms";
import { zod4 } from "sveltekit-superforms/adapters";
import { formSchema } from "./schema";

export const actions: Actions = {
  default: async (event) => {
    const form = await superValidate(event, zod4(formSchema));
    if (!form.valid) return fail(400, { form });
    return { form };
  },
};
```

**Form component** (Svelte 5 snippet syntax):

```svelte
<script lang="ts">
  import * as Form from "$lib/components/ui/form";
  import { Input } from "$lib/components/ui/input";
  import { formSchema, type FormSchema } from "./schema";
  import {
    type SuperValidated, type Infer, superForm,
  } from "sveltekit-superforms";
  import { zod4Client } from "sveltekit-superforms/adapters";

  let { data } = $props<{
    data: { form: SuperValidated<Infer<FormSchema>> }
  }>();

  const form = superForm(data.form, {
    validators: zod4Client(formSchema),
  });
  const { form: formData, enhance } = form;
</script>

<form method="POST" use:enhance>
  <Form.Field {form} name="username">
    <Form.Control>
      {#snippet children({ props })}
        <Form.Label>Username</Form.Label>
        <Input {...props} bind:value={$formData.username} />
      {/snippet}
    </Form.Control>
    <Form.Description>Your public display name.</Form.Description>
    <Form.FieldErrors />
  </Form.Field>
  <Form.Button>Submit</Form.Button>
</form>
```

### Sonner (Toast notifications)

```svelte
<script>
  import { Sonner, toast } from "$lib/components/ui/sonner";
</script>

<Sonner />
<button onclick={() => toast.success("Saved!")}>Save</button>
```

### Checkbox

```svelte
<script>
  import { Checkbox } from "$lib/components/ui/checkbox";
  let checked = $state(false);
</script>

<Checkbox bind:checked />
```

### Select

```svelte
<script>
  import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue
  } from "$lib/components/ui/select";
</script>

<Select>
  <SelectTrigger>
    <SelectValue placeholder="Select option" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="option1">Option 1</SelectItem>
    <SelectItem value="option2">Option 2</SelectItem>
  </SelectContent>
</Select>
```

### Card

```svelte
<script>
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
</script>

<Card>
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Card description</CardDescription>
  </CardHeader>
  <CardContent>Card content goes here.</CardContent>
</Card>
```

### Sheet (Side panel)

```svelte
<script>
  import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";
</script>

<Sheet>
  <SheetTrigger asChild let:builder>
    <Button builders={[builder]}>Open</Button>
  </SheetTrigger>
  <SheetContent>
    <SheetHeader>
      <SheetTitle>Settings</SheetTitle>
    </SheetHeader>
    Sheet content here.
  </SheetContent>
</Sheet>
```

### Tooltip

```svelte
<script>
  import { Tooltip, TooltipContent, TooltipTrigger } from "$lib/components/ui/tooltip";
</script>

<Tooltip>
  <TooltipTrigger>Hover me</TooltipTrigger>
  <TooltipContent>Tooltip content</TooltipContent>
</Tooltip>
```

### Badge

```svelte
<script>
  import { Badge } from "$lib/components/ui/badge";
</script>

<Badge>Default</Badge>
<Badge variant="secondary">Secondary</Badge>
<Badge variant="destructive">Destructive</Badge>
<Badge variant="outline">Outline</Badge>
```