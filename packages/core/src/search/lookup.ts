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

/** Who wrote a stored description (#175): a model, a deterministic template, or the host's fallback after rejections. */
export type DescribedBy = "model" | "template" | "fallback";

const asDescribedBy = (p: string | null | undefined): DescribedBy | null =>
  p === "model" || p === "template" || p === "fallback" ? p : null;

/** Provenance of every stored description by content key (fixed values only, never description text). */
export function describedByMap(store: Store): Map<string, DescribedBy> {
  const out = new Map<string, DescribedBy>();
  for (const r of store.db.prepare("SELECT content_key, provenance FROM descriptions").all() as {
    content_key: string;
    provenance: string | null;
  }[]) {
    const d = asDescribedBy(r.provenance);
    if (d !== null) out.set(r.content_key, d);
  }
  return out;
}

/** Provenance of one symbol's stored description, or null when it has none. */
export function describedByOf(store: Store, sym: SymbolRecord | undefined): DescribedBy | null {
  if (!sym || sym.exactHash === "") return null;
  const r = store.db
    .prepare("SELECT provenance FROM descriptions WHERE content_key = ?")
    .get(contentKey(sym.exactHash)) as { provenance: string | null } | undefined;
  return asDescribedBy(r?.provenance);
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
