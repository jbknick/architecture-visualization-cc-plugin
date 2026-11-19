import { estimate } from "./describe/backlog.js";
import type { Store } from "./store/index.js";

export interface IndexCounts {
  /** Effective files, including the `package.json` / `go.mod` rows that carry workspace `depends_on` edges. */
  files: number;
  symbols: number;
  /** Distinct function-like bodies (one per content key): the functions that get a description. */
  functionLike: number;
  /** Effective edges, including workspace `depends_on` edges. */
  edges: number;
}

/** Effective rows (working wins per file) counted in SQL: the same numbers as `effective*().length`, without loading them. */
const EFF_COUNT = `WITH eff_files AS (
    SELECT id, layer, deleted FROM files WHERE layer = 'working'
    UNION ALL
    SELECT m.id, m.layer, m.deleted FROM files m WHERE m.layer = 'main'
      AND NOT EXISTS (SELECT 1 FROM files w WHERE w.id = m.id AND w.layer = 'working'))`;

/** Rows of one table in the effective, non-deleted graph. */
export function countEffective(store: Store, table: "files" | "symbols" | "edges"): number {
  const sql =
    table === "files"
      ? `${EFF_COUNT} SELECT COUNT(*) AS n FROM eff_files WHERE deleted = 0`
      : `${EFF_COUNT} SELECT COUNT(*) AS n FROM ${table} t JOIN eff_files f ON f.id = t.file_id AND f.layer = t.layer
         WHERE f.deleted = 0`;
  return (store.db.prepare(sql).get() as { n: number }).n;
}

/** The one source for the file, symbol, function-like and edge counts that `init`, `init --estimate` and `/api/meta` report (spec section 10). */
export function indexCounts(store: Store): IndexCounts {
  return {
    files: countEffective(store, "files"),
    symbols: countEffective(store, "symbols"),
    functionLike: estimate(store).functionLike,
    edges: countEffective(store, "edges"),
  };
}
