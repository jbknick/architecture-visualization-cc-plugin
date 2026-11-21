import { kindFamily } from "../dup/filters.js";
import { isSymId } from "../ids.js";
import type { Store } from "../store/index.js";
import type { OverlayState, Selector } from "./types.js";

/** Kinds a hand-picked entry can follow (the function-like symbols, spec section 7). */
export const ANCHOR_KINDS = ["function", "method", "component", "hook"] as const;

const idsOf = (selectors: readonly Selector[]): string[] =>
  selectors.flatMap((s) => (s.type === "ids" ? s.ids : []));

/** Every `sym:` id some entry uses: a label, or an id inside an `ids` selector of the hidden list, a group or a saved view's `hidden`. */
export function usedSymIds(state: OverlayState): Set<string> {
  const all = [
    ...state.labels.map((l) => l.nodeId),
    ...idsOf(state.hidden),
    ...state.groups.flatMap((g) => idsOf(g.selectors)),
    ...state.views.flatMap((v) => idsOf(v.spec.hidden)),
  ];
  return new Set(all.filter(isSymId));
}

/**
 * Keeps `overlay.anchors` in step with what the entries use (spec section 9): a used symbol that exists gets its
 * current effective `exactHash` (written only when it differs), a used id whose symbol is already gone keeps the
 * anchor it had, and anchors no entry uses any more are deleted. Call it inside the write's transaction.
 */
export function syncAnchors(store: Store, state: OverlayState): void {
  const used = usedSymIds(state);
  const have = new Map(
    (
      store.db.prepare("SELECT node_id, exact_hash FROM overlay.anchors").all() as {
        node_id: string;
        exact_hash: string;
      }[]
    ).map((r) => [r.node_id, r.exact_hash]),
  );
  const del = store.db.prepare("DELETE FROM overlay.anchors WHERE node_id = ?");
  for (const id of have.keys()) if (!used.has(id)) del.run(id);
  const up = store.db.prepare(
    "INSERT INTO overlay.anchors(node_id, exact_hash) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET exact_hash = excluded.exact_hash",
  );
  for (const id of [...used].sort()) {
    const sym = store.getSymbol(id);
    if (sym && have.get(id) !== sym.exactHash) up.run(id, sym.exactHash);
  }
  syncRenamedAnchors(store, used);
  syncAnchorFamilies(store, used);
}

/** The `renamedHash` twin of the anchors (`overlay.anchor_renames`, #349), kept the same way; a symbol without a `renamedHash` gets none. */
function syncRenamedAnchors(store: Store, used: Set<string>): void {
  const have = new Map(
    (
      store.db.prepare("SELECT node_id, renamed_hash FROM overlay.anchor_renames").all() as {
        node_id: string;
        renamed_hash: string;
      }[]
    ).map((r) => [r.node_id, r.renamed_hash]),
  );
  const del = store.db.prepare("DELETE FROM overlay.anchor_renames WHERE node_id = ?");
  for (const id of have.keys()) if (!used.has(id)) del.run(id);
  const up = store.db.prepare(
    "INSERT INTO overlay.anchor_renames(node_id, renamed_hash) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET renamed_hash = excluded.renamed_hash",
  );
  for (const id of [...used].sort()) {
    const sym = store.getSymbol(id);
    if (sym?.renamedHash && have.get(id) !== sym.renamedHash) up.run(id, sym.renamedHash);
  }
}

/**
 * The kind family of the same symbols (`overlay.anchor_families`, #349: `function` for a function or method,
 * `component`, `hook`), kept the same way. Once the symbol is gone its kind cannot be read, and a rename in place must
 * not turn a function into a component or a hook, so the family is what `reattachOverlay` compares.
 */
function syncAnchorFamilies(store: Store, used: Set<string>): void {
  const have = new Map(
    (
      store.db.prepare("SELECT node_id, family FROM overlay.anchor_families").all() as {
        node_id: string;
        family: string;
      }[]
    ).map((r) => [r.node_id, r.family]),
  );
  const del = store.db.prepare("DELETE FROM overlay.anchor_families WHERE node_id = ?");
  for (const id of have.keys()) if (!used.has(id)) del.run(id);
  const up = store.db.prepare(
    "INSERT INTO overlay.anchor_families(node_id, family) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET family = excluded.family",
  );
  for (const id of [...used].sort()) {
    const sym = store.getSymbol(id);
    const family = sym ? kindFamily(sym.kind) : null;
    if (family && have.get(id) !== family) up.run(id, family);
  }
}
