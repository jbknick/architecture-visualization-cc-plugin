import type { Store } from "../store/index.js";
import { ANCHOR_KINDS, syncAnchors, usedSymIds } from "./anchors.js";
import { readOverlay } from "./repo.js";
import { FilterSpecSchema, GroupSchema, type Selector, SelectorSchema } from "./types.js";

/** An id-keyed entry whose function is not in the effective graph (spec section 11, "Re-attaching hand-picked entries"). */
export interface UnresolvedEntry {
  entry: "label" | "hidden" | "group" | "view";
  id: string;
  /** Set for `group`. */
  groupId?: string;
  /** Set for `view`. */
  viewId?: string;
  /** Set for `label`. */
  text?: string;
  /** `gone`: no symbol has the anchored hash. `ambiguous`: several do, or the only one is already in the same entry. */
  reason: "gone" | "ambiguous";
}

export interface ReattachResult {
  reattached: { from: string; to: string }[];
  unresolved: UnresolvedEntry[];
}

/** Effective function-like symbol ids by `exactHash`. */
function idsByHash(store: Store): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const s of store.effectiveSymbols({ kind: [...ANCHOR_KINDS] })) {
    const list = m.get(s.exactHash);
    if (list) list.push(s.id);
    else m.set(s.exactHash, [s.id]);
  }
  return m;
}

function readAnchors(store: Store): Map<string, string> {
  const rows = store.db.prepare("SELECT node_id, exact_hash FROM overlay.anchors").all() as {
    node_id: string;
    exact_hash: string;
  }[];
  return new Map(rows.map((r) => [r.node_id, r.exact_hash]));
}

/** `ids` selectors with `from` replaced by `to`; undefined when nothing changes (no `from`, or `to` is already in that selector). */
function renameInSelectors(selectors: Selector[], from: string, to: string): Selector[] | undefined {
  let changed = false;
  const next = selectors.map((s): Selector => {
    if (s.type !== "ids" || !s.ids.includes(from) || s.ids.includes(to)) return s;
    changed = true;
    return SelectorSchema.parse({ type: "ids", ids: s.ids.map((i) => (i === from ? to : i)) });
  });
  return changed ? next : undefined;
}

/**
 * Re-attaches id-keyed overlay entries whose symbol is gone (spec section 11). For every anchored id that is not in the
 * effective graph, the effective function-like symbols with the anchored `exactHash` are looked up; exactly one, whose id
 * the same entry does not already hold, becomes the entry's new id everywhere the old id occurs (label row, selector
 * JSON, anchor row) in one transaction. Zero or several leave the entry as it is. Writes only when an id changes, so an
 * index with no moved symbol leaves `overlay.db` byte-identical. Never called from a Claude Code hook.
 */
export function reattachOverlay(store: Store): ReattachResult {
  const anchors = readAnchors(store);
  const missing = [...anchors.keys()].filter((id) => store.getSymbol(id) === undefined).sort();
  const reattached: { from: string; to: string }[] = [];
  if (missing.length > 0) {
    const byHash = idsByHash(store);
    const plan: { from: string; to: string }[] = [];
    for (const from of missing) {
      const found = byHash.get(anchors.get(from) as string) ?? [];
      if (found.length === 1) plan.push({ from, to: found[0] as string });
    }
    if (plan.length > 0) {
      store.tx(() => {
        for (const { from, to } of plan) if (renameEverywhere(store, from, to)) reattached.push({ from, to });
        if (reattached.length > 0) syncAnchors(store, readOverlay(store));
      });
    }
  }
  return { reattached, unresolved: listUnresolved(store) };
}

/** Rewrites `from` to `to` in every entry that does not already hold `to`. True when something changed. */
function renameEverywhere(store: Store, from: string, to: string): boolean {
  const db = store.db;
  let changed = false;
  const hasLabel = (id: string) =>
    db.prepare("SELECT 1 FROM overlay.labels WHERE node_id = ?").get(id) !== undefined;
  if (hasLabel(from) && !hasLabel(to)) {
    db.prepare("UPDATE overlay.labels SET node_id = ? WHERE node_id = ?").run(to, from);
    changed = true;
  }
  const hidden = db.prepare("SELECT position, selector FROM overlay.hidden").all() as {
    position: number;
    selector: string;
  }[];
  for (const r of hidden) {
    const next = renameInSelectors([SelectorSchema.parse(JSON.parse(r.selector))], from, to);
    if (!next) continue;
    db.prepare("UPDATE overlay.hidden SET selector = ? WHERE position = ?").run(
      JSON.stringify(next[0]),
      r.position,
    );
    changed = true;
  }
  const groups = db.prepare("SELECT id, selectors FROM overlay.groups").all() as {
    id: string;
    selectors: string;
  }[];
  for (const r of groups) {
    const list = GroupSchema.shape.selectors.parse(JSON.parse(r.selectors));
    const next = renameInSelectors(list, from, to);
    if (!next) continue;
    db.prepare("UPDATE overlay.groups SET selectors = ? WHERE id = ?").run(JSON.stringify(next), r.id);
    changed = true;
  }
  const views = db.prepare("SELECT id, spec FROM overlay.views").all() as { id: string; spec: string }[];
  for (const r of views) {
    const spec = FilterSpecSchema.parse(JSON.parse(r.spec));
    const next = renameInSelectors(spec.hidden, from, to);
    if (!next) continue;
    db.prepare("UPDATE overlay.views SET spec = ? WHERE id = ?").run(
      JSON.stringify(FilterSpecSchema.parse({ ...spec, hidden: next })),
      r.id,
    );
    changed = true;
  }
  return changed;
}

/** Entries whose `sym:` id is not in the effective graph, sorted by entry, then id. Reads only. */
export function listUnresolved(store: Store): UnresolvedEntry[] {
  const state = readOverlay(store);
  const missing = [...usedSymIds(state)].filter((id) => store.getSymbol(id) === undefined);
  if (missing.length === 0) return [];
  const anchors = readAnchors(store);
  const byHash = idsByHash(store);
  const reasonOf = (id: string): "gone" | "ambiguous" => {
    const hash = anchors.get(id);
    return hash !== undefined && (byHash.get(hash)?.length ?? 0) > 0 ? "ambiguous" : "gone";
  };
  const gone = new Set(missing);
  const out: UnresolvedEntry[] = [];
  const idsOf = (selectors: readonly Selector[]) =>
    selectors.flatMap((s) => (s.type === "ids" ? s.ids : [])).filter((i) => gone.has(i));
  for (const l of state.labels) {
    if (gone.has(l.nodeId))
      out.push({ entry: "label", id: l.nodeId, text: l.text, reason: reasonOf(l.nodeId) });
  }
  for (const id of idsOf(state.hidden)) out.push({ entry: "hidden", id, reason: reasonOf(id) });
  for (const g of state.groups) {
    for (const id of idsOf(g.selectors))
      out.push({ entry: "group", id, groupId: g.id, reason: reasonOf(id) });
  }
  for (const v of state.views) {
    for (const id of idsOf(v.spec.hidden))
      out.push({ entry: "view", id, viewId: v.id, reason: reasonOf(id) });
  }
  const key = (e: UnresolvedEntry) => `${e.entry}\0${e.id}\0${e.groupId ?? ""}\0${e.viewId ?? ""}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
