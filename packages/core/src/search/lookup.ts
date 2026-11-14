import { contentKey } from "../describe/factsheet.js";
import type { Store } from "../store/index.js";
import type { Description, SymbolRecord } from "../types.js";

/** Stored `behavior` text by content key (template, model and submitted descriptions alike). */
export function behaviorMap(store: Store): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of store.db.prepare("SELECT content_key, behavior FROM descriptions").all() as {
    content_key: string;
    behavior: string | null;
  }[]) {
    if (r.behavior) out.set(r.content_key, r.behavior);
  }
  return out;
}

/** The stored behavior text of one symbol, or null when it has none. */
export function behaviorOf(store: Store, sym: SymbolRecord): string | null {
  if (sym.exactHash === "") return null;
  const r = store.db
    .prepare("SELECT behavior FROM descriptions WHERE content_key = ?")
    .get(contentKey(sym.exactHash)) as { behavior: string | null } | undefined;
  return r?.behavior || null;
}

/** The stored description of one symbol (all fields model-written and untrusted), or null when it has none. */
export function descriptionOf(store: Store, sym: SymbolRecord): Description | null {
  if (sym.exactHash === "") return null;
  const r = store.db
    .prepare(
      "SELECT behavior, search_terms, name_fits, suggested_name FROM descriptions WHERE content_key = ?",
    )
    .get(contentKey(sym.exactHash)) as
    | {
        behavior: string | null;
        search_terms: string | null;
        name_fits: number | null;
        suggested_name: string | null;
      }
    | undefined;
  if (!r) return null;
  let terms: string[] = [];
  try {
    const t = JSON.parse(r.search_terms ?? "[]");
    if (Array.isArray(t)) terms = t.filter((x): x is string => typeof x === "string");
  } catch {
    terms = [];
  }
  return {
    behavior: r.behavior ?? "",
    searchTerms: terms,
    nameFits: r.name_fits !== 0,
    ...(r.suggested_name ? { suggestedName: r.suggested_name } : {}),
  };
}
