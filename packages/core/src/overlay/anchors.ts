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
}
