import { contentKey, FUNCTION_LIKE_KINDS } from "../describe/factsheet.js";
import type { Store } from "../store/index.js";

interface FtsCols {
  nameTokens: string;
  path: string;
  suggested: string;
  behavior: string;
  terms: string;
}

/** `search_terms` is stored as a JSON array; FTS wants plain words. */
function termsText(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).join(" ") : String(parsed);
  } catch {
    return raw;
  }
}

/**
 * The one place that copies stored descriptions (behavior, search terms, suggested name) into `fts_symbols`, for
 * template-written and submitted descriptions alike. Batched: one scan of the FTS table, one delete pass and one
 * insert pass. Only effective function-like symbols that already have an FTS row and a stored description are
 * touched, and only when a column differs, so calling it again is cheap. `opts.keys` limits it to those content
 * keys. Returns how many rows were rewritten.
 */
export function refreshDescriptionFts(store: Store, opts: { keys?: ReadonlySet<string> } = {}): number {
  const desc = new Map<string, { behavior: string; terms: string; suggested: string }>();
  for (const r of store.db
    .prepare("SELECT content_key, behavior, search_terms, suggested_name FROM descriptions")
    .all() as {
    content_key: string;
    behavior: string | null;
    search_terms: string | null;
    suggested_name: string | null;
  }[]) {
    if (opts.keys && !opts.keys.has(r.content_key)) continue;
    desc.set(r.content_key, {
      behavior: r.behavior ?? "",
      terms: termsText(r.search_terms),
      suggested: r.suggested_name ?? "",
    });
  }
  if (desc.size === 0) return 0;

  const current = new Map<string, FtsCols>();
  for (const r of store.db
    .prepare("SELECT symbol_id, name_tokens, path, suggested_name, behavior, search_terms FROM fts_symbols")
    .all() as {
    symbol_id: string;
    name_tokens: string;
    path: string;
    suggested_name: string;
    behavior: string;
    search_terms: string;
  }[]) {
    current.set(r.symbol_id, {
      nameTokens: r.name_tokens,
      path: r.path,
      suggested: r.suggested_name,
      behavior: r.behavior,
      terms: r.search_terms,
    });
  }

  const changes: { id: string; cols: FtsCols }[] = [];
  for (const sym of store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] })) {
    if (sym.exactHash === "") continue;
    const d = desc.get(contentKey(sym.exactHash));
    const row = current.get(sym.id);
    if (!d || !row) continue; // the indexer writes the row; nothing to enrich yet
    if (row.behavior === d.behavior && row.terms === d.terms && row.suggested === d.suggested) continue;
    changes.push({
      id: sym.id,
      cols: { ...row, behavior: d.behavior, terms: d.terms, suggested: d.suggested },
    });
  }
  if (changes.length === 0) return 0;
  changes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  store.tx(() => {
    // fts_symbols has no index on symbol_id: one delete over all ids is one scan, not one per symbol.
    store.db
      .prepare("DELETE FROM fts_symbols WHERE symbol_id IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(changes.map((c) => c.id)));
    const insert = store.db.prepare(
      `INSERT INTO fts_symbols(symbol_id, name_tokens, suggested_name, path, behavior, search_terms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const { id, cols } of changes) {
      insert.run(id, cols.nameTokens, cols.suggested, cols.path, cols.behavior, cols.terms);
    }
  });
  return changes.length;
}
