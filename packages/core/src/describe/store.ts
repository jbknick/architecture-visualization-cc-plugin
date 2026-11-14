import type { Store } from "../store/index.js";
import type { Description } from "../types.js";
import { PROMPT_MAJOR } from "./factsheet.js";

export interface AcceptedDescription {
  contentKey: string;
  description: Description;
  /** Model that wrote it, for example `haiku`. */
  model: string;
  provenance: "worker" | "subagent";
}

/**
 * Stores descriptions that already passed `validateDescription` and removes their backlog rows, in one
 * transaction. A key that already has a description is left alone (first writer wins). Returns how many were stored.
 */
export function storeDescriptions(store: Store, accepted: AcceptedDescription[]): number {
  if (accepted.length === 0) return 0;
  const insert = store.db.prepare(
    `INSERT OR IGNORE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
       provenance, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const drop = store.db.prepare("DELETE FROM backlog WHERE content_key = ?");
  const at = new Date().toISOString();
  return store.tx(() => {
    let stored = 0;
    for (const a of accepted) {
      const d = a.description;
      stored += insert.run(
        a.contentKey,
        d.behavior,
        JSON.stringify(d.searchTerms),
        d.nameFits ? 1 : 0,
        d.suggestedName ?? null,
        a.provenance,
        a.model,
        PROMPT_MAJOR,
        at,
      ).changes;
      drop.run(a.contentKey);
    }
    return stored;
  });
}
