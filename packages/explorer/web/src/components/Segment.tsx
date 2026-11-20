import type { ComponentProps } from "react";
import { Button } from "./ui/button.tsx";

/**
 * One choice of a segmented control: a kit Button with `role="radio"`, inside an element with `role="radiogroup"`.
 * The controls stay buttons (not Base UI radios) so they keep the ARIA radio roles the specs and tests address them by
 * and read as text, not as round radio marks.
 */
export function Segment({
  checked,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant"> & { checked: boolean }) {
  return (
    <Button
      role="radio"
      aria-checked={checked}
      variant={checked ? "default" : "outline"}
      size="sm"
      {...props}
    />
  );
}
