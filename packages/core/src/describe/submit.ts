import fs from "node:fs";
import path from "node:path";
import { refreshDescriptionFts } from "../search/descfts.js";
import type { Store } from "../store/index.js";
import type { FactSheet } from "../types.js";
import type { SourceContext } from "./backlog.js";
import { buildFactSheet, contentKey, PROMPT_MAJOR, pathOfFileId, SensitivePathError } from "./factsheet.js";
import { validateDescription } from "./validate.js";

/** A function whose description failed validation this many times is parked as `failed` (spec section 8: `describe.retry`). */
export const MAX_DESCRIBE_ATTEMPTS = 2;
/** Model name written for descriptions that arrive through the describer tools. */
export const SUBMIT_MODEL = "haiku";
const DETAIL_MAX = 120;
const UUID_LEN = 36;

export interface SubmitItem {
  contentKey: string;
  /** Whatever the model wrote; `validateDescription` decides if it is a description. */
  description: unknown;
}

export interface SubmitRejection {
  contentKey: string;
  /** A validator reason (`schema`, `length`, `shape`, `identifier`, `injection`, `secret`) or `not_in_batch`, `duplicate`, `stale`, `unavailable`. */
  reason: string;
  /** Rule names from the validator, never matched text; cut to a short length. */
  detail?: string;
}

export interface SubmitResult {
  accepted: number;
  rejected: SubmitRejection[];
  /** False when no claimed row carries this batch id (unknown, expired and released, or already finished). */
  batchKnown: boolean;
  /** Content keys that were accepted, in submission order. */
  acceptedKeys: string[];
}

interface ClaimedRow {
  content_key: string;
  symbol_id: string;
  priority: number;
  attempts: number | null;
  claimed_by: string;
  claimed_at: string | null;
}

const byPriority = (a: ClaimedRow, b: ClaimedRow): number =>
  a.priority - b.priority || (a.symbol_id < b.symbol_id ? -1 : a.symbol_id > b.symbol_id ? 1 : 0);

/** Claimed rows that belong to `batchId` (`claimed_by` is `${workerId}:${batchId}`). */
function claimedInBatch(store: Store, batchId: string): ClaimedRow[] {
  const suffix = `:${batchId}`;
  return (
    store.db
      .prepare(
        `SELECT content_key, symbol_id, priority, attempts, claimed_by, claimed_at FROM backlog
         WHERE status = 'claimed' AND claimed_by IS NOT NULL ORDER BY priority, symbol_id`,
      )
      .all() as ClaimedRow[]
  ).filter((r) => r.claimed_by.length > suffix.length && r.claimed_by.endsWith(suffix));
}

function readSource(store: Store, rel: string, ctx: SourceContext): string | undefined {
  const mem = ctx.sources?.get(rel);
  if (mem !== undefined) return mem;
  const root = ctx.root ?? store.getMeta("repo_root");
  if (root === undefined) return undefined;
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The oldest batch this worker claimed and has not submitted, or `null`. Its still-claimed rows are returned as
 * fact sheets (up to `size`) under the same batch id, so a worker that lost its batch (two `claim` calls in a row,
 * a subagent that never submitted) gets the same work again before anything new is claimed. The claim clock is not
 * restarted: a batch nobody submits expires after `CLAIM_TTL_MS` from its first claim. Call `releaseExpiredClaims`
 * first. Rows that cannot yield a sheet any more are dropped; rows whose file cannot be read are skipped.
 */
export function reissueBatch(
  store: Store,
  workerId: string,
  size: number,
  ctx: SourceContext = {},
): { batchId: string; items: FactSheet[] } | null {
  if (size <= 0) return null;
  const prefix = `${workerId}:`;
  const rows = (
    store.db
      .prepare(
        `SELECT content_key, symbol_id, priority, attempts, claimed_by, claimed_at FROM backlog
         WHERE status = 'claimed' AND claimed_by IS NOT NULL ORDER BY claimed_at, claimed_by, priority, symbol_id`,
      )
      .all() as ClaimedRow[]
  ).filter((r) => r.claimed_by.length === prefix.length + UUID_LEN && r.claimed_by.startsWith(prefix));
  const first = rows[0];
  if (!first) return null;
  const batchId = first.claimed_by.slice(prefix.length);
  const items: FactSheet[] = [];
  const drop = store.db.prepare("DELETE FROM backlog WHERE content_key = ?");
  const files = new Map<string, string | undefined>();
  for (const row of rows.filter((r) => r.claimed_by === first.claimed_by).sort(byPriority)) {
    if (items.length >= size) break;
    const sym = store.getSymbol(row.symbol_id);
    if (!sym || contentKey(sym.exactHash) !== row.content_key) {
      drop.run(row.content_key);
      continue;
    }
    const rel = pathOfFileId(sym.fileId);
    if (!files.has(rel)) files.set(rel, readSource(store, rel, ctx));
    const source = files.get(rel);
    if (source === undefined) continue;
    try {
      items.push(buildFactSheet(store, sym.id, source));
    } catch (err) {
      if (err instanceof SensitivePathError) drop.run(row.content_key);
    }
  }
  return { batchId, items };
}

/**
 * Puts these items of `batchId` back to `pending` (for example sheets that did not fit in a response), so they are
 * claimed again later instead of waiting for the claim to expire. Returns how many rows changed.
 */
export function releaseBatchItems(store: Store, batchId: string, contentKeys: string[]): number {
  if (contentKeys.length === 0) return 0;
  const wanted = new Set(contentKeys);
  const mine = claimedInBatch(store, batchId).filter((r) => wanted.has(r.content_key));
  const release = store.db.prepare(
    "UPDATE backlog SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE content_key = ? AND status = 'claimed'",
  );
  return store.tx(() => {
    let n = 0;
    for (const r of mine) n += release.run(r.content_key).changes;
    return n;
  });
}

const cap = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * Handles a describer's results for one claimed batch (spec sections 8 and 15). Per result: the content key must
 * belong to the batch; the description goes through `validateDescription` against a freshly built fact sheet; an
 * accepted one is stored (`provenance` model, model `haiku`, `PROMPT_MAJOR`), its backlog row deleted and the FTS
 * `behavior`, `search_terms` and `suggested_name` of every symbol with that content key updated; a rejected one adds
 * an attempt, records `last_error` and returns to `pending` (or `failed` after `MAX_DESCRIBE_ATTEMPTS`). Items of the
 * batch that are not mentioned stay claimed. One `usage_log` row is written per call.
 */
export function submitDescriptions(
  store: Store,
  batchId: string,
  results: SubmitItem[],
  ctx: SourceContext = {},
): SubmitResult {
  const rows = new Map(claimedInBatch(store, batchId).map((r) => [r.content_key, r]));
  const out: SubmitResult = { accepted: 0, rejected: [], batchKnown: rows.size > 0, acceptedKeys: [] };
  const seen = new Set<string>();
  const files = new Map<string, string | undefined>();
  const reject = (key: string, reason: string, detail?: string) =>
    out.rejected.push({ contentKey: key, reason, ...(detail ? { detail: cap(detail, DETAIL_MAX) } : {}) });

  const dropRow = store.db.prepare("DELETE FROM backlog WHERE content_key = ?");
  const toPending = store.db.prepare(
    "UPDATE backlog SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE content_key = ?",
  );
  const failRow = store.db.prepare(
    `UPDATE backlog SET attempts = ?, last_error = ?, status = ?, claimed_by = NULL, claimed_at = NULL
     WHERE content_key = ?`,
  );
  const insertDescription = store.db.prepare(
    `INSERT OR REPLACE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
       provenance, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, 'model', ?, ?, ?)`,
  );

  const stored: { key: string; behavior: string; terms: string; suggested: string }[] = [];
  for (const item of results) {
    const key = item.contentKey;
    if (seen.has(key)) {
      reject(key, "duplicate");
      continue;
    }
    seen.add(key);
    const row = rows.get(key);
    if (!row) {
      reject(key, "not_in_batch");
      continue;
    }
    const sym = store.getSymbol(row.symbol_id);
    if (!sym || contentKey(sym.exactHash) !== key) {
      dropRow.run(key); // the code changed since the claim: this key is obsolete
      reject(key, "stale");
      continue;
    }
    const rel = pathOfFileId(sym.fileId);
    if (!files.has(rel)) files.set(rel, readSource(store, rel, ctx));
    const source = files.get(rel);
    let sheet: FactSheet | undefined;
    if (source !== undefined) {
      try {
        sheet = buildFactSheet(store, sym.id, source);
      } catch (err) {
        if (err instanceof SensitivePathError) {
          dropRow.run(key);
          reject(key, "stale");
          continue;
        }
      }
    }
    if (!sheet) {
      toPending.run(key); // not the describer's fault: no attempt is counted
      reject(key, "unavailable");
      continue;
    }

    const v = validateDescription(item.description, sheet);
    if (!v.ok) {
      const attempts = (row.attempts ?? 0) + 1;
      failRow.run(
        attempts,
        `${v.reason}: ${cap(v.detail, DETAIL_MAX)}`,
        attempts >= MAX_DESCRIBE_ATTEMPTS ? "failed" : "pending",
        key,
      );
      reject(key, v.reason, v.detail);
      continue;
    }
    const d = v.value;
    store.tx(() => {
      insertDescription.run(
        key,
        d.behavior,
        JSON.stringify(d.searchTerms),
        d.nameFits ? 1 : 0,
        d.suggestedName ?? null,
        SUBMIT_MODEL,
        PROMPT_MAJOR,
        new Date().toISOString(),
      );
      dropRow.run(key);
    });
    stored.push({
      key,
      behavior: d.behavior,
      terms: d.searchTerms.join(" "),
      suggested: d.suggestedName ?? "",
    });
    out.accepted++;
    out.acceptedKeys.push(key);
  }

  refreshDescriptionFts(store, { keys: new Set(stored.map((s) => s.key)) });
  store.db
    .prepare(
      `INSERT INTO usage_log(at, task, model, effort, functions, input_tokens, output_tokens, cost_estimate_usd, source)
       VALUES (?, 'describe.sync', ?, NULL, ?, NULL, NULL, NULL, 'subagent')`,
    )
    .run(new Date().toISOString(), SUBMIT_MODEL, out.accepted + out.rejected.length);
  return out;
}
