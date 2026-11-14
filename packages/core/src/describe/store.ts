// The one write path for model-written descriptions, used by `submitDescriptions` (MCP describer tools) and by the
// headless worker. Callers validate first (`validateDescription`); nothing here judges text.
import type { Store } from "../store/index.js";
import type { Description } from "../types.js";
import { contentKey, FUNCTION_LIKE_KINDS, PROMPT_MAJOR } from "./factsheet.js";

/** A function whose description failed validation this many times is parked as `failed` (spec section 8: `describe.retry`). */
export const MAX_DESCRIBE_ATTEMPTS = 2;

export interface AcceptedDescription {
  contentKey: string;
  description: Description;
  /** Model that wrote it, for example `haiku`. */
  model: string;
}

/**
 * Stores descriptions that already passed `validateDescription` (provenance `model`), deletes their backlog rows and
 * updates the description columns of `fts_symbols` for every effective symbol with that content key, in one
 * transaction. By default a key that already has a description is left alone (first writer wins); `replace` overwrites.
 * Returns how many descriptions were stored.
 */
export function storeDescriptions(
  store: Store,
  accepted: AcceptedDescription[],
  opts: { replace?: boolean } = {},
): number {
  if (accepted.length === 0) return 0;
  const insert = store.db.prepare(
    `INSERT OR ${opts.replace ? "REPLACE" : "IGNORE"} INTO descriptions(content_key, behavior, search_terms, name_fits,
       suggested_name, provenance, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, 'model', ?, ?, ?)`,
  );
  const drop = store.db.prepare("DELETE FROM backlog WHERE content_key = ?");
  const at = new Date().toISOString();
  return store.tx(() => {
    let stored = 0;
    const written = new Map<string, Description>();
    for (const a of accepted) {
      const d = a.description;
      const r = insert.run(
        a.contentKey,
        d.behavior,
        JSON.stringify(d.searchTerms),
        d.nameFits ? 1 : 0,
        d.suggestedName ?? null,
        a.model,
        PROMPT_MAJOR,
        at,
      );
      stored += r.changes;
      if (r.changes > 0) written.set(a.contentKey, d);
      drop.run(a.contentKey);
    }
    updateFts(store, written);
    return stored;
  });
}

/**
 * Counts one failed attempt for a backlog row: `attempts + 1`, `last_error`, back to `pending` for another try, or
 * `failed` once `MAX_DESCRIBE_ATTEMPTS` is reached (then nobody retries it). Returns the new attempt count, or 0 when
 * there is no such row.
 */
export function recordDescribeFailure(store: Store, key: string, error: string): number {
  const row = store.db.prepare("SELECT attempts FROM backlog WHERE content_key = ?").get(key) as
    | { attempts: number | null }
    | undefined;
  if (!row) return 0;
  const attempts = (row.attempts ?? 0) + 1;
  store.db
    .prepare(
      `UPDATE backlog SET attempts = ?, last_error = ?, status = ?, claimed_by = NULL, claimed_at = NULL
       WHERE content_key = ?`,
    )
    .run(attempts, error, attempts >= MAX_DESCRIBE_ATTEMPTS ? "failed" : "pending", key);
  return attempts;
}

/** Writes the description columns of `fts_symbols` for every effective symbol whose content key was just stored. */
function updateFts(store: Store, stored: Map<string, Description>): void {
  if (stored.size === 0) return;
  const select = store.db.prepare("SELECT name_tokens, path FROM fts_symbols WHERE symbol_id = ?");
  for (const sym of store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] })) {
    if (sym.exactHash === "") continue;
    const d = stored.get(contentKey(sym.exactHash));
    if (!d) continue;
    const row = select.get(sym.id) as { name_tokens: string; path: string } | undefined;
    if (!row) continue; // the indexer writes the row; nothing to enrich yet
    store.fts.upsert(sym.id, {
      nameTokens: row.name_tokens,
      suggestedName: d.suggestedName ?? "",
      path: row.path,
      behavior: d.behavior,
      searchTerms: d.searchTerms.join(" "),
    });
  }
}
