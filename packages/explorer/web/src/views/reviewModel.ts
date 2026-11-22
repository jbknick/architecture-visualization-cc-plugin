// Pure helpers for the review view (#44, on the map since #167): words, the layer's colours, and the review layer
// resolved against a map scene (tree indices). No DOM, no randomness.
import type {
  ChangeKind,
  GraphEdge,
  GraphNode,
  ReviewConsumer,
  ReviewConsumers,
  ReviewData,
  ReviewLayer,
  ReviewMarkKind,
  UseKind,
} from "../api.ts";
import type { Rect } from "../canvas/types.ts";
import { isFileId, nameOfSymId, pathOfFileId } from "../ids.ts";
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
  const name = nameOfSymId(id);
  if (name !== undefined) return name;
  if (isFileId(id)) {
    const p = pathOfFileId(id);
    return p.slice(p.lastIndexOf("/") + 1);
  }
  return id;
}

/** The layer colour of one change (the server's rule: renamed and moved share one, a signature change has its own). */
export function markKindOf(c: { kind: ChangeKind; signatureChanged: boolean }): ReviewMarkKind {
  if (c.kind === "added" || c.kind === "removed") return c.kind;
  if (c.kind === "renamed" || c.kind === "moved") return "moved";
  return c.signatureChanged ? "signature" : "modified";
}

/** The "Show" filter (#173): how much of the affected chain the map draws. */
export type ReviewShow = "changed" | "direct" | "potential";
/** `show=changed|direct` in the filters; absent means `potential` (the whole chain). */
export const SHOW_KEY = "show";
export const SHOW_CHOICES: readonly { id: ReviewShow; label: string; hint: string }[] = [
  { id: "changed", label: "Changed only", hint: "Only the changed code, no consumers and no lines" },
  {
    id: "direct",
    label: "+ Directly affected",
    hint: "Also the code that uses the changed code itself (hop 1): clear tint, solid lines",
  },
  {
    id: "potential",
    label: "+ Potentially affected",
    hint: "Also the code that uses those (hops 2 and 3): softer tint, dashed lines to the step nearer the change",
  },
];

/** The Show filter of a route's filters (default: the whole chain). */
export function showOf(filters: Readonly<Record<string, string | undefined>>): ReviewShow {
  const v = filters[SHOW_KEY];
  return v === "changed" || v === "direct" ? v : "potential";
}

/** The panel's totals: distinct consumers at hop 1, and at hops 2 and 3 (each counted at its nearest hop). */
export function affectedTotals(review: ReviewData | null | undefined): { direct: number; potential: number } {
  let direct = 0;
  let potential = 0;
  for (const h of review?.callersByHop ?? []) {
    if (h.hop === 1) direct += h.count;
    else potential += h.count;
  }
  return { direct, potential };
}

/** How a node relates to the change, in words: "directly affected (hop 1)" or "potentially affected (hop 2)". */
export function hopWords(hop: number): string {
  return hop <= 1 ? "directly affected (hop 1)" : `potentially affected (hop ${hop})`;
}

/**
 * The path from node `i` to the change, following the painted lines (a direct line first, else the dashed line to
 * the node one step nearer), at most four steps. Returns the indices, `i` first; just `[i]` when no line leaves it.
 */
export function pathToChange(paint: Pick<LayerPaint, "change" | "links">, i: number): number[] {
  const out = [i];
  const seen = new Set([i]);
  let k = i;
  for (let step = 0; step < 4 && !paint.change[k]; step++) {
    const from = paint.links.filter((l) => l.src === k && !seen.has(l.dst));
    const next = from.find((l) => !l.soft) ?? from[0];
    if (!next) break;
    k = next.dst;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * At most `max` painted lines, direct ones kept first (a dashed line never pushes out a solid one), in drawing order:
 * soft before direct.
 */
export function capPaintLinks<T extends { soft?: boolean }>(links: readonly T[], max: number): T[] {
  const direct = links.filter((l) => !l.soft).slice(0, max);
  const soft = links.filter((l) => l.soft).slice(0, Math.max(0, max - direct.length));
  return [...soft, ...direct];
}

/** Tooltip lines of a review node: its change, or its hop and the path to the change (names from `nameOf`). */
export function reviewTipLines(
  paint: LayerPaint | null | undefined,
  i: number,
  nameOf: (i: number) => string,
): string[] {
  if (!paint) return [];
  const ch = paint.change[i];
  if (ch) return [`Review: ${MARK_WORDS[ch].label.toLowerCase()}`];
  const hop = paint.hop[i] ?? 0;
  if (hop === 0) return [];
  const path = pathToChange(paint, i);
  return [
    `Review: ${hopWords(hop)}`,
    ...(path.length > 1 ? [`Path to the change: ${path.map(nameOf).join(" → ")}`] : []),
  ];
}

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
  /** Nearest caller hop per index (0: none), as far as the Show filter reaches. */
  hop: Uint8Array;
  /** 1 for a node that is marked or holds a marked node (it keeps its colours); the rest fade back. */
  lit: Uint8Array;
  /**
   * `soft`: a potentially affected consumer's line (to the node one step nearer the change), drawn faint and dashed.
   * Soft lines come first so they are drawn under the direct ones.
   */
  links: { src: number; dst: number; change: ReviewMarkKind; weight: number; soft?: boolean }[];
  /** Changed symbol, file or consumer id -> the index that shows it. */
  placed: Map<string, number>;
}

// ---- Consumers (#169) ---------------------------------------------------------------------------------------------

export const DIRECT_HEADING = "Directly affected";
export const POTENTIAL_HEADING = "Potentially affected";
export const REACHABLE_HEADING = "Reachable";

export const USE_WORDS: Record<UseKind, string> = {
  calls: "calls",
  renders: "renders",
  uses_hook: "uses the hook",
  extends: "extends",
  implements: "implements",
  references_type: "uses the type",
  imports: "imports",
  serves: "serves (route)",
  handles: "handles",
  requests: "requests",
};

/** The consumers of every change and changed file (file id) of a review, by id. */
export function consumersById(review: ReviewData | null | undefined): Map<string, ReviewConsumers> {
  const out = new Map<string, ReviewConsumers>();
  if (!review) return out;
  for (const c of review.changes) if (c.consumers) out.set(c.id, c.consumers);
  for (const f of review.files) if (f.consumers) out.set(f.id, f.consumers);
  return out;
}

/**
 * The change whose consumers are shown: the selection when it is a change or a changed file, else the change kept
 * in focus (`stored`) while the selection is one of its consumers. Null otherwise.
 */
export function focusedChange(
  review: ReviewData | null | undefined,
  sel: string | null,
  stored: string | null,
): string | null {
  if (!review || !sel) return null;
  const by = consumersById(review);
  if (by.has(sel)) return sel;
  const c = stored ? by.get(stored) : undefined;
  if (
    c &&
    [...c.direct, ...c.potential, ...c.reachable, ...c.hubs.flatMap((h) => h.members)].some(
      (x) => x.id === sel,
    )
  )
    return stored;
  return null;
}

/** Consumers grouped by file, in the order they come (the server sorts by workspace, then path, then name). */
export function groupByFile(list: readonly ReviewConsumer[]): { path: string; items: ReviewConsumer[] }[] {
  const out: { path: string; items: ReviewConsumer[] }[] = [];
  for (const x of list) {
    const last = out[out.length - 1];
    if (last && last.path === x.path) last.items.push(x);
    else out.push({ path: x.path, items: [x] });
  }
  return out;
}

/** A focused change as node ids of the map: its node, its direct consumers' and its potential ones' (with `next`). */
export interface LayerFocus {
  node: string | null;
  kind: ReviewMarkKind | null;
  direct: string[];
  potential: { node: string; next: string | null }[];
}

/** The focus of change `id` on the map of `review` (null when the id is not a change or changed file). */
export function layerFocus(review: ReviewData | null | undefined, id: string | null): LayerFocus | null {
  if (!review || !id) return null;
  const c = consumersById(review).get(id);
  if (!c) return null;
  const node = placedId(review.layer, id);
  const ch = review.changes.find((x) => x.id === id);
  const kind = ch
    ? markKindOf(ch)
    : (review.layer.marks.find((m) => m.id === node)?.change ?? ("modified" as ReviewMarkKind));
  return {
    node,
    kind,
    direct: c.direct.flatMap((x) => (x.node ? [x.node] : [])),
    potential: c.potential.flatMap((x) => (x.node ? [{ node: x.node, next: x.nextNode ?? null }] : [])),
  };
}

/**
 * Resolves `layer` against a tree: marks by index, every ancestor of a marked node lit, lines between indices.
 * Marks and lines whose node is not in the tree (a mosaic, a filter) are skipped. `show` sets how far the chain
 * goes: the changed code only, plus its direct consumers (hop 1: clear tint, solid lines), or plus the potential
 * ones too (hops 2-3: soft tint, dashed lines to the node one step nearer). With `focus` (a selected change), only
 * that change and its own consumers stay lit; the rest fade. Soft lines come before direct ones. Deterministic.
 */
export function paintLayer(
  tree: LayerTree,
  layer: ReviewLayer,
  show: ReviewShow = "potential",
  focus: LayerFocus | null = null,
): LayerPaint {
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
  const placed = new Map<string, number>();
  for (const [id, node] of layer.placed) {
    const i = index.get(node);
    if (i !== undefined) placed.set(id, i);
  }
  const reach = show === "changed" ? 0 : show === "direct" ? 1 : 3;
  if (focus) return paintFocus(tree, index, focus, reach, { change, hop, lit, light, placed });
  for (const m of layer.marks) {
    const i = index.get(m.id);
    if (i === undefined) continue;
    if (m.change) {
      change[i] = m.change;
      light(i);
    } else if (m.hop !== undefined && m.hop <= reach) {
      hop[i] = m.hop;
      light(i);
    }
  }
  const direct: LayerPaint["links"] = [];
  const soft: LayerPaint["links"] = [];
  for (const l of layer.links) {
    const src = index.get(l.src);
    const dst = index.get(l.dst);
    if (src === undefined || dst === undefined) continue;
    const potential = l.tier === "potential";
    if ((potential ? 2 : 1) > reach) continue;
    if (potential) soft.push({ src, dst, change: l.change, weight: l.weight, soft: true });
    else direct.push({ src, dst, change: l.change, weight: l.weight });
  }
  return { change, hop, lit, links: [...soft, ...direct], placed };
}

/** `paintLayer` for one focused change: its node, its consumers' tints and lines (direct strong, potential soft). */
function paintFocus(
  tree: LayerTree,
  index: Map<string, number>,
  focus: LayerFocus,
  reach: number,
  out: Omit<LayerPaint, "links"> & { light: (i: number) => void },
): LayerPaint {
  const { change, hop, lit, light, placed } = out;
  const contains = (a: number, b: number): boolean => {
    for (let k = tree.parents[b] ?? -1; k !== -1; k = tree.parents[k] ?? -1) if (k === a) return true;
    return false;
  };
  const kind = focus.kind ?? "modified";
  const dst = focus.node !== null ? index.get(focus.node) : undefined;
  if (dst !== undefined) {
    change[dst] = kind;
    light(dst);
  }
  const links = new Map<string, LayerPaint["links"][number]>();
  const link = (a: number | undefined, b: number | undefined, soft: boolean) => {
    if (a === undefined || b === undefined || a === b || contains(a, b) || contains(b, a)) return;
    const key = `${a}>${b}`;
    const l = links.get(key);
    if (l) {
      l.weight += 1;
      if (!soft) delete l.soft;
    } else links.set(key, { src: a, dst: b, change: kind, weight: 1, ...(soft ? { soft: true } : {}) });
  };
  for (const id of reach >= 1 ? focus.direct : []) {
    const i = index.get(id);
    if (i === undefined) continue;
    if (i !== dst && !change[i]) hop[i] = 1;
    light(i);
    link(i, dst, false);
  }
  for (const p of reach >= 2 ? focus.potential : []) {
    const i = index.get(p.node);
    if (i === undefined) continue;
    if (i !== dst && !change[i] && hop[i] !== 1) hop[i] = 2;
    light(i);
    link(i, p.next !== null ? index.get(p.next) : undefined, true);
  }
  // Soft lines first, so the direct ones are drawn over them.
  const sorted = [...links.values()].sort(
    (a, b) => Number(!a.soft) - Number(!b.soft) || a.src - b.src || a.dst - b.dst,
  );
  return { change, hop, lit, links: sorted, placed };
}

/**
 * Rings mode, a focused change: its direct consumers (strong) and potential ones (soft), and the ring edges between
 * them (direct consumer -> change strong, potential -> its `next` soft). Ids are ring node ids.
 */
export function ringFocus(
  review: ReviewData | null | undefined,
  id: string | null,
  edges: readonly { id: string; src: string; dst: string }[],
): {
  centre: string;
  direct: Set<string>;
  potential: Set<string>;
  strong: Set<string>;
  soft: Set<string>;
} | null {
  const c = id ? consumersById(review).get(id) : undefined;
  if (!c || !id) return null;
  const centre = placedId(review?.layer, id) ?? id;
  const direct = new Set(c.direct.flatMap((x) => (x.node ? [x.node] : [])));
  // Reachable consumers and hub nodes take the potential ones' soft tint.
  const softer = [...c.potential, ...c.reachable];
  const potential = new Set([
    ...softer.flatMap((x) => (x.node && !direct.has(x.node) && x.node !== centre ? [x.node] : [])),
    ...reachableHubs(c.hubs).flatMap((h) => (h.node ? [hubNodeId(h.hub)] : [])),
  ]);
  const pairs = new Map<string, "strong" | "soft">();
  for (const d of direct) pairs.set(`${d}->${centre}`, "strong");
  for (const h of reachableHubs(c.hubs)) if (h.node) pairs.set(`${hubNodeId(h.hub)}->${h.node}`, "soft");
  for (const p of softer) {
    if (p.node && p.nextNode && !pairs.has(`${p.node}->${p.nextNode}`))
      pairs.set(`${p.node}->${p.nextNode}`, "soft");
  }
  const strong = new Set<string>();
  const soft = new Set<string>();
  for (const e of edges) {
    const t = pairs.get(`${e.src}->${e.dst}`);
    if (t === "strong") strong.add(e.id);
    else if (t === "soft") soft.add(e.id);
  }
  return { centre, direct, potential, strong, soft };
}

// ---- Rings mode ----------------------------------------------------------------------------------------------------

/** The plain-words title of a ring. */
export function ringTitle(hop: number): string {
  if (hop === 0) return "Changed in this range";
  if (hop === 1) return "Call the changed code directly";
  if (hop >= REACHABLE_RING) return `${REACHABLE_RING} or more calls away`;
  return `${hop} calls away`;
}

/** The outer ring: every consumer at this hop or farther, and the hubs. The server's `REACHABLE_RING`. */
export const REACHABLE_RING = 4;
/** The hubs of the reachable tier; one of hop 2 or 3 belongs to the potential tier and has no node on the outer ring. */
export const reachableHubs = <H extends { hop: number }>(hubs: readonly H[]): H[] =>
  hubs.filter((h) => h.hop >= REACHABLE_RING);
/** The id of the node that stands for a hub on the outer ring. */
export const hubNodeId = (hub: string): string => `hub:${hub}`;

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * The outer ring with the members of the `expanded` hubs (hub node ids) drawn beside their hubs, grouped by file like
 * every ring, plus a dashed edge from each member to the node one step nearer. The slots, spacing and radius follow
 * the server's `ringLayout`; nothing changes while no hub is expanded.
 */
export function withHubMembers(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  review: ReviewData | null | undefined,
  expanded: ReadonlySet<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (expanded.size === 0 || !review) return { nodes: [...nodes], edges: [...edges] };
  const have = new Set(nodes.map((n) => n.id));
  const added: GraphNode[] = [];
  const extra = new Map<string, GraphEdge>();
  for (const cc of [...review.changes, ...review.files]) {
    for (const h of reachableHubs(cc.consumers.hubs)) {
      const hubNode = hubNodeId(h.hub);
      if (!expanded.has(hubNode)) continue;
      for (const m of h.members) {
        const dst = m.nextNode ?? hubNode;
        const id = `${m.id}->${dst}`;
        if (!extra.has(id) && m.id !== dst)
          extra.set(id, { id, src: m.id, dst, kind: m.uses[0] ?? "calls", weight: 1, confidence: "low" });
        if (have.has(m.id)) continue;
        have.add(m.id);
        added.push({
          id: m.id,
          kind: m.kind,
          label: m.name,
          path: m.path,
          group: m.path,
          size: 1,
          hop: REACHABLE_RING,
        });
      }
    }
  }
  const ring = [...nodes.filter((n) => (n.hop ?? 0) === REACHABLE_RING), ...added]
    .map((n) => ({ n, group: n.group ?? "" }))
    .sort((a, b) => cmpStr(a.group, b.group) || cmpStr(a.n.id, b.n.id));
  const at = new Map<string, number>();
  let slot = 0;
  let last: string | undefined;
  for (const it of ring) {
    if (last !== undefined && it.group !== last) slot += 1;
    at.set(it.n.id, slot);
    slot += 1;
    last = it.group;
  }
  const slots = slot + (new Set(ring.map((x) => x.group)).size > 1 ? 1 : 0);
  const inner = Math.max(
    0,
    ...nodes.filter((n) => (n.hop ?? 0) < REACHABLE_RING).map((n) => Math.hypot(n.x ?? 0, n.y ?? 0)),
  );
  const r = round1(Math.max(inner + 150, (slots * 30) / (2 * Math.PI)));
  const placed = new Map<string, GraphNode>();
  for (const { n } of ring) {
    const a = -Math.PI / 2 + (2 * Math.PI * ((at.get(n.id) ?? 0) + 0.5)) / Math.max(1, slots);
    placed.set(n.id, { ...n, x: round1(r * Math.cos(a)), y: round1(r * Math.sin(a)) });
  }
  const all = [
    ...nodes.map((n) => placed.get(n.id) ?? n),
    ...added.map((n) => placed.get(n.id) as GraphNode),
  ];
  all.sort((a, b) => (a.hop ?? 0) - (b.hop ?? 0) || cmpStr(a.id, b.id));
  const out = [...edges];
  const ids = new Set(edges.map((e) => e.id));
  for (const e of extra.values()) if (!ids.has(e.id) && have.has(e.dst)) out.push(e);
  return { nodes: all, edges: out };
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

/**
 * Whether a ring's callers get text labels without hover: only when there is room (the same room on every ring, so
 * the outer rings read like the first, #173). Changed nodes always do.
 */
export function labelRing(hop: number, count: number): boolean {
  return hop === 0 || count <= 40;
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
