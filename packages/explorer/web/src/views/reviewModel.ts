// Pure helpers for the review view (#44, on the map since #167): words, the layer's colours, and the review layer
// resolved against a map scene (tree indices). No DOM, no randomness.
import type { ChangeKind, GraphNode, ReviewData, ReviewLayer, ReviewMarkKind } from "../api.ts";
import type { Rect } from "../canvas/types.ts";
import type { Scheme } from "../theme.ts";

export const CHANGE_WORDS: Record<ChangeKind, { label: string; hint: string }> = {
  added: { label: "Added", hint: "New in this change" },
  modified: { label: "Modified", hint: "Same name and place, different code" },
  removed: { label: "Removed", hint: "Gone after this change" },
  moved: { label: "Moved", hint: "The same code now lives in another file" },
  renamed: { label: "Renamed", hint: "The same code under a new name in the same file" },
};

/** The legend's order (strongest first, as the server merges kinds on a shared node). */
export const MARK_KINDS: readonly ReviewMarkKind[] = ["removed", "signature", "moved", "modified", "added"];

export const MARK_WORDS: Record<ReviewMarkKind, { label: string; hint: string }> = {
  added: { label: "Added", hint: "New in this change" },
  modified: { label: "Modified", hint: "Same name and place, different code" },
  signature: { label: "Signature changed", hint: "Modified, and its parameters or return type differ" },
  moved: { label: "Renamed or moved", hint: "The same code under a new name or in another file" },
  removed: {
    label: "Removed",
    hint: "Gone after this change: shown at its file when the file is still there, else only listed",
  },
};

/** Fill colours of the layer, per theme. Lines use the same hue (darkened or lightened for contrast). */
export const MARK_COLOURS: Record<Scheme, Record<ReviewMarkKind | "affected", string>> = {
  light: {
    added: "#1f8a4c",
    modified: "#c98a00",
    signature: "#c2255c",
    moved: "#2f6fd6",
    removed: "#c62828",
    affected: "#8b5cf6",
  },
  dark: {
    added: "#4cc483",
    modified: "#f0b43c",
    signature: "#f06595",
    moved: "#6fa2ff",
    removed: "#ff6b62",
    affected: "#a78bfa",
  },
};

export const CROSSING_WORDS: Record<string, string> = {
  app: "App uses a package",
  workspace: "Other workspace",
  client_server: "Client / server",
};

export const RISK_WORDS: Record<ReviewData["risk"]["level"], string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/** `sym:a/b.ts#name` -> `name`; `file:a/b.ts` -> `b.ts`. */
export function shortName(id: string): string {
  if (id.startsWith("sym:")) return id.slice(id.lastIndexOf("#") + 1);
  if (id.startsWith("file:")) return id.slice(id.lastIndexOf("/") + 1);
  return id;
}

/** The layer colour of one change (the server's rule: renamed and moved share one, a signature change has its own). */
export function markKindOf(c: { kind: ChangeKind; signatureChanged: boolean }): ReviewMarkKind {
  if (c.kind === "added" || c.kind === "removed") return c.kind;
  if (c.kind === "renamed" || c.kind === "moved") return "moved";
  return c.signatureChanged ? "signature" : "modified";
}

/** `far=true` in the filters: callers at hop 2 and 3 get a faint tint too. */
export const FAR_KEY = "far";

/** The minimal tree a layer is resolved against: the map scene's (2D) or the settlements' building ids (3D). */
export interface LayerTree {
  ids: readonly string[];
  /** Parent index of each node, -1 for a root. */
  parents: readonly number[];
}

/** A review layer resolved to tree indices, as the 2D map draws it. */
export interface LayerPaint {
  /** Change kind per index (only on the node the server marked). */
  change: (ReviewMarkKind | null)[];
  /** Nearest caller hop per index (0: none). Hops 2 and 3 only when `far` is on. */
  hop: Uint8Array;
  /** 1 for a node that is marked or holds a marked node (it keeps its colours); the rest fade back. */
  lit: Uint8Array;
  links: { src: number; dst: number; change: ReviewMarkKind; weight: number }[];
  /** Changed symbol or file id -> the index that shows it. */
  placed: Map<string, number>;
}

/**
 * Resolves `layer` against a tree: marks by index, every ancestor of a marked node lit, lines between indices.
 * Marks and lines whose node is not in the tree (a mosaic, a filter) are skipped. Deterministic.
 */
export function paintLayer(tree: LayerTree, layer: ReviewLayer, far: boolean): LayerPaint {
  const n = tree.ids.length;
  const index = new Map<string, number>();
  tree.ids.forEach((id, i) => {
    index.set(id, i);
  });
  const change: (ReviewMarkKind | null)[] = new Array(n).fill(null);
  const hop = new Uint8Array(n);
  const lit = new Uint8Array(n);
  const light = (i: number) => {
    for (let k = i; k !== -1 && !lit[k]; k = tree.parents[k] ?? -1) lit[k] = 1;
  };
  for (const m of layer.marks) {
    const i = index.get(m.id);
    if (i === undefined) continue;
    if (m.change) {
      change[i] = m.change;
      light(i);
    } else if (m.hop !== undefined && (m.hop === 1 || far)) {
      hop[i] = m.hop;
      light(i);
    }
  }
  const links: LayerPaint["links"] = [];
  for (const l of layer.links) {
    const src = index.get(l.src);
    const dst = index.get(l.dst);
    if (src === undefined || dst === undefined) continue;
    links.push({ src, dst, change: l.change, weight: l.weight });
  }
  const placed = new Map<string, number>();
  for (const [id, node] of layer.placed) {
    const i = index.get(node);
    if (i !== undefined) placed.set(id, i);
  }
  return { change, hop, lit, links, placed };
}

// ---- Rings mode ----------------------------------------------------------------------------------------------------

/** The plain-words title of a ring. */
export function ringTitle(hop: number): string {
  if (hop === 0) return "Changed in this range";
  if (hop === 1) return "Call the changed code directly";
  return `${hop} calls away`;
}

export const RINGS_CAPTION = "Centre: what changed. Each ring out: code that calls the ring inside it.";

/** Ring radii from the server's positions (one per hop that has nodes), with a count each. */
export function ringRadii(nodes: readonly GraphNode[]): { hop: number; r: number; count: number }[] {
  const by = new Map<number, { r: number; count: number }>();
  for (const n of nodes) {
    const h = n.hop ?? 0;
    const cur = by.get(h) ?? { r: 0, count: 0 };
    cur.r = Math.max(cur.r, Math.hypot(n.x ?? 0, n.y ?? 0));
    cur.count += 1;
    by.set(h, cur);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([hop, v]) => ({ hop, r: v.r, count: v.count }));
}

/** Bounding box of the ring layout, padded for labels. */
export function ringBounds(nodes: readonly GraphNode[], pad = 110): Rect {
  let r = 0;
  for (const n of nodes) r = Math.max(r, Math.hypot(n.x ?? 0, n.y ?? 0));
  const half = Math.max(r, 60) + pad;
  return { x: -half, y: -half, w: 2 * half, h: 2 * half };
}

/** Whether a ring's callers get text labels without hover: only when there is room. Changed nodes always do. */
export function labelRing(hop: number, count: number): boolean {
  return hop === 0 || count <= (hop === 1 ? 40 : 24);
}

/** Angle clockwise from the top, 0 to 2pi, as the server places slots. */
const clockAngle = (x: number, y: number): number => {
  const a = Math.atan2(y, x) + Math.PI / 2;
  return a < 0 ? a + 2 * Math.PI : a;
};

export interface RingGroup {
  hop: number;
  /** The file path shared by the group's nodes. */
  group: string;
  label: string;
  count: number;
  r: number;
  /** Clockwise from the top, in radians: the first and last node of the group. */
  a0: number;
  a1: number;
}

/** The file groups of every ring (the server puts a file's nodes side by side), in ring then angle order. */
export function ringGroups(nodes: readonly GraphNode[]): RingGroup[] {
  const by = new Map<string, RingGroup>();
  for (const n of nodes) {
    const hop = n.hop ?? 0;
    const r = Math.hypot(n.x ?? 0, n.y ?? 0);
    if (r === 0 || !n.group) continue;
    const a = clockAngle(n.x ?? 0, n.y ?? 0);
    const key = `${hop}\0${n.group}`;
    const g = by.get(key);
    if (g) {
      g.count += 1;
      g.a0 = Math.min(g.a0, a);
      g.a1 = Math.max(g.a1, a);
      g.r = Math.max(g.r, r);
    } else {
      by.set(key, {
        hop,
        group: n.group,
        label: n.group.slice(n.group.lastIndexOf("/") + 1),
        count: 1,
        r,
        a0: a,
        a1: a,
      });
    }
  }
  return [...by.values()].sort((a, b) => a.hop - b.hop || a.a0 - b.a0);
}

/**
 * The path of `id` through the rings: everything it calls on the way to the centre and everything that calls it on
 * the way out, with the edges between them. Edges point from caller to callee.
 */
export function ringPath(
  id: string,
  edges: readonly { id: string; src: string; dst: string }[],
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set([id]);
  const used = new Set<string>();
  const walk = (from: "src" | "dst", to: "src" | "dst") => {
    let frontier = [id];
    const seen = new Set([id]);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const e of edges) {
        if (!frontier.includes(e[from])) continue;
        used.add(e.id);
        nodes.add(e[to]);
        if (!seen.has(e[to])) {
          seen.add(e[to]);
          next.push(e[to]);
        }
      }
      frontier = next;
    }
  };
  walk("src", "dst"); // inward: what it calls
  walk("dst", "src"); // outward: who calls it
  return { nodes, edges: used };
}

/** The node id that shows `id` on this map: itself when it is drawn, else where the layer placed it. */
export function placedId(layer: ReviewLayer | null | undefined, id: string | null): string | null {
  if (!id || !layer) return id;
  for (const [from, to] of layer.placed) if (from === id) return to;
  return id;
}
