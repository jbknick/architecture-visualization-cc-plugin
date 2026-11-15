// Pure helpers for the review view (#44): words, ring bounds and the overlay treemap. No DOM, no randomness.
import type { ChangeKind, GraphNode, ReviewData } from "../api.ts";
import { squarify } from "../canvas/treemap.ts";
import type { Rect } from "../canvas/types.ts";

export const CHANGE_KINDS: readonly ChangeKind[] = ["added", "modified", "removed", "moved", "renamed"];

export const CHANGE_WORDS: Record<ChangeKind, { label: string; hint: string }> = {
  added: { label: "Added", hint: "New in this change" },
  modified: { label: "Modified", hint: "Same name and place, different code" },
  removed: { label: "Removed", hint: "Gone after this change" },
  moved: { label: "Moved", hint: "The same code now lives in another file" },
  renamed: { label: "Renamed", hint: "The same code under a new name in the same file" },
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

export const hopTitle = (hop: number): string => (hop === 0 ? "Changed" : `Hop ${hop} callers`);

/** `sym:a/b.ts#name` -> `name`; `file:a/b.ts` -> `b.ts`. */
export function shortName(id: string): string {
  if (id.startsWith("sym:")) return id.slice(id.lastIndexOf("#") + 1);
  if (id.startsWith("file:")) return id.slice(id.lastIndexOf("/") + 1);
  return id;
}

/** Bounding box of the ring layout (server positions), padded for labels. */
export function ringBounds(nodes: readonly GraphNode[], pad = 90): Rect {
  let r = 0;
  for (const n of nodes) r = Math.max(r, Math.hypot(n.x ?? 0, n.y ?? 0));
  const half = Math.max(r, 60) + pad;
  return { x: -half, y: -half, w: 2 * half, h: 2 * half };
}

/** Ring radii, from the nodes' positions (one radius per hop that has nodes). */
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

/** Whether a ring's nodes get text labels: only when there is room (a hovered or selected node is always labelled). */
export function labelRing(hop: number, count: number): boolean {
  return count <= (hop === 0 ? 30 : hop === 1 ? 40 : 24);
}

export interface OverlayBox {
  id: string;
  label: string;
  rect: Rect;
  files: { node: GraphNode; rect: Rect }[];
  changed: number;
  affected: number;
}

export const OVERLAY_SIZE = { w: 1200, h: 760 } as const;
const OVERLAY_GAP = 6;
const OVERLAY_HEAD = 24;
export const OUTSIDE_ID = "outside";

/**
 * The overlay's workspace boxes and file tiles: workspaces squarified by function count, files squarified inside
 * each box under a header strip. Files outside every workspace share one box. Deterministic (squarify sorts by
 * weight, then id).
 */
export function layoutOverlay(nodes: readonly GraphNode[], size = OVERLAY_SIZE): OverlayBox[] {
  const ws = new Map<string, GraphNode>();
  const filesBy = new Map<string, GraphNode[]>();
  for (const n of nodes) if (n.kind === "workspace") ws.set(n.id, n);
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const key = n.parent && ws.has(n.parent) ? n.parent : OUTSIDE_ID;
    const list = filesBy.get(key) ?? [];
    list.push(n);
    filesBy.set(key, list);
  }
  const weightOf = (files: GraphNode[]) => files.reduce((s, f) => s + Math.max(1, f.size), 0);
  const items = [...filesBy.entries()].map(([id, files]) => ({ id, weight: weightOf(files) }));
  const placed = squarify(items, { x: 0, y: 0, w: size.w, h: size.h }, 1.4);
  const out: OverlayBox[] = [];
  for (const p of placed) {
    const files = filesBy.get(p.id) ?? [];
    const outer: Rect = {
      x: p.rect.x + OVERLAY_GAP / 2,
      y: p.rect.y + OVERLAY_GAP / 2,
      w: Math.max(0, p.rect.w - OVERLAY_GAP),
      h: Math.max(0, p.rect.h - OVERLAY_GAP),
    };
    const head = Math.min(OVERLAY_HEAD, outer.h / 3);
    const inner: Rect = {
      x: outer.x + 2,
      y: outer.y + head,
      w: Math.max(0, outer.w - 4),
      h: Math.max(0, outer.h - head - 2),
    };
    const byId = new Map(files.map((f) => [f.id, f]));
    const tiles = squarify(
      files.map((f) => ({ id: f.id, weight: Math.max(1, f.size) })),
      inner,
    ).map((t) => ({ node: byId.get(t.id) as GraphNode, rect: t.rect }));
    const w = ws.get(p.id);
    out.push({
      id: p.id,
      label: w ? (w.shortLabel ?? w.label) : "Outside workspaces",
      rect: outer,
      files: tiles,
      changed: files.filter((f) => f.mark === "changed").length,
      affected: files.filter((f) => f.mark === "affected").length,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
