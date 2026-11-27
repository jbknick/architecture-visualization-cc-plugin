// A distinct, stable colour for each person of the Team layer, from the explorer's workspace palette, so the
// initials in the filter, the list rows and the map markers agree. A person's colour is their place in the sorted
// list of everyone in the team data, so it does not change when a filter narrows the list.
import { contrastRatio, mix } from "../canvas/style.ts";
import type { Scheme } from "../theme.ts";
import { workspaceColorAt } from "../workspacePalette.ts";

/** The explorer's surface and text colours (styles.css), for the tinted chip and its letter. */
const SURFACE: Record<Scheme, string> = { light: "#ffffff", dark: "#171b22" };
const TEXT: Record<Scheme, string> = { light: "#1a1d23", dark: "#e8ebf1" };
/** WCAG AA for the letter on its chip. */
export const INITIAL_MIN_CONTRAST = 4.5;

/** The palette colour of `person`: their position among `people` (sorted, unique), wrapping past the palette. */
export function personColour(people: readonly string[], person: string, scheme: Scheme): string {
  const at = people.indexOf(person);
  return workspaceColorAt(Math.max(at, 0), scheme);
}

/** The chip behind a person's initial and the letter on it; the letter is pulled toward the text colour until it reads. */
export function initialColours(base: string, scheme: Scheme): { bg: string; ink: string } {
  const bg = mix(base, SURFACE[scheme], 0.24);
  let ink = base;
  for (let t = 0; t <= 1.0001 && contrastRatio(ink, bg) < INITIAL_MIN_CONTRAST; t += 0.05)
    ink = mix(TEXT[scheme], base, t);
  return { bg, ink };
}

/** The four custom properties `.team-chip` reads, so the chip follows the OS theme without a re-render. */
export function initialStyle(people: readonly string[], person: string): Record<string, string> {
  const light = initialColours(personColour(people, person, "light"), "light");
  const dark = initialColours(personColour(people, person, "dark"), "dark");
  return { "--p-bg": light.bg, "--p-ink": light.ink, "--p-bg-dark": dark.bg, "--p-ink-dark": dark.ink };
}
