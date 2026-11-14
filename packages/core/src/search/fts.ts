import { type Store, splitIdentifier } from "../store/index.js";
import type { SymbolKind } from "../types.js";

export interface SearchOptions {
  kind?: SymbolKind[];
  /** Workspace id (`ws:...`) or workspace name. */
  workspace?: string;
  exported?: boolean;
  limit?: number;
}

export interface SearchHit {
  id: string;
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  score: number;
}

export const DEFAULT_SEARCH_LIMIT = 20;
const MAX_QUERY_LEN = 200;
/** FTS candidates read before filters and boosts; filters run after the join with the effective view. */
const CANDIDATES = 1000;
const EXPORTED_BOOST = 1.2;
const EXACT_NAME_BOOST = 2;

/** Quotes a token for FTS5. Tokens are already alphanumeric; doubling quotes keeps the function safe regardless. */
const quote = (t: string): string => `"${t.replaceAll('"', '""')}"*`;

function runMatch(store: Store, terms: string[], joiner: " AND " | " OR "): { id: string; rank: number }[] {
  const match = `{name_tokens path} : (${terms.map(quote).join(joiner)})`;
  try {
    return store.db
      .prepare(
        `SELECT symbol_id AS id, bm25(fts_symbols, 0.0, 5.0, 3.0, 1.0, 1.0, 1.0) AS rank
         FROM fts_symbols WHERE fts_symbols MATCH ? ORDER BY rank, symbol_id LIMIT ?`,
      )
      .all(match, CANDIDATES) as { id: string; rank: number }[];
  } catch {
    return []; // a malformed expression is an empty result, never a crash
  }
}

/**
 * Full-text search over symbol name tokens and file path (M1). `q` is split with `splitIdentifier`; each
 * token becomes a prefix term, joined by AND, falling back to OR when AND finds nothing. Ranked by bm25,
 * exported symbols x1.2 and exact (case-insensitive) name matches x2. Higher score is better.
 */
export function ftsSearch(store: Store, q: string, opts: SearchOptions = {}): SearchHit[] {
  const query = q.trim().slice(0, MAX_QUERY_LEN);
  const terms = [...new Set(splitIdentifier(query))];
  if (terms.length === 0) return [];

  let rows = runMatch(store, terms, " AND ");
  if (rows.length === 0 && terms.length > 1) rows = runMatch(store, terms, " OR ");

  const files = new Map(store.effectiveFiles().map((f) => [f.id, f]));
  let workspaceId: string | undefined;
  if (opts.workspace !== undefined) {
    const ws = store.listWorkspaces().find((w) => w.id === opts.workspace || w.name === opts.workspace);
    if (!ws) return [];
    workspaceId = ws.id;
  }
  const kinds = opts.kind && opts.kind.length > 0 ? new Set(opts.kind) : undefined;
  const lower = query.toLowerCase();

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const s = store.getSymbol(r.id);
    if (!s) continue; // stale FTS row for a symbol hidden by the effective view
    const file = files.get(s.fileId);
    if (!file || file.deleted) continue;
    if (kinds && !kinds.has(s.kind)) continue;
    if (opts.exported !== undefined && s.exported !== opts.exported) continue;
    if (workspaceId !== undefined && file.workspaceId !== workspaceId) continue;
    let score = -r.rank; // bm25 is lower-is-better and negative
    if (s.exported) score *= EXPORTED_BOOST;
    if (s.name.toLowerCase() === lower) score *= EXACT_NAME_BOOST;
    hits.push({ id: s.id, name: s.name, kind: s.kind, path: file.path, line: s.startLine, score });
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, opts.limit ?? DEFAULT_SEARCH_LIMIT);
}
