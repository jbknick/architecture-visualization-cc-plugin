import { type GantryConfig, loadConfigForDb } from "../config/index.js";
import { contentKey, FUNCTION_LIKE_KINDS } from "../describe/factsheet.js";
import { allVectors, getVector, knn, type VecTable, vecAvailable } from "../embed/vec.js";
import { hashSymbol, MINHASH_PERMUTATIONS, minhashJaccard } from "../hash/index.js";
import { langOfPath, languageModule, languages, parseFile } from "../lang/index.js";
import type { Store } from "../store/index.js";
import { decodeMinhash } from "../store/repo.js";
import type { Lang, SymbolKind, SymbolRecord } from "../types.js";
import {
  isExcludedPath,
  type KindFamily,
  kindFamily,
  matchesIgnore,
  pairKey,
  paramsClose,
  type SignatureShape,
  signatureShape,
  signaturesCompatible,
} from "./filters.js";

/**
 * Duplicate engine (spec section 17): four tiers from cheapest to most semantic.
 *
 * - exact: same `exactHash`, or same `renamedHash` (the function's own name normalised, #151), `stmtCount >= 3`;
 * - near: same `shapeHash` or shape MinHash Jaccard >= `nearJaccard`, and token MinHash Jaccard (literals,
 *   property names and callees kept) >= `nearTokenJaccard`, `stmtCount >= 6`, parameter count within 1. The score
 *   is the token Jaccard;
 * - code_vector: cosine >= `codeVector` between normalized-code embeddings (KNN, k = 10), and token MinHash
 *   Jaccard >= `codeVectorTokenJaccard` (the normalizer turns every string into "s", #131);
 * - semantic: cosine >= `semantic` between description embeddings, compatible signature.
 *
 * Exact and near need no model: they read hashes through in-memory indexes (an exact-hash map, a
 * shape-hash map and a 16 x 4 MinHash LSH) built on first use and cached per store until it changes.
 * The vector tiers only read vectors that are already stored: they return nothing when sqlite-vec is
 * missing or the query has no vector yet, and never load the model or embed (callers can pass vectors
 * they computed themselves). What was skipped, and why, is reported in `DupResult.skipped`.
 */

export type Tier = "exact" | "near" | "code_vector" | "semantic";
export interface DupCandidate {
  symbolId: string;
  tier: Tier;
  score: number;
}
export interface DupQuery {
  /** An indexed symbol: its stored hashes are used and it is never returned as its own duplicate. */
  symbol?: SymbolRecord;
  /** Code not (yet) on disk. Hashed in memory; wins over `symbol` for the hashes. */
  code?: {
    source: string /** File dialect when `path` is absent (`ts` or `tsx`). */;
    lang: "ts" | "tsx";
    path?: string;
  };
  /**
   * Description of the query. Used by the semantic tier, which can only compare vectors: without
   * `vectors.description` it is reported as skipped (a stored description of the same code is used otherwise).
   */
  description?: string;
  kind?: SymbolKind;
  /** Vectors the caller already has. Never computed by the engine. */
  vectors?: { code?: Float32Array; description?: Float32Array };
}
export interface DupOptions {
  /** Maximum candidates returned. Default 10. */
  limit?: number;
  /** Tiers to run. Default all four. */
  tiers?: Tier[];
  excludeIds?: string[];
  /** Config to use instead of reading `<dataDir>/config.json` (thresholds and `duplicates.ignore`). */
  config?: GantryConfig;
}
export type SkipReason =
  | "no_function"
  | "below_statement_floor"
  | "vectors_unavailable"
  | "not_embedded"
  | "no_description";
export interface DupSkip {
  tier: Tier;
  reason: SkipReason;
  /** Ready to show: for the vector tiers "vector tiers unavailable: run gantry embed". */
  message: string;
}
export interface DupResult {
  candidates: DupCandidate[];
  skipped: DupSkip[];
}

export const TIER_RANK: Record<Tier, number> = { exact: 0, near: 1, code_vector: 2, semantic: 3 };
export const ALL_TIERS: readonly Tier[] = ["exact", "near", "code_vector", "semantic"];
/** The statement floors of TypeScript; each language module carries its own (`lang/`). */
export const EXACT_MIN_STMTS = languageModule("typescript").thresholds.exactMinStmts;
export const NEAR_MIN_STMTS = languageModule("typescript").thresholds.nearMinStmts;
/** A language named before its module exists (Go) uses the TypeScript floors until it gets its own. */
const floorsOf = (lang: Lang) =>
  (languages().find((m) => m.id === lang) ?? languageModule("typescript")).thresholds;
/** Smallest exact-tier floor of any language: the index holds every function above it. */
const MIN_INDEXED_STMTS = Math.min(...languages().map((m) => m.thresholds.exactMinStmts));

/**
 * The similarity thresholds for a language (spec section 17). Every language starts with the configured values, which
 * are the TypeScript ones; a language gets its own only when seeded duplicates in it fail.
 */
export function thresholdsFor(config: GantryConfig, _lang: Lang): GantryConfig["duplicates"]["thresholds"] {
  return config.duplicates.thresholds;
}
export const KNN_K = 10;
export const DEFAULT_LIMIT = 10;
const LSH_BANDS = 16;
const LSH_ROWS = 4;
const VECTOR_MESSAGE = "vector tiers unavailable: run gantry embed";

// --- index --------------------------------------------------------------------------------------

interface Entry {
  id: string;
  fileId: string;
  path: string;
  kind: SymbolKind;
  lang: Lang;
  family: KindFamily;
  exported: boolean;
  stmt: number;
  exactHash: string;
  renamedHash: string;
  shapeHash: string;
  minhash: Uint32Array;
  nearMinhash: Uint32Array;
  ckey: string;
  sig: SignatureShape;
}

interface DupIndex {
  generation: string;
  entries: Entry[];
  byId: Map<string, Entry>;
  byExact: Map<string, Entry[]>;
  byRenamed: Map<string, Entry[]>;
  byShape: Map<string, Entry[]>;
  byCkey: Map<string, Entry[]>;
  bands: Map<number, Entry[]>[];
}

interface SymbolRow {
  id: string;
  name: string;
  directives: string | null;
  file_id: string;
  path: string;
  kind: SymbolKind;
  lang: Lang;
  exported: number;
  signature: string;
  stmt_count: number;
  exact_hash: string;
  renamed_hash: string | null;
  shape_hash: string;
  minhash: Buffer | null;
  near_minhash: Buffer | null;
}

const LAYER_FILES = (layer: "effective" | "main"): string =>
  layer === "main"
    ? "SELECT * FROM files WHERE layer = 'main'"
    : `SELECT * FROM files WHERE layer = 'working'
       UNION ALL
       SELECT m.* FROM files m WHERE m.layer = 'main'
         AND NOT EXISTS (SELECT 1 FROM files w WHERE w.id = m.id AND w.layer = 'working')`;

const KINDS_SQL = FUNCTION_LIKE_KINDS.map((k) => `'${k}'`).join(",");

function band(m: Uint32Array, b: number): number {
  let h = 0x811c9dc5;
  for (let r = 0; r < LSH_ROWS; r++) h = Math.imul(h ^ (m[b * LSH_ROWS + r] as number), 0x01000193);
  return h >>> 0;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Function-like symbols with `stmtCount >= 3` of the chosen layer view, minus tests, fixtures and generated files. */
function buildIndex(store: Store, layer: "effective" | "main"): DupIndex {
  const rows = store.db
    .prepare(
      `WITH eff_files AS (${LAYER_FILES(layer)})
       SELECT s.id, s.name, f.directives, s.file_id, f.path, s.kind, s.lang, s.exported, s.signature, s.stmt_count, s.exact_hash,
              s.shape_hash, s.minhash, s.near_minhash, s.renamed_hash
       FROM symbols s JOIN eff_files f ON f.id = s.file_id AND f.layer = s.layer
       WHERE f.deleted = 0 AND s.kind IN (${KINDS_SQL}) AND s.stmt_count >= ${MIN_INDEXED_STMTS}
         AND s.exact_hash != ''
       ORDER BY s.id`,
    )
    .all() as SymbolRow[];
  const index: DupIndex = {
    generation: store.generation(),
    entries: [],
    byId: new Map(),
    byExact: new Map(),
    byRenamed: new Map(),
    byShape: new Map(),
    byCkey: new Map(),
    bands: Array.from({ length: LSH_BANDS }, () => new Map()),
  };
  for (const r of rows) {
    if (isExcludedPath(r.path)) continue;
    if (r.lang === "go" && (r.name === "_" || r.name === "init")) continue; // many per package, never reused
    if (r.lang === "go" && r.directives?.includes('"generated"')) continue; // header says "Code generated … DO NOT EDIT."
    const family = kindFamily(r.kind);
    if (!family) continue;
    const e: Entry = {
      id: r.id,
      fileId: r.file_id,
      path: r.path,
      kind: r.kind,
      lang: r.lang,
      family,
      exported: r.exported === 1,
      stmt: r.stmt_count,
      exactHash: r.exact_hash,
      renamedHash: r.renamed_hash ?? "",
      shapeHash: r.shape_hash,
      minhash: decodeMinhash(r.minhash),
      nearMinhash: decodeMinhash(r.near_minhash),
      ckey: contentKey(r.exact_hash),
      sig: signatureShape(r.signature),
    };
    index.entries.push(e);
    index.byId.set(e.id, e);
    push(index.byExact, e.exactHash, e);
    if (e.renamedHash !== "") push(index.byRenamed, e.renamedHash, e);
    push(index.byCkey, e.ckey, e);
    if (e.stmt >= floorsOf(e.lang).nearMinStmts) {
      if (e.shapeHash !== "") push(index.byShape, e.shapeHash, e);
      if (e.minhash.length === MINHASH_PERMUTATIONS) {
        for (let b = 0; b < LSH_BANDS; b++)
          push(index.bands[b] as Map<number, Entry[]>, band(e.minhash, b), e);
      }
    }
  }
  return index;
}

const cache = new WeakMap<Store, DupIndex>();

function effectiveIndex(store: Store): DupIndex {
  const gen = store.generation();
  const hit = cache.get(store);
  if (hit && hit.generation === gen) return hit;
  const built = buildIndex(store, "effective");
  cache.set(store, built);
  return built;
}

// --- query features -------------------------------------------------------------------------------

interface Features {
  symbolId?: string;
  lang: Lang;
  family: KindFamily;
  stmt: number;
  exactHash: string;
  renamedHash: string;
  shapeHash: string;
  minhash: Uint32Array;
  nearMinhash: Uint32Array;
  ckey: string;
  sig: SignatureShape;
}

const FUNCTION_LIKE: ReadonlySet<SymbolKind> = new Set(FUNCTION_LIKE_KINDS);

function featuresOfCode(q: DupQuery): Features | null {
  const code = q.code as NonNullable<DupQuery["code"]>;
  const path = code.path ?? (code.lang === "tsx" ? "scratch.tsx" : "scratch.ts");
  const parsed = parseFile("scratch", path, code.source);
  const sym = parsed.symbols.find((s) => FUNCTION_LIKE.has(s.kind));
  const range = sym && parsed.bodies.get(sym.id);
  if (!sym || !range) return null;
  const h = hashSymbol(code.source, range, path);
  const family = kindFamily(q.kind ?? sym.kind);
  if (!family) return null;
  return {
    symbolId: q.symbol?.id,
    lang: langOfPath(path),
    family,
    stmt: sym.stmtCount,
    exactHash: h.exactHash,
    renamedHash: h.renamedHash,
    shapeHash: h.shapeHash,
    minhash: h.minhash,
    nearMinhash: h.nearMinhash,
    ckey: contentKey(h.exactHash),
    sig: signatureShape(sym.signature),
  };
}

function featuresOfSymbol(s: SymbolRecord, kind?: SymbolKind): Features | null {
  const family = kindFamily(kind ?? s.kind);
  if (!family) return null;
  return {
    symbolId: s.id,
    lang: s.lang,
    family,
    stmt: s.stmtCount,
    exactHash: s.exactHash,
    renamedHash: s.renamedHash ?? "",
    shapeHash: s.shapeHash,
    minhash: s.minhash,
    nearMinhash: s.nearMinhash ?? new Uint32Array(0),
    ckey: contentKey(s.exactHash),
    sig: signatureShape(s.signature),
  };
}

function featuresOfEntry(e: Entry): Features {
  return {
    symbolId: e.id,
    lang: e.lang,
    family: e.family,
    stmt: e.stmt,
    exactHash: e.exactHash,
    renamedHash: e.renamedHash,
    shapeHash: e.shapeHash,
    minhash: e.minhash,
    nearMinhash: e.nearMinhash,
    ckey: e.ckey,
    sig: e.sig,
  };
}

// --- tiers ----------------------------------------------------------------------------------------

interface Deps {
  vec(table: VecTable, key: string): Float32Array | undefined;
  knn(table: VecTable, vector: Float32Array, k: number, key?: string): ReturnType<typeof knn>;
  vecAvailable: boolean;
}

interface Thresholds {
  nearJaccard: number;
  nearTokenJaccard: number;
  codeVectorTokenJaccard: number;
  codeVector: number;
  semantic: number;
}

interface RunInput {
  index: DupIndex;
  f: Features;
  thresholds: Thresholds;
  ignore: readonly string[];
  tiers: ReadonlySet<Tier>;
  limit: number;
  excluded: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  deps: Deps;
  queryVectors?: DupQuery["vectors"];
  /** True when the caller gave description text (which has no vector unless `queryVectors.description`). */
  hasDescriptionText: boolean;
  /** Skip reasons are reported only when a caller asked for them. */
  skipped?: DupSkip[];
}

/**
 * Near-tier verdict for a pair: null when it is not near, else its score. The shape gate (same `shapeHash`, or shape
 * Jaccard >= `nearJaccard`) finds same-structured code; the token gate (token Jaccard >= `nearTokenJaccard`) drops
 * pairs that only share a shape, such as two lookup functions that map different strings (#131). The score is the
 * token Jaccard. A side without a token MinHash (a row from before schema v5) is judged by the shape gate alone.
 */
export function nearScore(
  f: Pick<Features, "shapeHash" | "minhash" | "nearMinhash">,
  e: Pick<Features, "shapeHash" | "minhash" | "nearMinhash">,
  t: Pick<Thresholds, "nearJaccard" | "nearTokenJaccard">,
): number | null {
  const sameShape = f.shapeHash !== "" && e.shapeHash === f.shapeHash;
  const shape =
    e.minhash.length === f.minhash.length && f.minhash.length > 0
      ? minhashJaccard(f.minhash, e.minhash)
      : sameShape
        ? 1
        : 0;
  if (!(sameShape || shape >= t.nearJaccard)) return null;
  if (f.nearMinhash.length !== MINHASH_PERMUTATIONS || e.nearMinhash.length !== MINHASH_PERMUTATIONS)
    return shape;
  const tokens = minhashJaccard(f.nearMinhash, e.nearMinhash);
  return tokens >= t.nearTokenJaccard ? tokens : null;
}

/**
 * Code-vector gate (#131): the embedding text replaces every string literal with "s", so two lookup functions that
 * map different strings embed alike. A code-vector pair must also share this much of the token stream. True when a
 * side has no token MinHash (a row from before schema v5).
 */
export function tokensShared(
  f: Pick<Features, "nearMinhash">,
  e: Pick<Features, "nearMinhash">,
  min: number,
): boolean {
  if (f.nearMinhash.length !== MINHASH_PERMUTATIONS || e.nearMinhash.length !== MINHASH_PERMUTATIONS)
    return true;
  return minhashJaccard(f.nearMinhash, e.nearMinhash) >= min;
}

const byScore = (a: DupCandidate, b: DupCandidate): number =>
  b.score - a.score || (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0);

function runTiers(inp: RunInput): DupCandidate[] {
  const { index, f, thresholds, tiers, limit } = inp;
  const out: DupCandidate[] = [];
  const seen = new Set<string>();
  const ignoreMemo = new Map<string, boolean>();
  const ignored = (path: string): boolean => {
    let v = ignoreMemo.get(path);
    if (v === undefined) {
      v = inp.ignore.length > 0 && matchesIgnore(path, inp.ignore);
      ignoreMemo.set(path, v);
    }
    return v;
  };
  const eligible = (e: Entry): boolean =>
    e.id !== f.symbolId &&
    e.lang === f.lang && // never across languages
    e.family === f.family &&
    !inp.excluded.has(e.id) &&
    !inp.dismissed.has(e.id) &&
    !ignored(e.path);
  const skip = (tier: Tier, reason: SkipReason, message: string): void => {
    inp.skipped?.push({ tier, reason, message });
  };
  const take = (tier: Tier, hits: { e: Entry; score: number }[]): void => {
    const picked = hits
      .map((h) => ({ symbolId: h.e.id, tier, score: h.score }))
      .sort(byScore)
      .filter((c) => !seen.has(c.symbolId));
    for (const c of picked) {
      seen.add(c.symbolId);
      out.push(c);
    }
  };
  const full = (): boolean => out.length >= limit;
  const { exactMinStmts, nearMinStmts } = floorsOf(f.lang);

  // exact
  if (tiers.has("exact")) {
    if (f.stmt < exactMinStmts || f.exactHash === "") {
      skip("exact", "below_statement_floor", `fewer than ${exactMinStmts} statements`);
    } else {
      // The same code, or the same code under another name (renamedHash; rows from before schema v6 have none).
      const same = new Set<Entry>(index.byExact.get(f.exactHash) ?? []);
      if (f.renamedHash !== "") for (const e of index.byRenamed.get(f.renamedHash) ?? []) same.add(e);
      take(
        "exact",
        [...same].filter(eligible).map((e) => ({ e, score: 1 })),
      );
    }
  }

  // near
  if (tiers.has("near") && !full()) {
    if (f.stmt < nearMinStmts) {
      skip("near", "below_statement_floor", `fewer than ${nearMinStmts} statements`);
    } else {
      const cand = new Set<Entry>();
      if (f.shapeHash !== "") for (const e of index.byShape.get(f.shapeHash) ?? []) cand.add(e);
      if (f.minhash.length === MINHASH_PERMUTATIONS) {
        for (let b = 0; b < LSH_BANDS; b++) {
          for (const e of (index.bands[b] as Map<number, Entry[]>).get(band(f.minhash, b)) ?? []) cand.add(e);
        }
      }
      const hits: { e: Entry; score: number }[] = [];
      for (const e of cand) {
        if (!eligible(e) || !paramsClose(f.sig.params, e.sig.params)) continue;
        const n = nearScore(f, e, thresholds);
        if (n !== null) hits.push({ e, score: n });
      }
      take("near", hits);
    }
  }

  // code_vector
  if (tiers.has("code_vector") && !full()) {
    if (!inp.deps.vecAvailable) {
      skip("code_vector", "vectors_unavailable", "vector tiers unavailable: sqlite-vec could not be loaded");
    } else if (f.stmt < exactMinStmts) {
      skip("code_vector", "below_statement_floor", `fewer than ${exactMinStmts} statements`);
    } else {
      const qv = inp.queryVectors?.code ?? inp.deps.vec("vec_code", f.ckey);
      if (!qv) {
        skip("code_vector", "not_embedded", VECTOR_MESSAGE);
      } else {
        const hits: { e: Entry; score: number }[] = [];
        for (const n of inp.deps.knn("vec_code", qv, KNN_K, f.ckey)) {
          if (n.cosine < thresholds.codeVector) continue;
          for (const e of index.byCkey.get(n.contentKey) ?? [])
            if (eligible(e) && tokensShared(f, e, thresholds.codeVectorTokenJaccard))
              hits.push({ e, score: n.cosine });
        }
        take("code_vector", hits);
      }
    }
  }

  // semantic
  if (tiers.has("semantic") && !full()) {
    if (!inp.deps.vecAvailable) {
      skip("semantic", "vectors_unavailable", "vector tiers unavailable: sqlite-vec could not be loaded");
    } else if (f.stmt < exactMinStmts) {
      skip("semantic", "below_statement_floor", `fewer than ${exactMinStmts} statements`);
    } else {
      // Stored vector only when the description is the stored one: text from the caller has its own vector.
      const qv =
        inp.queryVectors?.description ??
        (inp.hasDescriptionText ? undefined : inp.deps.vec("vec_descriptions", f.ckey));
      if (!qv) {
        skip(
          "semantic",
          inp.hasDescriptionText ? "not_embedded" : "no_description",
          inp.hasDescriptionText
            ? "description given without a vector: pass vectors.description (the engine never embeds)"
            : VECTOR_MESSAGE,
        );
      } else {
        const hits: { e: Entry; score: number }[] = [];
        for (const n of inp.deps.knn("vec_descriptions", qv, KNN_K, f.ckey)) {
          if (n.cosine < thresholds.semantic) continue;
          for (const e of index.byCkey.get(n.contentKey) ?? []) {
            if (eligible(e) && signaturesCompatible(f.sig, e.sig)) hits.push({ e, score: n.cosine });
          }
        }
        take("semantic", hits);
      }
    }
  }
  return out.slice(0, limit);
}

// --- public API -----------------------------------------------------------------------------------

function dismissedWith(store: Store, id: string | undefined): Set<string> {
  const out = new Set<string>();
  if (id === undefined) return out;
  const rows = store.db.prepare("SELECT a, b FROM dismissals WHERE a = ? OR b = ?").all(id, id) as {
    a: string;
    b: string;
  }[];
  for (const r of rows) out.add(r.a === id ? r.b : r.a);
  return out;
}

const storeDeps = (store: Store): Deps => ({
  vec: (table, key) => getVector(store, table, key),
  knn: (table, vector, k) => knn(store, table, vector, k),
  vecAvailable: vecAvailable(store),
});

/**
 * Like `findDuplicates`, and also says which tiers were skipped and why (for example
 * "vector tiers unavailable: run gantry embed"), so a caller can tell "nothing found" from "not checked".
 * Thresholds and `duplicates.ignore` are read from the config on every call.
 */
export async function findDuplicatesDetailed(
  store: Store,
  q: DupQuery,
  opts: DupOptions = {},
): Promise<DupResult> {
  const tiers = new Set<Tier>(opts.tiers ?? ALL_TIERS);
  const f = q.code ? featuresOfCode(q) : q.symbol ? featuresOfSymbol(q.symbol, q.kind) : null;
  if (!f) {
    return {
      candidates: [],
      skipped: [...tiers].map((tier) => ({
        tier,
        reason: "no_function" as const,
        message: "no function-like symbol to check",
      })),
    };
  }
  const config = opts.config ?? loadConfigForDb(store.db.name);
  const skipped: DupSkip[] = [];
  const candidates = runTiers({
    index: effectiveIndex(store),
    f,
    thresholds: thresholdsFor(config, f.lang),
    ignore: config.duplicates.ignore,
    tiers,
    limit: Math.max(0, opts.limit ?? DEFAULT_LIMIT),
    excluded: new Set(opts.excludeIds ?? []),
    dismissed: dismissedWith(store, f.symbolId),
    deps: storeDeps(store),
    queryVectors: q.vectors,
    hasDescriptionText: q.description !== undefined,
    skipped,
  });
  return { candidates, skipped };
}

/**
 * Likely duplicates of the query, best tier first (exact, near, code_vector, semantic), each tier by
 * score (then symbol id), one entry per symbol. See the module comment for the tiers and filters.
 */
export async function findDuplicates(store: Store, q: DupQuery, opts?: DupOptions): Promise<DupCandidate[]> {
  return (await findDuplicatesDetailed(store, q, opts)).candidates;
}

export interface RebuildOptions {
  /** Tiers to rebuild. Default exact, near and code_vector (the semantic tier does not make edges). */
  tiers?: Tier[];
  config?: GantryConfig;
  /** Candidates kept per symbol. Default 10. */
  perSymbolLimit?: number;
}

const EDGE_TIERS: readonly Tier[] = ["exact", "near", "code_vector"];

/**
 * Rewrites the main-layer `similar_to` edges from the main-layer symbols that are exported or have at
 * least 6 statements. One edge per pair (lower id as `src`), `confidence` high for exact and near, low
 * for code_vector, `evidence` `[tier]`, stored on the `src` file. Only edges of the rebuilt tiers are
 * replaced (plus edges whose symbols are gone), so a cheap `["exact", "near"]` rebuild keeps the vector
 * edges. Returns the number of edges written. Never loads a model; vector edges need stored vectors.
 */
export async function rebuildSimilarEdges(store: Store, opts: RebuildOptions = {}): Promise<number> {
  const tiers = new Set<Tier>((opts.tiers ?? EDGE_TIERS).filter((t) => EDGE_TIERS.includes(t)));
  const config = opts.config ?? loadConfigForDb(store.db.name);
  const index = buildIndex(store, "main");
  const limit = opts.perSymbolLimit ?? DEFAULT_LIMIT;

  const dismissedPairs = new Set<string>();
  for (const r of store.db.prepare("SELECT a, b FROM dismissals").all() as { a: string; b: string }[]) {
    dismissedPairs.add(pairKey(r.a, r.b));
  }
  const wantVectors = tiers.has("code_vector") && vecAvailable(store);
  const vectors = wantVectors ? allVectors(store, "vec_code") : new Map<string, Float32Array>();
  const knnMemo = new Map<string, ReturnType<typeof knn>>();
  const deps: Deps = {
    vec: (table, key) => (table === "vec_code" ? vectors.get(key) : undefined),
    knn: (table, vector, k, key) => {
      const memo = key === undefined ? undefined : knnMemo.get(key);
      if (memo) return memo;
      const r = knn(store, table, vector, k);
      if (key !== undefined) knnMemo.set(key, r);
      return r;
    },
    vecAvailable: wantVectors,
  };
  const runTiersSet = new Set<Tier>([...tiers].filter((t) => t !== "semantic"));

  const best = new Map<string, { src: Entry; dst: string; tier: Tier; score: number }>();
  for (const e of index.entries) {
    if (!(e.exported || e.stmt >= floorsOf(e.lang).nearMinStmts)) continue;
    const dismissed = new Set<string>();
    const found = runTiers({
      index,
      f: featuresOfEntry(e),
      thresholds: thresholdsFor(config, e.lang),
      ignore: config.duplicates.ignore,
      tiers: runTiersSet,
      limit,
      excluded: new Set(),
      dismissed,
      deps,
      hasDescriptionText: false,
    });
    for (const c of found) {
      const key = pairKey(e.id, c.symbolId);
      if (dismissedPairs.has(key)) continue;
      const prev = best.get(key);
      if (
        !prev ||
        TIER_RANK[c.tier] < TIER_RANK[prev.tier] ||
        (c.tier === prev.tier && c.score > prev.score)
      ) {
        const lowFirst = e.id < c.symbolId;
        const src = lowFirst ? e : (index.byId.get(c.symbolId) as Entry);
        best.set(key, { src, dst: lowFirst ? c.symbolId : e.id, tier: c.tier, score: c.score });
      }
    }
  }

  return store.tx(() => {
    const tierList = [...tiers].map((t) => `'${t}'`).join(",");
    if (tierList !== "") {
      store.db
        .prepare(
          `DELETE FROM edges WHERE kind = 'similar_to' AND layer = 'main'
           AND json_extract(evidence, '$[0]') IN (${tierList})`,
        )
        .run();
    }
    // Edges whose symbols are no longer comparable (removed, below the floor, now in an excluded file).
    const stale = store.db
      .prepare("SELECT src, dst FROM edges WHERE kind = 'similar_to' AND layer = 'main'")
      .all() as { src: string; dst: string }[];
    const del = store.db.prepare(
      "DELETE FROM edges WHERE kind = 'similar_to' AND layer = 'main' AND src = ? AND dst = ?",
    );
    for (const e of stale) if (!index.byId.has(e.src) || !index.byId.has(e.dst)) del.run(e.src, e.dst);

    const ins = store.db.prepare(
      `INSERT INTO edges(src, dst, kind, layer, confidence, count, evidence, file_id)
       VALUES (?, ?, 'similar_to', 'main', ?, 1, ?, ?)
       ON CONFLICT(src, dst, kind, layer) DO UPDATE SET confidence = excluded.confidence,
         count = excluded.count, evidence = excluded.evidence, file_id = excluded.file_id`,
    );
    const ordered = [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [, p] of ordered) {
      ins.run(
        p.src.id,
        p.dst,
        p.tier === "code_vector" ? "low" : "high",
        JSON.stringify([p.tier]),
        p.src.fileId,
      );
    }
    return ordered.length;
  });
}

/**
 * Records that `a` and `b` are not duplicates: the pair never alerts again, in either order, and the
 * main-layer `similar_to` edge between them is removed. `a` and `b` are symbol ids.
 */
export function dismiss(store: Store, a: string, b: string, reason: string): void {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO dismissals(a, b, reason) VALUES (?, ?, ?)
         ON CONFLICT(a, b) DO UPDATE SET reason = excluded.reason`,
      )
      .run(lo, hi, reason);
    store.db
      .prepare(
        `DELETE FROM edges WHERE kind = 'similar_to' AND ((src = ? AND dst = ?) OR (src = ? AND dst = ?))`,
      )
      .run(lo, hi, hi, lo);
  });
}
