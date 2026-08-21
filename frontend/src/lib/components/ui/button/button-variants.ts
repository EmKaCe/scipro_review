/**
 * Shared button variants for the whole app — one source of truth so every
 * button (regular, bulk bar, split-menu, dialogs) looks the same.
 *
 * Plain class-string maps (no variant-library dependency); the keys and class
 * strings mirror the previous shadcn button-variant API exactly.
 */
const BASE =
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

export const BUTTON_VARIANTS: Record<string, string> = {
	default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
	destructive: "bg-destructive text-white shadow-sm hover:bg-destructive/90",
	outline:
		"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
	secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
	ghost: "hover:bg-accent hover:text-accent-foreground",
	link: "text-primary underline-offset-4 hover:underline",
	success: "bg-success text-white shadow hover:bg-success/90",
};

export const BUTTON_SIZES: Record<string, string> = {
	default: "h-9 px-4 py-2",
	sm: "h-8 rounded-md px-3 text-xs",
	xs: "h-6 rounded px-2 text-xs",
	icon: "h-9 w-9",
};

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

export type ButtonVariants = {
	variant?: ButtonVariant;
	size?: ButtonSize;
};

/** Build the class string for a button variant/size pair. */
export function buttonVariants(opts: { variant?: ButtonVariant; size?: ButtonSize } = {}): string {
	const variant = (opts.variant ?? "default") as ButtonVariant;
	const size = (opts.size ?? "default") as ButtonSize;
	const variantClass = BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.default;
	const sizeClass = BUTTON_SIZES[size] ?? BUTTON_SIZES.default;
	return `${BASE} ${variantClass} ${sizeClass}`;
}
