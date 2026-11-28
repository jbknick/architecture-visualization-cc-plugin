// Small pieces shared by the Team layer's panel, rings and toggle.
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";

/** A decorative Hugeicons icon. */
export function Icon({ icon, size }: { icon: IconSvgElement; size: number }) {
  return <HugeiconsIcon icon={icon} size={size} aria-hidden="true" />;
}

/** The little colored square beside a count, one of the review's colors (`rv-mark-*`) or the reachable outline. */
export function Swatch({ tone }: { tone: "modified" | "affected" | "potential" | "reach" }) {
  return (
    <span
      className={tone === "reach" ? "rv-swatch team-swatch-reach" : `rv-swatch rv-mark-${tone}`}
      aria-hidden="true"
    />
  );
}

/** The letter a person is shown by. */
export const initialOf = (name: string): string => (name[0] ?? "?").toUpperCase();
