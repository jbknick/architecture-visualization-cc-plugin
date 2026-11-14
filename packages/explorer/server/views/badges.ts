import { contentKey, FUNCTION_LIKE_KINDS, type Store, type SymbolRecord } from "@gantry/core";

/** M2 badge names, in the order they appear on a node. */
export const M2_BADGES = ["dup", "undescribed", "misleading"] as const;
export type M2Badge = (typeof M2_BADGES)[number];

const FUNCTION_LIKE = new Set<string>(FUNCTION_LIKE_KINDS);

export interface BadgeIndex {
  /** The M2 badges of one symbol, in `M2_BADGES` order. Empty for symbols with none. */
  of(symbol: SymbolRecord): string[];
}

/**
 * Computes M2 badges from the effective view, so working-layer changes show up. `dup`: the symbol is an end of a
 * `similar_to` edge whose pair is not in `dismissals`. `undescribed`: a function-like symbol (the only kind the
 * describer handles) whose content key has no stored description. `misleading`: its stored description has
 * `name_fits = 0`. Pure function of the store, so the output is deterministic.
 */
export function buildBadgeIndex(store: Store): BadgeIndex {
  const dismissed = new Set(
    (store.db.prepare("SELECT a, b FROM dismissals").all() as { a: string; b: string }[]).map(
      (r) => `${r.a}\n${r.b}`,
    ),
  );
  const dup = new Set<string>();
  for (const e of store.effectiveEdges({ kind: ["similar_to"] })) {
    const [a, b] = e.src < e.dst ? [e.src, e.dst] : [e.dst, e.src];
    if (dismissed.has(`${a}\n${b}`)) continue;
    dup.add(a);
    dup.add(b);
  }
  const described = new Map<string, boolean>(); // content key -> nameFits
  for (const r of store.db
    .prepare("SELECT content_key, name_fits FROM descriptions WHERE behavior IS NOT NULL AND behavior != ''")
    .all() as { content_key: string; name_fits: number | null }[]) {
    described.set(r.content_key, r.name_fits !== 0);
  }
  return {
    of(s) {
      const out: string[] = [];
      if (dup.has(s.id)) out.push("dup");
      if (FUNCTION_LIKE.has(s.kind) && s.exactHash !== "") {
        const fits = described.get(contentKey(s.exactHash));
        if (fits === undefined) out.push("undescribed");
        else if (!fits) out.push("misleading");
      }
      return out;
    },
  };
}

/** "exported" first, then the M2 badges; the key is left out when there are none. */
export function symbolBadges(s: SymbolRecord, index?: BadgeIndex): { badges?: string[] } {
  const b = [...(s.exported ? ["exported"] : []), ...(index?.of(s) ?? [])];
  return b.length > 0 ? { badges: b } : {};
}
