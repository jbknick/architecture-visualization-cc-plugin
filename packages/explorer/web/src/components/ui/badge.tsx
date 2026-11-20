import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/utils";

/*
 * shadcn `badge` (base-nova style), copied from https://ui.shadcn.com/r/styles/base-nova/badge.json.
 * The class-variance-authority call is replaced with a plain lookup table (not an approved dependency).
 */
const base =
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all [&>svg]:pointer-events-none [&>svg]:size-3!";

const variants = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive/10 text-destructive",
  outline: "border-border text-foreground",
  ghost: "",
} as const;

export type BadgeVariant = keyof typeof variants;

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">({ className: cn(base, variants[variant], className) }, props),
    render,
    state: { slot: "badge", variant },
  });
}

export { Badge };
