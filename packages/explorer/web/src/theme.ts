// Fixed kind colors, shared by the badges here and by the canvases later.
// Each pair is [light-theme, dark-theme]. The dot is decorative; the kind name is always printed next to it.

export const KINDS = [
  "function",
  "component",
  "hook",
  "class",
  "type",
  "file",
  "workspace",
  "route",
  "endpoint",
  "table",
  "middleware",
] as const;

export type KnownKind = (typeof KINDS)[number];

const PALETTE: Record<KnownKind, [light: string, dark: string]> = {
  function: ["#2f6fdb", "#6ea2ff"],
  component: ["#b43fd0", "#d98cf0"],
  hook: ["#0d8f7a", "#3fd0b4"],
  class: ["#c2570c", "#f59e5b"],
  type: ["#6b7280", "#a3acba"],
  file: ["#7a5c1e", "#d2b26a"],
  workspace: ["#1f7a3d", "#58cf84"],
  route: ["#c0306b", "#f27aa6"],
  endpoint: ["#a8261f", "#f08078"],
  table: ["#4f46c8", "#9d97f5"],
  middleware: ["#7c5e10", "#d9b95c"],
};

/**
 * Cross-stack edges (#48): database reads are blue and writes orange, in every view that draws them; the other
 * kinds use the neutral edge ink. Each pair is [light, dark] and keeps 3:1 against the canvas background.
 */
export const EDGE_KIND_COLORS: Record<string, [light: string, dark: string]> = {
  reads: ["#1d5fd6", "#64a4ff"],
  writes: ["#c2510c", "#fb9a4b"],
};

export function edgeKindColor(kind: string, scheme: Scheme): string | null {
  const pair = EDGE_KIND_COLORS[kind];
  return pair ? (scheme === "dark" ? pair[1] : pair[0]) : null;
}

const FALLBACK: [string, string] = ["#6b7280", "#a3acba"];

export type Scheme = "light" | "dark";

export function kindColor(kind: string, scheme: Scheme): string {
  const pair = (PALETTE as Record<string, [string, string] | undefined>)[kind] ?? FALLBACK;
  return scheme === "dark" ? pair[1] : pair[0];
}

export function currentScheme(): Scheme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Writes `--kind-<name>` CSS variables so stylesheets and canvases read the same colors. */
export function applyKindVariables(root: HTMLElement, scheme: Scheme): void {
  for (const kind of KINDS) root.style.setProperty(`--kind-${kind}`, kindColor(kind, scheme));
}
