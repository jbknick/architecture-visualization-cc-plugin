import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSensitive } from "../discover/index.js";
import { hashSymbol } from "../hash/index.js";
import { type ParsedFile, parseSource } from "../parse/index.js";
import type { Store } from "../store/index.js";
import type { Description, FactSheet, SymbolRecord } from "../types.js";
import {
  buildFactSheet,
  contentKey,
  FUNCTION_LIKE_KINDS,
  PROMPT_MAJOR,
  pathOfFileId,
  SensitivePathError,
} from "./factsheet.js";
import { templateFor } from "./templates.js";

/** A claimed batch that was not submitted within this time goes back to `pending`. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;
/** Measured in M0 (spec section 10): tokens per function with the p1 prompt on Haiku. */
export const INPUT_TOKENS_PER_FUNCTION = 950;
export const OUTPUT_TOKENS_PER_FUNCTION = 250;
export const BATCH_SIZE = 40;
export const BATCHES_PER_ROUND = 4;
/** Measured in M0: sequential headless worker time per function. */
export const SECONDS_PER_FUNCTION_SEQUENTIAL = 0.96;

const ENTRY_FILE = /(^|\/)(routes?|pages?|app|api)\/|(^|\/)(index|main|server|entry|router)\.[cm]?[jt]sx?$/;

/** Backlog priority (spec section 9): exported functions and route/entry files 0, other exported 1, local 2. */
export function backlogPriority(kind: string, exported: boolean, filePath: string): number {
  if (ENTRY_FILE.test(filePath)) return 0;
  if (!exported) return 2;
  return kind === "method" ? 1 : 0;
}

/** Where to read file text from. `sources` (repo-relative path -> text) wins over `root`. */
export interface SourceContext {
  /** Repo root. Default: `meta.repo_root`, which the indexer records. */
  root?: string;
  sources?: Map<string, string>;
}

export interface SyncOptions extends SourceContext {
  /** Sync only these symbols (for example the staged ones in pre-commit); no stale rows are pruned then. */
  symbols?: SymbolRecord[];
}

export interface BacklogSyncResult {
  enqueued: number;
  templated: number;
  alreadyDescribed: number;
}

export interface Estimate {
  functionLike: number;
  templated: number;
  toDescribe: number;
  inputTokens: number;
  outputTokens: number;
  batches: number;
  rounds: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const langOf = (p: string): "ts" | "tsx" => (p.endsWith(".tsx") ? "tsx" : "ts");

function rootOf(store: Store, ctx: SourceContext): string | undefined {
  return ctx.root ?? store.getMeta("repo_root");
}

function readSource(root: string | undefined, rel: string, ctx: SourceContext): string | undefined {
  const mem = ctx.sources?.get(rel);
  if (mem !== undefined) return mem;
  if (root === undefined) return undefined;
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return undefined;
  }
}

interface Candidate {
  sym: SymbolRecord;
  path: string;
  priority: number;
}

/** Function-like, non-sensitive symbols grouped by contentKey; the best (lowest priority, then id) wins. */
function groupByKey(symbols: SymbolRecord[]): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const sym of [...symbols].sort((a, b) => cmp(a.id, b.id))) {
    if (!FUNCTION_LIKE_KINDS.includes(sym.kind) || sym.exactHash === "") continue;
    const p = pathOfFileId(sym.fileId);
    if (isSensitive(p)) continue;
    const priority = backlogPriority(sym.kind, sym.exported, p);
    const key = contentKey(sym.exactHash);
    const prev = out.get(key);
    if (!prev || priority < prev.priority) out.set(key, { sym, path: p, priority });
  }
  return out;
}

/** Templates for the candidates that qualify, reading each file once and checking it still matches the index. */
function computeTemplates(
  store: Store,
  todo: [string, Candidate][],
  ctx: SourceContext,
): Map<string, Description> {
  const root = rootOf(store, ctx);
  const byPath = new Map<string, [string, Candidate][]>();
  for (const item of todo) {
    if (item[1].sym.stmtCount !== 1) continue; // only one-statement functions can have a template
    const a = byPath.get(item[1].path) ?? [];
    a.push(item);
    byPath.set(item[1].path, a);
  }
  const out = new Map<string, Description>();
  for (const [p, items] of [...byPath].sort((a, b) => cmp(a[0], b[0]))) {
    const source = readSource(root, p, ctx);
    if (source === undefined) continue;
    let parsed: ParsedFile;
    try {
      parsed = parseSource(p, source);
    } catch {
      continue;
    }
    for (const [key, c] of items) {
      const range = parsed.bodies.get(c.sym.id);
      if (!range) continue;
      // The file may have changed since indexing; a template must describe the code the key was made from.
      if (hashSymbol(source, range, langOf(p)).exactHash !== c.sym.exactHash) continue;
      const d = templateFor(c.sym, parsed, source);
      if (d) out.set(key, d);
    }
  }
  return out;
}

/**
 * For every effective function-like symbol (or `opts.symbols`): skip it when `descriptions` has its contentKey,
 * insert a template description when one applies, else make sure a `pending` backlog row exists.
 * A full run also drops pending rows whose key no symbol has any more (moved or edited code).
 */
export function syncBacklog(store: Store, opts: SyncOptions = {}): BacklogSyncResult {
  const full = opts.symbols === undefined;
  const groups = groupByKey(opts.symbols ?? store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] }));

  const hasDescription = store.db.prepare("SELECT 1 FROM descriptions WHERE content_key = ?");
  const describedKeys = new Set<string>();
  const todo: [string, Candidate][] = [];
  for (const [key, c] of groups) {
    if (hasDescription.get(key)) describedKeys.add(key);
    else todo.push([key, c]);
  }
  const templates = computeTemplates(store, todo, opts);

  const insertDescription = store.db.prepare(
    `INSERT OR IGNORE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
       provenance, model, prompt_version, created_at) VALUES (?, ?, ?, ?, NULL, 'template', NULL, ?, ?)`,
  );
  const backlogRow = store.db.prepare("SELECT status FROM backlog WHERE content_key = ?");
  const insertBacklog = store.db.prepare(
    "INSERT INTO backlog(content_key, symbol_id, priority, status) VALUES (?, ?, ?, 'pending')",
  );
  const updateBacklog = store.db.prepare(
    "UPDATE backlog SET symbol_id = ?, priority = ? WHERE content_key = ? AND status = 'pending'",
  );
  const dropUnclaimed = store.db.prepare("DELETE FROM backlog WHERE content_key = ? AND status != 'claimed'");

  const result: BacklogSyncResult = { enqueued: 0, templated: 0, alreadyDescribed: describedKeys.size };
  const now = new Date().toISOString();
  store.tx(() => {
    for (const key of describedKeys) dropUnclaimed.run(key);
    for (const [key, c] of todo) {
      const tpl = templates.get(key);
      if (tpl) {
        const r = insertDescription.run(
          key,
          tpl.behavior,
          JSON.stringify(tpl.searchTerms),
          tpl.nameFits ? 1 : 0,
          PROMPT_MAJOR,
          now,
        );
        result.templated += r.changes;
        dropUnclaimed.run(key);
        continue;
      }
      const row = backlogRow.get(key) as { status: string } | undefined;
      if (!row) {
        insertBacklog.run(key, c.sym.id, c.priority);
        result.enqueued++;
      } else if (row.status === "pending") {
        updateBacklog.run(c.sym.id, c.priority, key);
      }
    }
    if (full) {
      const stale = store.db.prepare("SELECT content_key FROM backlog WHERE status = 'pending'").all() as {
        content_key: string;
      }[];
      for (const { content_key } of stale) {
        if (!groups.has(content_key)) {
          store.db.prepare("DELETE FROM backlog WHERE content_key = ?").run(content_key);
        }
      }
    }
  });
  return result;
}

/** Puts claims older than `CLAIM_TTL_MS` back to `pending`. Returns how many were released. */
export function releaseExpiredClaims(store: Store, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  return store.tx(
    () =>
      store.db
        .prepare(
          `UPDATE backlog SET status = 'pending', claimed_by = NULL, claimed_at = NULL
           WHERE status = 'claimed' AND claimed_at <= ?`,
        )
        .run(cutoff).changes,
  );
}

/**
 * Claims up to `size` pending items (lowest priority number first, then symbol id) in one `BEGIN IMMEDIATE`
 * transaction and returns their fact sheets. `backlog.claimed_by` is `${workerId}:${batchId}`.
 * Rows that cannot yield a sheet any more (symbol gone or edited, sensitive path) are dropped; rows whose
 * file cannot be read stay pending.
 */
export function claimBatch(
  store: Store,
  workerId: string,
  size: number,
  ctx: SourceContext = {},
): { batchId: string; items: FactSheet[] } {
  const batchId = randomUUID();
  const items: FactSheet[] = [];
  if (size <= 0) return { batchId, items };
  const root = rootOf(store, ctx);
  store.tx(() => {
    releaseExpiredClaims(store);
    const page = Math.max(size * 3, 50);
    const select = store.db.prepare(
      "SELECT content_key, symbol_id FROM backlog WHERE status = 'pending' ORDER BY priority, symbol_id LIMIT ? OFFSET ?",
    );
    const claim = store.db.prepare(
      "UPDATE backlog SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE content_key = ?",
    );
    const drop = store.db.prepare("DELETE FROM backlog WHERE content_key = ?");
    const claimedBy = `${workerId}:${batchId}`;
    const at = new Date().toISOString();
    const files = new Map<string, string | undefined>();
    let kept = 0; // pending rows we skipped over; they stay at the front of the ordering
    for (;;) {
      const rows = select.all(page, kept) as { content_key: string; symbol_id: string }[];
      for (const row of rows) {
        if (items.length >= size) break;
        const sym = store.getSymbol(row.symbol_id);
        if (!sym || contentKey(sym.exactHash) !== row.content_key) {
          drop.run(row.content_key);
          continue;
        }
        const rel = pathOfFileId(sym.fileId);
        if (!files.has(rel)) files.set(rel, readSource(root, rel, ctx));
        const source = files.get(rel);
        if (source === undefined) {
          kept++;
          continue;
        }
        let sheet: FactSheet;
        try {
          sheet = buildFactSheet(store, sym.id, source);
        } catch (err) {
          if (err instanceof SensitivePathError) drop.run(row.content_key);
          else kept++;
          continue;
        }
        claim.run(claimedBy, at, row.content_key);
        items.push(sheet);
      }
      if (items.length >= size || rows.length < page) break;
    }
  });
  return { batchId, items };
}

/**
 * Counts and the token projection for describing what is left (spec section 10), over distinct contentKeys of
 * effective function-like symbols. `toDescribe` is every key without a description, so run `syncBacklog` first
 * to count templates. `exportsFirst` keeps only priority 0 and 1.
 */
export function estimate(store: Store, opts: { exportsFirst?: boolean } = {}): Estimate {
  const groups = groupByKey(store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] }));
  const provenance = store.db.prepare("SELECT provenance FROM descriptions WHERE content_key = ?");
  let functionLike = 0;
  let templated = 0;
  let toDescribe = 0;
  for (const [key, c] of groups) {
    if (opts.exportsFirst && c.priority > 1) continue;
    functionLike++;
    const row = provenance.get(key) as { provenance: string | null } | undefined;
    if (!row) toDescribe++;
    else if (row.provenance === "template") templated++;
  }
  const batches = Math.ceil(toDescribe / BATCH_SIZE);
  return {
    functionLike,
    templated,
    toDescribe,
    inputTokens: INPUT_TOKENS_PER_FUNCTION * toDescribe,
    outputTokens: OUTPUT_TOKENS_PER_FUNCTION * toDescribe,
    batches,
    rounds: Math.ceil(batches / BATCHES_PER_ROUND),
  };
}
