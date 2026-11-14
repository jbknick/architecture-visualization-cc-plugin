import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backlogPriority } from "../describe/backlog.js";
import { contentKey, FACT_BODY_MAX, FUNCTION_LIKE_KINDS, pathOfFileId } from "../describe/factsheet.js";
import { isSensitive } from "../discover/index.js";
import { normalizeForEmbedding } from "../hash/index.js";
import { parseSource } from "../parse/index.js";
import type { Store } from "../store/index.js";
import type { SymbolRecord } from "../types.js";
import { EMBED_BATCH_SIZE, type Embedder, getEmbedder } from "./model.js";
import {
  EMBED_DIM,
  EMBED_MODEL_ID,
  ensureVecTables,
  putVectors,
  storedKeys,
  type VecTable,
  vecAvailable,
} from "./vec.js";

export {
  EMBED_BATCH_SIZE,
  EMBED_MAX_TOKENS,
  type Embedder,
  type EmbedKind,
  getEmbedder,
  loadEmbedder,
  modelCacheDir,
  offlineEmbedder,
  resetEmbedderForTests,
} from "./model.js";
export {
  allVectors,
  applyVecMigration,
  blobToVec,
  EMBED_DIM,
  EMBED_MODEL_ID,
  ensureVecTables,
  getVector,
  knn,
  loadVec,
  putVectors,
  storedKeys,
  type VecTable,
  vecAvailable,
  vecToBlob,
} from "./vec.js";

/**
 * Functions with fewer statements are never compared by the duplicate tiers (spec section 17: `exact` needs
 * `stmtCount >= 3`, `near` needs 6), so their code is not embedded.
 */
export const MIN_CODE_STMTS = 3;
/**
 * Longest normalized code, in characters, sent to the model (applied after normalization): the same budget the
 * fact sheet gives a body. It bounds the cost per function; the tokenizer is capped separately (`EMBED_MAX_TOKENS`).
 */
export const CODE_EMBED_MAX_CHARS = FACT_BODY_MAX;
/** Rows embedded per call when called lazily from a query, so a search stays fast. */
export const LAZY_EMBED_LIMIT = 200;

export interface EmbedProgress {
  phase: "descriptions" | "code";
  /** Vectors stored by this call so far (both phases). */
  done: number;
  /** Vectors this call set out to store (pending at the start, capped by `limit`). */
  total: number;
  /** Stored so far in the current phase, and that phase's share of `total`. */
  phaseDone: number;
  phaseTotal: number;
  /** Time since the call started, and since the current phase started (rates are per phase: descriptions are far cheaper than code). */
  elapsedMs: number;
  phaseElapsedMs: number;
}

export interface EmbedPendingOptions {
  /** Maximum vectors stored by this call, descriptions first, then code. */
  limit?: number;
  /** Worktree root: needed to read the source of the functions whose code is embedded. Without it only descriptions are embedded. */
  root?: string;
  /** Embedder to use instead of the shared one (tests, or a caller that already loaded it). */
  embedder?: Embedder;
  /** Stop starting new batches once this much time has passed (or would pass, judged by the last batch's duration). */
  timeBudgetMs?: number;
  /** Rows per batch; each batch is embedded and committed on its own. Default `EMBED_BATCH_SIZE`. */
  batchSize?: number;
  /** Called after every committed batch. */
  onProgress?: (p: EmbedProgress) => void;
  /** Checked between batches; the batch in flight always finishes and commits. */
  signal?: AbortSignal;
  /** Clock in ms (tests). Default `performance.now`. */
  now?: () => number;
}

export interface EmbedPendingResult {
  descriptions: number;
  code: number;
  /** Vectors still missing after this call (descriptions plus code). */
  remaining: number;
  remainingDescriptions: number;
  remainingCode: number;
  /** Function-like symbols (distinct contentKeys) below `MIN_CODE_STMTS`: never embedded. */
  belowFloor: number;
  /** Wall time spent embedding (model calls plus commits) in each phase of this call. */
  ms: { descriptions: number; code: number };
  stoppedBy: "complete" | "limit" | "budget" | "aborted" | "unavailable";
}

/** Description text (spec section 17): `behavior + " " + searchTerms.join(" ")`. */
export function descriptionText(behavior: string, searchTerms: string | null): string {
  let terms: string[] = [];
  if (searchTerms) {
    try {
      const parsed: unknown = JSON.parse(searchTerms);
      terms = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
    } catch {
      terms = [searchTerms];
    }
  }
  return `${behavior} ${terms.join(" ")}`.trim();
}

const isZero = (v: Float32Array): boolean => {
  for (const x of v) if (x !== 0) return false;
  return true;
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface CodeCandidate {
  contentKey: string;
  symbol: SymbolRecord;
  path: string;
  priority: number;
}

/**
 * Function-like, non-sensitive symbols with `stmtCount >= MIN_CODE_STMTS`, one per contentKey (best backlog
 * priority wins, then the lowest symbol id), not yet in `vec_code`, ordered by backlog priority (exported and
 * entry-file functions first), then path, then symbol id, so each file is read once per priority level.
 * `belowFloor` counts the distinct contentKeys that are under the floor everywhere.
 */
export function missingCode(store: Store, have: Set<string>): { list: CodeCandidate[]; belowFloor: number } {
  const paths = new Map(store.effectiveFiles().map((f) => [f.id, f.path]));
  const best = new Map<string, CodeCandidate>();
  const small = new Set<string>();
  const symbols = store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] });
  for (const symbol of symbols.sort((a, b) => cmp(a.id, b.id))) {
    if (symbol.exactHash === "") continue;
    const key = contentKey(symbol.exactHash);
    if (symbol.stmtCount < MIN_CODE_STMTS) {
      small.add(key);
      continue;
    }
    const path = paths.get(symbol.fileId) ?? pathOfFileId(symbol.fileId);
    if (isSensitive(path)) continue;
    const priority = backlogPriority(symbol.kind, symbol.exported, path);
    const prev = best.get(key);
    if (!prev || priority < prev.priority) best.set(key, { contentKey: key, symbol, path, priority });
  }
  const belowFloor = [...small].filter((k) => !best.has(k)).length;
  const list = [...best.values()]
    .filter((c) => !have.has(c.contentKey))
    .sort((a, b) => a.priority - b.priority || cmp(a.path, b.path) || cmp(a.symbol.id, b.symbol.id));
  return { list, belowFloor };
}

/** Normalized, truncated source of a candidate. Reads and parses one file at a time (candidates are grouped by path). */
function makeCodeText(root: string): (c: CodeCandidate) => string | null {
  let cached: { path: string; source: string; parsed: ReturnType<typeof parseSource> } | null = null;
  return (c) => {
    if (cached?.path !== c.path) {
      cached = null;
      try {
        const source = readFileSync(join(root, c.path), "utf8");
        cached = { path: c.path, source, parsed: parseSource(c.path, source) };
      } catch {
        return null;
      }
    }
    const range = cached.parsed.bodies.get(c.symbol.id);
    if (!range) return null;
    const text = normalizeForEmbedding(cached.source, range, c.path.endsWith(".tsx") ? "tsx" : "ts");
    return text === "" ? null : text.slice(0, CODE_EMBED_MAX_CHARS);
  };
}

interface Phase {
  name: "descriptions" | "code";
  table: VecTable;
  kind: "document" | "code";
  size: number;
  item: (i: number) => { contentKey: string; text: string | null };
}

/**
 * Embeds what is missing, resumably: descriptions without a row in `vec_descriptions` (text = behavior +
 * search terms), then function-like symbols with `stmtCount >= MIN_CODE_STMTS` without a row in `vec_code`
 * (text = normalized code cut to `CODE_EMBED_MAX_CHARS`), most useful first (backlog priority). Work goes in
 * batches of `batchSize`; each batch is embedded and committed before the next starts, so an interruption
 * or error loses at most the batch in flight and the next call resumes with whatever is not stored yet.
 * Stops at `limit` vectors, when `timeBudgetMs` is used up, or on `signal`. Does nothing (and never loads
 * the model) when sqlite-vec is unavailable or nothing is missing; stores nothing when the model cannot be
 * loaded. If `meta.embed_model` or `meta.embed_dim` differs from the embedder, both tables are rebuilt
 * empty first, so everything is re-embedded.
 */
export async function embedPending(
  store: Store,
  opts: EmbedPendingOptions = {},
): Promise<EmbedPendingResult> {
  const result: EmbedPendingResult = {
    descriptions: 0,
    code: 0,
    remaining: 0,
    remainingDescriptions: 0,
    remainingCode: 0,
    belowFloor: 0,
    ms: { descriptions: 0, code: 0 },
    stoppedBy: "complete",
  };
  if (!vecAvailable(store)) return { ...result, stoppedBy: "unavailable" };
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const batchSize = Math.max(1, opts.batchSize ?? EMBED_BATCH_SIZE);
  ensureVecTables(store, opts.embedder?.dim ?? EMBED_DIM, opts.embedder?.modelId ?? EMBED_MODEL_ID);

  const haveDesc = storedKeys(store, "vec_descriptions");
  const descRows = (
    store.db
      .prepare("SELECT content_key, behavior, search_terms FROM descriptions ORDER BY content_key")
      .all() as { content_key: string; behavior: string; search_terms: string | null }[]
  )
    .filter((r) => !haveDesc.has(r.content_key))
    .map((r) => ({ contentKey: r.content_key, text: descriptionText(r.behavior, r.search_terms) }));

  let codeList: CodeCandidate[] = [];
  let codeText: ((c: CodeCandidate) => string | null) | null = null;
  if (opts.root !== undefined) {
    const m = missingCode(store, storedKeys(store, "vec_code"));
    codeList = m.list;
    result.belowFloor = m.belowFloor;
    codeText = makeCodeText(opts.root);
  }
  result.remainingDescriptions = descRows.length;
  result.remainingCode = codeList.length;
  result.remaining = descRows.length + codeList.length;
  if (result.remaining === 0) return result;

  const total = Math.min(limit, result.remaining);
  const embedder = opts.embedder ?? (await getEmbedder());
  let lastBatchMs = 0;
  let done = 0;

  const phases: Phase[] = [
    {
      name: "descriptions",
      table: "vec_descriptions",
      kind: "document",
      size: descRows.length,
      item: (i) => descRows[i] as { contentKey: string; text: string },
    },
    {
      name: "code",
      table: "vec_code",
      kind: "code",
      size: codeList.length,
      item: (i) => {
        const c = codeList[i] as CodeCandidate;
        return { contentKey: c.contentKey, text: codeText ? codeText(c) : null };
      },
    },
  ];

  for (const ph of phases) {
    const phaseTotal = Math.min(ph.size, Math.max(0, total - done));
    let phaseDone = 0;
    let cursor = 0;
    const phaseStart = now();
    while (cursor < ph.size) {
      if (done >= limit) {
        result.stoppedBy = "limit";
        return result;
      }
      if (opts.signal?.aborted) {
        result.stoppedBy = "aborted";
        return result;
      }
      if (opts.timeBudgetMs !== undefined && now() - t0 + lastBatchMs > opts.timeBudgetMs) {
        result.stoppedBy = "budget";
        return result;
      }
      const batch: { contentKey: string; text: string }[] = [];
      const room = Math.min(batchSize, limit - done);
      while (cursor < ph.size && batch.length < room) {
        const it = ph.item(cursor++);
        if (it.text === null) {
          // Unreadable, no body or empty after normalization: skipped now, retried by the next run.
          if (ph.name === "code") {
            result.remainingCode--;
            result.remaining--;
          }
          continue;
        }
        batch.push({ contentKey: it.contentKey, text: it.text });
      }
      if (batch.length === 0) continue;
      const tb = now();
      const vectors = await embedder.embed(
        batch.map((b) => b.text),
        ph.kind,
      );
      // The offline embedder returns zeros: never store them (a zero vector has no cosine distance).
      const rows = batch
        .map((b, j) => ({ contentKey: b.contentKey, vector: vectors[j] as Float32Array }))
        .filter((r) => r.vector && !isZero(r.vector));
      if (rows.length === 0) {
        result.stoppedBy = "unavailable";
        return result;
      }
      putVectors(store, ph.table, rows);
      lastBatchMs = now() - tb;
      done += rows.length;
      phaseDone += rows.length;
      result.remaining -= rows.length;
      if (ph.name === "descriptions") {
        result.descriptions += rows.length;
        result.remainingDescriptions -= rows.length;
      } else {
        result.code += rows.length;
        result.remainingCode -= rows.length;
      }
      result.ms[ph.name] += now() - tb;
      opts.onProgress?.({
        phase: ph.name,
        done,
        total,
        phaseDone,
        phaseTotal,
        elapsedMs: now() - t0,
        phaseElapsedMs: now() - phaseStart,
      });
    }
  }
  result.stoppedBy = result.remaining === 0 ? "complete" : done >= limit ? "limit" : "complete";
  return result;
}
