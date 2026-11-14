import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeForEmbedding } from "../hash/index.js";
import { parseSource } from "../parse/index.js";
import type { Store } from "../store/index.js";
import type { SymbolKind, SymbolRecord } from "../types.js";
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
  type Embedder,
  type EmbedKind,
  getEmbedder,
  loadEmbedder,
  modelCacheDir,
  offlineEmbedder,
  resetEmbedderForTests,
} from "./model.js";
export {
  applyVecMigration,
  blobToVec,
  EMBED_DIM,
  EMBED_MODEL_ID,
  ensureVecTables,
  knn,
  loadVec,
  putVectors,
  storedKeys,
  type VecTable,
  vecAvailable,
  vecToBlob,
} from "./vec.js";

const FUNCTION_LIKE: SymbolKind[] = ["function", "method", "component", "hook"];
/** Functions with fewer statements are not compared by the code_vector tier (spec section 17). */
export const MIN_CODE_STMTS = 6;
/** Rows embedded per call when called lazily from a query, so a search stays fast. */
export const LAZY_EMBED_LIMIT = 200;
/** Must equal `PROMPT_MAJOR` of the describe module (spec section 7: contentKey = `<exactHash>:<PROMPT_MAJOR>`). */
const PROMPT_MAJOR = "p1";

export interface EmbedPendingOptions {
  /** Maximum rows embedded per table in this call. */
  limit?: number;
  /** Worktree root: needed to read the source of the functions whose code is embedded. Without it only descriptions are embedded. */
  root?: string;
  /** Embedder to use instead of the shared one (tests, or a caller that already loaded it). */
  embedder?: Embedder;
}

export interface EmbedPendingResult {
  descriptions: number;
  code: number;
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

async function embedAll(
  store: Store,
  table: VecTable,
  items: { contentKey: string; text: string }[],
  embedder: Embedder,
  kind: "document" | "code",
): Promise<number> {
  let done = 0;
  for (let i = 0; i < items.length; i += EMBED_BATCH_SIZE) {
    const batch = items.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedder.embed(
      batch.map((b) => b.text),
      kind,
    );
    // The offline embedder returns zeros: never store them (a zero vector has no cosine distance).
    const rows = batch
      .map((b, j) => ({ contentKey: b.contentKey, vector: vectors[j] as Float32Array }))
      .filter((r) => r.vector && !isZero(r.vector));
    if (rows.length === 0) break;
    putVectors(store, table, rows);
    done += rows.length;
  }
  return done;
}

interface CodeCandidate {
  contentKey: string;
  symbol: SymbolRecord;
  path: string;
}

/** Function-like symbols with `stmtCount >= 6`, one per contentKey (the first by symbol id), not yet in `vec_code`. */
function missingCode(store: Store, have: Set<string>): CodeCandidate[] {
  const paths = new Map(store.effectiveFiles().map((f) => [f.id, f.path]));
  const seen = new Set<string>();
  const out: CodeCandidate[] = [];
  for (const symbol of store.effectiveSymbols({ kind: FUNCTION_LIKE })) {
    if (symbol.stmtCount < MIN_CODE_STMTS || symbol.exactHash === "") continue;
    const contentKey = `${symbol.exactHash}:${PROMPT_MAJOR}`;
    const path = paths.get(symbol.fileId);
    if (path === undefined || have.has(contentKey) || seen.has(contentKey)) continue;
    seen.add(contentKey);
    out.push({ contentKey, symbol, path });
  }
  return out;
}

/** Normalized source of each candidate, reading and parsing every file once. Unreadable files are skipped. */
function codeTexts(root: string, candidates: CodeCandidate[]): { contentKey: string; text: string }[] {
  const byPath = new Map<string, CodeCandidate[]>();
  for (const c of candidates) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  const out: { contentKey: string; text: string }[] = [];
  for (const [path, list] of byPath) {
    let source: string;
    try {
      source = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const parsed = parseSource(path, source);
    const lang = path.endsWith(".tsx") ? "tsx" : "ts";
    for (const c of list) {
      const range = parsed.bodies.get(c.symbol.id);
      if (!range) continue;
      const text = normalizeForEmbedding(source, range, lang);
      if (text !== "") out.push({ contentKey: c.contentKey, text });
    }
  }
  return out;
}

/**
 * Embeds what is missing: descriptions without a row in `vec_descriptions` (text = behavior + search
 * terms) and function-like symbols with `stmtCount >= 6` without a row in `vec_code` (text = normalized
 * code), in batches of 32. Returns the number of vectors written. No-op (zeros) when sqlite-vec is
 * unavailable or the model cannot be loaded. If `meta.embed_model` or `meta.embed_dim` differs from the
 * embedder, both tables are rebuilt empty first, so everything is re-embedded.
 */
export async function embedPending(
  store: Store,
  opts: EmbedPendingOptions = {},
): Promise<EmbedPendingResult> {
  const result: EmbedPendingResult = { descriptions: 0, code: 0 };
  if (!vecAvailable(store)) return result;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  ensureVecTables(store, opts.embedder?.dim ?? EMBED_DIM, opts.embedder?.modelId ?? EMBED_MODEL_ID);

  const haveDesc = storedKeys(store, "vec_descriptions");
  const descRows = (
    store.db
      .prepare("SELECT content_key, behavior, search_terms FROM descriptions ORDER BY content_key")
      .all() as {
      content_key: string;
      behavior: string;
      search_terms: string | null;
    }[]
  )
    .filter((r) => !haveDesc.has(r.content_key))
    .slice(0, limit)
    .map((r) => ({ contentKey: r.content_key, text: descriptionText(r.behavior, r.search_terms) }));

  const haveCode = storedKeys(store, "vec_code");
  const codeItems =
    opts.root === undefined ? [] : codeTexts(opts.root, missingCode(store, haveCode).slice(0, limit));

  if (descRows.length === 0 && codeItems.length === 0) return result;
  const embedder = opts.embedder ?? (await getEmbedder());
  result.descriptions = await embedAll(store, "vec_descriptions", descRows, embedder, "document");
  result.code = await embedAll(store, "vec_code", codeItems, embedder, "code");
  return result;
}
