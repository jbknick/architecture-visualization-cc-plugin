// SmoothUI (https://smoothui.dev). MIT License. Copyright (c) 2024 Eduardo Calvo.
// Copied from the SmoothUI registry on 2026-11-20 with `shadcn add @smoothui/breadcrumb`; see SOURCES.md.
// Changes: the chevron is a Hugeicons icon, and an item may set the aria-current token of the last item.
"use client";

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { SPRING_DEFAULT } from "@/components/smoothui/lib/animation";
import { cn } from "@/lib/utils";

/** A single breadcrumb item definition. */
export type BreadcrumbItemProps = {
  /** Display label for the breadcrumb item. */
  label: ReactNode;
  /** URL the breadcrumb links to. Omit for the current (last) page. */
  href?: string;
  /** Explorer change: the `aria-current` token of the last item. Defaults to "page"; the explorer uses "location". */
  current?: "page" | "location";
};

export type BreadcrumbProps = {
  /** Ordered list of breadcrumb items. The last item is treated as the current page. */
  items: BreadcrumbItemProps[];
  /** Custom separator element. Defaults to a chevron icon. */
  separator?: ReactNode;
  /** Additional CSS classes for the nav element. */
  className?: string;
};

const staggerDelay = 0.04;

export default function Breadcrumb({ items, separator, className }: BreadcrumbProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <nav aria-label="Breadcrumb" className={cn("inline-flex", className)}>
      <ol className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-sm sm:gap-2.5">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;

          return (
            <motion.li
              animate={{ opacity: 1, transform: "translateX(0px)" }}
              className="inline-flex items-center gap-1.5"
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, transform: "translateX(-4px)" }}
              key={typeof item.label === "string" ? item.label : `breadcrumb-${String(index)}`}
              transition={
                shouldReduceMotion
                  ? { duration: 0 }
                  : {
                      ...SPRING_DEFAULT,
                      delay: index * staggerDelay,
                    }
              }
            >
              {index > 0 && (
                <span aria-hidden="true" className="mr-1.5 [&>svg]:size-3.5" role="presentation">
                  {separator ?? <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" />}
                </span>
              )}
              {isLast ? (
                <span aria-current={item.current ?? "page"} className="font-normal text-foreground">
                  {item.label}
                </span>
              ) : item.href ? (
                <a className="transition-colors hover:text-foreground" href={item.href}>
                  {item.label}
                </a>
              ) : (
                <span className="text-muted-foreground">{item.label}</span>
              )}
            </motion.li>
          );
        })}
      </ol>
    </nav>
  );
}
