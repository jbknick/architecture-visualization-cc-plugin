import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/lib/utils";

/*
 * shadcn `button` (base-nova style), copied from https://ui.shadcn.com/r/styles/base-nova/button.json.
 * The class-variance-authority call is replaced with two plain lookup tables, because that package is not an
 * approved dependency (docs/SPEC.md section 2).
 */
const base =
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 motion-reduce:transition-none motion-reduce:active:translate-y-0";

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/80",
  outline:
    "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
  ghost: "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
  destructive:
    "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
  link: "text-primary underline-offset-4 hover:underline",
} as const;

const sizes = {
  default: "h-8 gap-1.5 px-2.5",
  xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
  sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
  lg: "h-9 gap-1.5 px-2.5",
  icon: "size-8",
  "icon-xs": "size-6 rounded-[min(var(--radius-md),10px)] [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "size-7 rounded-[min(var(--radius-md),12px)]",
  "icon-lg": "size-9",
} as const;

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

export function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return cn(base, variants[variant], sizes[size], className);
}

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: Omit<ButtonPrimitive.Props, "className"> & {
  className?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <ButtonPrimitive data-slot="button" className={buttonVariants({ variant, size, className })} {...props} />
  );
}

export { Button };
