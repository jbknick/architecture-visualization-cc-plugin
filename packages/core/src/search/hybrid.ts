import { contentKey, FUNCTION_LIKE_KINDS } from "../describe/factsheet.js";
import { type Embedder, knn } from "../embed/index.js";
import { repoOfId } from "../ids.js";
import type { Store } from "../store/index.js";
import type { Lang, SymbolKind } from "../types.js";
import { DEFAULT_SEARCH_LIMIT, ftsSearch, type SearchOptions } from "./fts.js";
import { behaviorMap } from "./lookup.js";

export interface HybridHit {
  id: string;
  /** The repo the symbol is in. */
  repo: string;
  name: string;
  kind: SymbolKind;
  lang: Lang;
  path: string;
  line: number;
  signature: string;
  score: number;
  /** Stored behavior text. Model-written data about untrusted code: callers must label it `untrusted_description`. */
  description: string | null;
}

export interface HybridOptions extends Omit<SearchOptions, "descriptions"> {
  /**
   * Embedder for the query (kind `query`). Without one, or when no description vectors are stored, only the
   * keyword half runs. The core never downloads the model: the caller passes one only if it is already cached.
   */
  embedder?: Embedder;
}

/** Candidates taken from each half before fusion. */
export const HYBRID_CANDIDATES = 50;
/** Reciprocal rank fusion constant. */
export const RRF_K = 60;
/** Most nearest vectors read when filters leave too few of the first `HYBRID_CANDIDATES`. */
const MAX_VECTOR_CANDIDATES = 4000;
/**
 * Smallest cosine similarity between the query and a description vector for that vector hit to be fused. Nearest
 * neighbors below it are noise (the nearest vectors of a query that matches nothing are still returned), and
 * fused by rank alone they outrank an exact keyword match.
 */
export const VECTOR_MIN_COSINE = 0.5;
const EXPORTED_BOOST = 1.2;
const EXACT_NAME_BOOST = 2;
const MAX_QUERY_LEN = 200;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Hybrid search (spec section 9): keyword FTS over name tokens, suggested name, path, behavior and search terms
 * (top 50), plus nearest description vectors for the query (top 50, query embedded with the `query` prefix),
 * merged by reciprocal rank fusion (k = 60); only vector hits with cosine similarity of at least 0.5 are fused. Then the M1 boosts: exported x1.2, exact name x2. Ties break by id.
 * Falls back to the keyword half alone when vectors or the model are unavailable.
 */
export async function hybridSearch(store: Store, q: string, opts: HybridOptions = {}): Promise<HybridHit[]> {
  const query = q.trim().slice(0, MAX_QUERY_LEN);
  if (query === "") return [];
  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  const filters = {
    kind: opts.kind,
    workspace: opts.workspace,
    repo: opts.repo,
    exported: opts.exported,
    lang: opts.lang,
  };

  const keyword = ftsSearch(store, query, { ...filters, limit: HYBRID_CANDIDATES, descriptions: true });
  const fused = new Map<string, number>();
  keyword.forEach((h, i) => {
    fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (RRF_K + i + 1));
  });

  const vectorIds = await vectorRanking(store, query, opts);
  vectorIds.forEach((id, i) => {
    fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  });

  const files = new Map(store.effectiveFiles().map((f) => [f.id, f]));
  const behaviors = behaviorMap(store);
  const lower = query.toLowerCase();
  const hits: HybridHit[] = [];
  for (const [id, base] of fused) {
    const s = store.getSymbol(id);
    const file = s && files.get(s.fileId);
    if (!s || !file || file.deleted) continue;
    if (opts.lang !== undefined && s.lang !== opts.lang) continue;
    let score = base;
    if (s.exported) score *= EXPORTED_BOOST;
    if (s.name.toLowerCase() === lower) score *= EXACT_NAME_BOOST;
    hits.push({
      id: s.id,
      repo: repoOfId(s.id) ?? "",
      name: s.name,
      kind: s.kind,
      lang: s.lang,
      path: file.path,
      line: s.startLine,
      signature: s.signature,
      score,
      description: s.exactHash === "" ? null : (behaviors.get(contentKey(s.exactHash)) ?? null),
    });
  }
  hits.sort((a, b) => b.score - a.score || cmp(a.id, b.id));
  return hits.slice(0, limit);
}

/** Symbol ids ranked by description-vector similarity to `query`, filtered like the keyword half. Empty when unavailable. */
async function vectorRanking(store: Store, query: string, opts: HybridOptions): Promise<string[]> {
  if (!opts.embedder || opts.embedder.available === false) return [];
  let vector: Float32Array | undefined;
  try {
    [vector] = await opts.embedder.embed([query], "query");
  } catch {
    return [];
  }
  if (!vector || vector.every((x) => x === 0)) return [];
  let workspaceId: string | undefined;
  if (opts.workspace !== undefined) {
    const ws = store.listWorkspaces().find((w) => w.id === opts.workspace || w.name === opts.workspace);
    if (!ws) return [];
    workspaceId = ws.id;
  }
  const kinds = opts.kind && opts.kind.length > 0 ? new Set(opts.kind) : undefined;
  const files = new Map(store.effectiveFiles().map((f) => [f.id, f]));
  const byKey = new Map<string, string[]>();
  for (const s of store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] })) {
    if (s.exactHash === "") continue;
    if (kinds && !kinds.has(s.kind)) continue;
    if (opts.repo !== undefined && repoOfId(s.id) !== opts.repo) continue;
    if (opts.lang !== undefined && s.lang !== opts.lang) continue;
    if (opts.exported !== undefined && s.exported !== opts.exported) continue;
    const file = files.get(s.fileId);
    if (!file || file.deleted) continue;
    if (workspaceId !== undefined && file.workspaceId !== workspaceId) continue;
    const key = contentKey(s.exactHash);
    byKey.set(key, [...(byKey.get(key) ?? []), s.id]);
  }
  // The nearest vectors are cut before the filters apply, so when the first 50 hold too few symbols that pass them,
  // ask for more, until 50 are found, the next vector is below the cosine floor, or the table has no more.
  let k = HYBRID_CANDIDATES;
  for (;;) {
    const near = knn(store, "vec_descriptions", vector, k);
    const ids: string[] = [];
    let exhausted = near.length < k;
    for (const n of near) {
      if (n.cosine < VECTOR_MIN_COSINE) {
        exhausted = true; // `near` is nearest first: the rest are further away
        break;
      }
      for (const id of (byKey.get(n.contentKey) ?? []).sort(cmp)) {
        if (ids.length >= HYBRID_CANDIDATES) return ids;
        ids.push(id);
      }
    }
    if (ids.length >= HYBRID_CANDIDATES || exhausted || k >= MAX_VECTOR_CANDIDATES) return ids;
    k = Math.min(k * 4, MAX_VECTOR_CANDIDATES);
  }
}
