import type { Store } from "../store/index.js";
import type { FactSheet } from "../types.js";
import { readFileSource, type SourceContext } from "./backlog.js";
import { buildFactSheet, contentKey, SensitivePathError } from "./factsheet.js";
import { fallbackDescription } from "./fallback.js";
import { type FeedbackField, rejectionFeedback } from "./feedback.js";
import {
  type AcceptedDescription,
  MAX_DESCRIBE_ATTEMPTS_EXTENDED,
  recordDescribeFailure,
  storeDescriptions,
} from "./store.js";
import { rejectionTainted, validateDescription } from "./validate.js";

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
  /** A validator reason (`schema`, `length`, `shape`, `identifier`, `injection`, `secret`) or `not_in_batch`, `attempts_exhausted`, `duplicate`, `stale`, `unavailable`. */
  reason: string;
  /**
   * The validator's detail, for `last_error` and tests only: it can echo part of a token, so it never leaves the
   * host (the MCP answer carries `rule` and `fix` instead).
   */
  detail?: string;
  /** Validator rejections: the sub-rule that fired (a fixed code such as `shape.first-word`), never matched text. */
  rule?: string;
  /** Validator rejections: the field the rule fired on. */
  field?: FeedbackField;
  /** Validator rejections: a fixed rewrite instruction for that rule (`rejectionFeedback`). */
  fix?: string;
  /** Validator rejections: true while the function is still in the batch with an attempt left, so a rewrite counts. */
  resubmit?: boolean;
  /** True when the function used its last attempt and the host stored a fallback description instead (#150). */
  fallback?: boolean;
}

export interface SubmitResult {
  accepted: number;
  rejected: SubmitRejection[];
  /** False when no claimed row carries this batch id (unknown, expired and released, or already finished). */
  batchKnown: boolean;
  /** Content keys that were accepted, in submission order. */
  acceptedKeys: string[];
  /** Functions that got a fallback description (provenance `fallback`) after their last rejection. */
  fallbacks: number;
  /** Content keys that got a fallback description, in submission order. */
  fallbackKeys: string[];
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

/** Content keys of `batchId` that used up their attempts (`failed` rows keep `claimed_by`, see `recordDescribeFailure`). */
function failedInBatch(store: Store, batchId: string): Set<string> {
  const suffix = `:${batchId}`;
  const rows = store.db
    .prepare("SELECT content_key, claimed_by FROM backlog WHERE status = 'failed' AND claimed_by IS NOT NULL")
    .all() as { content_key: string; claimed_by: string }[];
  return new Set(
    rows
      .filter((r) => r.claimed_by.length > suffix.length && r.claimed_by.endsWith(suffix))
      .map((r) => r.content_key),
  );
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
    const rel = sym.fileId;
    if (!files.has(rel)) files.set(rel, readFileSource(store, rel, ctx));
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
 * an attempt, records `last_error` and stays claimed in this batch, so a corrected resubmit under the same `batchId`
 * is checked again (#147), or becomes `failed` at its attempt limit (a later resubmit is then `attempts_exhausted`).
 * Each validator rejection carries a fixed rule code and rewrite instruction (`rejectionFeedback`, #150). A function
 * that fails its third (extra) attempt on `shape` or `identifier` gets a deterministic fallback description instead
 * (`fallbackDescription`, provenance `fallback`) when one passes the validator; otherwise it stays `failed`. Items of the batch that are not mentioned stay claimed. One `usage_log` row is written per
 * call.
 */
export function submitDescriptions(
  store: Store,
  batchId: string,
  results: SubmitItem[],
  ctx: SourceContext = {},
): SubmitResult {
  const rows = new Map(claimedInBatch(store, batchId).map((r) => [r.content_key, r]));
  const exhausted = failedInBatch(store, batchId);
  const out: SubmitResult = {
    accepted: 0,
    rejected: [],
    batchKnown: rows.size > 0 || exhausted.size > 0,
    acceptedKeys: [],
    fallbacks: 0,
    fallbackKeys: [],
  };
  const seen = new Set<string>();
  const files = new Map<string, string | undefined>();
  const reject = (key: string, reason: string, detail?: string) =>
    out.rejected.push({ contentKey: key, reason, ...(detail ? { detail: cap(detail, DETAIL_MAX) } : {}) });

  const dropRow = store.db.prepare("DELETE FROM backlog WHERE content_key = ?");
  const toPending = store.db.prepare(
    "UPDATE backlog SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE content_key = ?",
  );
  const accepted: AcceptedDescription[] = [];
  const fallbacks: { description: AcceptedDescription; rejection: SubmitRejection }[] = [];
  for (const item of results) {
    const key = item.contentKey;
    if (seen.has(key)) {
      reject(key, "duplicate");
      continue;
    }
    seen.add(key);
    const row = rows.get(key);
    if (!row) {
      reject(key, exhausted.has(key) ? "attempts_exhausted" : "not_in_batch");
      continue;
    }
    const sym = store.getSymbol(row.symbol_id);
    if (!sym || contentKey(sym.exactHash) !== key) {
      dropRow.run(key); // the code changed since the claim: this key is obsolete
      reject(key, "stale");
      continue;
    }
    const rel = sym.fileId;
    if (!files.has(rel)) files.set(rel, readFileSource(store, rel, ctx));
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
      // Only a wording rejection of text with no secret or injection signal in any field earns the extra attempt
      // and, after it, the fallback (#150, #175).
      const tainted = rejectionTainted(v, item.description, sheet);
      const extendable = (v.reason === "shape" || v.reason === "identifier") && !tainted;
      const now = recordDescribeFailure(store, key, `${v.reason}: ${cap(v.detail, DETAIL_MAX)}`, {
        keepClaim: true,
        extendable,
        tainted,
        batchId,
      });
      // The row left this batch between the membership check above and the write: nothing was counted.
      if (now.attempts === 0) {
        reject(key, "not_in_batch");
        continue;
      }
      const fb = rejectionFeedback(v.reason, v.detail);
      // The extended budget is used up on a wording rule: describe it from trusted data, if the validator agrees.
      const fallback =
        now.failed && now.attempts >= MAX_DESCRIBE_ATTEMPTS_EXTENDED && extendable
          ? fallbackDescription(sym, sheet)
          : null;
      const rejection: SubmitRejection = {
        contentKey: key,
        reason: v.reason,
        detail: cap(v.detail, DETAIL_MAX),
        ...(fb ? { rule: fb.rule, field: fb.field, fix: fb.fix } : {}),
        resubmit: !now.failed,
      };
      out.rejected.push(rejection);
      if (fallback !== null)
        fallbacks.push({
          description: { contentKey: key, description: fallback, model: null, provenance: "fallback" },
          rejection,
        });
      continue;
    }
    accepted.push({ contentKey: key, description: v.value, model: SUBMIT_MODEL });
    out.accepted++;
    out.acceptedKeys.push(key);
  }

  storeDescriptions(store, accepted, { replace: true });
  // A fallback never replaces a description that exists (a concurrent model description wins, #175).
  for (const f of fallbacks) {
    if (storeDescriptions(store, [f.description], { replace: false }) === 0) continue;
    f.rejection.fallback = true;
    out.fallbacks++;
    out.fallbackKeys.push(f.description.contentKey);
  }
  store.db
    .prepare(
      `INSERT INTO usage_log(at, task, model, effort, functions, input_tokens, output_tokens, cost_estimate_usd, source)
       VALUES (?, 'describe.sync', ?, NULL, ?, NULL, NULL, NULL, 'subagent')`,
    )
    .run(new Date().toISOString(), SUBMIT_MODEL, out.accepted + out.rejected.length);
  return out;
}
