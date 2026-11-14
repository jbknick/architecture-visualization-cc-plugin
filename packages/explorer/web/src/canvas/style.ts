import { currentScheme, kindColor, type Scheme } from "../theme.ts";
import { workspaceColorAt } from "../workspacePalette.ts";

// One stable colour per workspace: the shell's shared palette (../workspacePalette.ts) indexed by the
// workspace's position in the sorted id list, so the same workspace is the same colour in 2D, 3D and the panels.
// The palette colours are fills and borders; label text uses `labelInk`, a darkened (light theme) or lightened
// (dark theme) version that keeps 4.5:1 contrast on the region background.

/** Number of distinct colours before the palette wraps. */
export const WORKSPACE_PALETTE_SIZE = 12;

/** Colour for the n-th workspace in sorted-id order. */
export function workspaceColor(rank: number, scheme: Scheme): string {
  return workspaceColorAt(rank, scheme);
}

/** Text colour for a label sitting on a region tinted with `colour`. */
export function labelInk(colour: string, scheme: Scheme): string {
  return scheme === "light" ? mix(colour, "#000000", 0.5) : mix(colour, "#ffffff", 0.6);
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** WCAG contrast ratio of two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `colour` moved toward black (light theme) or white (dark theme) in small steps, only as far as it takes to reach
 * `min` contrast against `bg`. A colour that already has the contrast is returned as it is, so the hue survives.
 */
export function inkAgainst(colour: string, bg: string, scheme: Scheme, min: number): string {
  const toward = scheme === "light" ? "#000000" : "#ffffff";
  for (let k = 0; k <= 20; k++) {
    const c = k === 0 ? colour : mix(toward, colour, k / 20);
    if (contrastRatio(c, bg) >= min) return c;
  }
  return toward;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Mixes `hex` with `base` (both #rrggbb) at `amount` of `hex`. */
export function mix(hex: string, base: string, amount: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(base.slice(1), 16);
  const ch = (shift: number) =>
    Math.round(((a >> shift) & 255) * amount + ((b >> shift) & 255) * (1 - amount))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

export interface CanvasTheme {
  scheme: Scheme;
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
}

const FALLBACK: Record<Scheme, CanvasTheme> = {
  light: {
    scheme: "light",
    bg: "#f3f4f7",
    surface: "#ffffff",
    text: "#1a1d23",
    muted: "#566070",
    border: "#d5d9e1",
    accent: "#2159d6",
  },
  dark: {
    scheme: "dark",
    bg: "#0f1217",
    surface: "#171b22",
    text: "#e8ebf1",
    muted: "#9aa4b4",
    border: "#2b323d",
    accent: "#7ba6ff",
  },
};

function expandHex(value: string, fallback: string): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  return fallback;
}

/** Reads the shell's CSS variables so the canvas matches the current light/dark theme. */
export function readTheme(el: Element | null): CanvasTheme {
  const scheme = currentScheme();
  const base = FALLBACK[scheme];
  if (!el || typeof getComputedStyle === "undefined") return base;
  const cs = getComputedStyle(el);
  const get = (name: string, fb: string) => expandHex(cs.getPropertyValue(name), fb);
  return {
    scheme,
    bg: get("--bg", base.bg),
    surface: get("--surface", base.surface),
    text: get("--text", base.text),
    muted: get("--muted", base.muted),
    border: get("--border", base.border),
    accent: get("--accent", base.accent),
  };
}

export { kindColor };
