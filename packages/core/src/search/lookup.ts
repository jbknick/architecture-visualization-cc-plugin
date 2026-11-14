import { contentKey } from "../describe/factsheet.js";
import type { Store } from "../store/index.js";
import type { SymbolRecord } from "../types.js";

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
