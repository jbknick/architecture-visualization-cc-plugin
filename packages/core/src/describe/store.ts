// The one write path for model-written descriptions, used by `submitDescriptions` (MCP describer tools) and by the
// headless worker. Callers validate first (`validateDescription`); nothing here judges text.
import { refreshDescriptionFts } from "../search/descfts.js";
import type { Store } from "../store/index.js";
import type { Description } from "../types.js";
import { PROMPT_MAJOR } from "./factsheet.js";

/** A function whose description failed validation this many times is parked as `failed` (spec section 8: `describe.retry`). */
export const MAX_DESCRIBE_ATTEMPTS = 2;
/**
 * The bounded extra budget of #150: a function gets one more attempt (3 in all, never more) when its second rejection
 * was an extendable `shape` or `identifier` one (`extendableRejection` in validate.ts: no secret or injection signal in
 * any field, #175), and its first rejection was not `injection` or `secret` and carried no such signal either. Those
 * two rules are about wording, so a rewrite that follows the rule's `fix` usually passes; anything that looks like an
 * injection or a secret never earns another try.
 */
export const EXTRA_ATTEMPT_REASONS: ReadonlySet<string> = new Set(["shape", "identifier"]);
export const MAX_DESCRIBE_ATTEMPTS_EXTENDED = 3;
/** Reasons after which no extra attempt is given, even when a later rejection is `shape` or `identifier`. */
const NO_EXTRA_AFTER: ReadonlySet<string> = new Set(["injection", "secret"]);
/** Appended to `last_error` when the rejected text carried a secret or injection signal: no extra attempt follows it. */
export const NO_EXTRA_MARK = " [no-extra]";

/** The rule name at the head of a stored `last_error` (`<reason>: <detail>`), or "" for none. */
export function errorReason(lastError: string | null | undefined): string {
  if (!lastError) return "";
  const colon = lastError.indexOf(":");
  return (colon < 0 ? lastError : lastError.slice(0, colon)).trim();
}

/**
 * How many attempts a row may use (spec section 8), given its new attempt count, the reason of the failure being
 * recorded now, whether that rejected text is free of injection signals (`extendable`), and the stored `last_error`
 * of the failure before it: `MAX_DESCRIBE_ATTEMPTS`, or `MAX_DESCRIBE_ATTEMPTS_EXTENDED` when the second failure is
 * an extendable `shape`/`identifier` one and the first was neither `injection` nor `secret` nor marked `[no-extra]`.
 */
export function describeAttemptLimit(
  attempts: number,
  reason: string,
  previousError: string | null | undefined,
  extendable = false,
): number {
  // A failure after a tainted one never earns the extra attempt, whatever the count (#175 round 2).
  if ((previousError ?? "").endsWith(NO_EXTRA_MARK)) return MAX_DESCRIBE_ATTEMPTS;
  if (attempts > MAX_DESCRIBE_ATTEMPTS) return MAX_DESCRIBE_ATTEMPTS_EXTENDED;
  if (
    attempts === MAX_DESCRIBE_ATTEMPTS &&
    extendable &&
    EXTRA_ATTEMPT_REASONS.has(reason) &&
    !NO_EXTRA_AFTER.has(errorReason(previousError))
  )
    return MAX_DESCRIBE_ATTEMPTS_EXTENDED;
  return MAX_DESCRIBE_ATTEMPTS;
}

export interface AcceptedDescription {
  contentKey: string;
  description: Description;
  /** Model that wrote it, for example `haiku`; null for a fallback written without a model. */
  model: string | null;
  /** `model` (the default), or `fallback` for the deterministic description of #150 (`fallbackDescription`). */
  provenance?: "model" | "fallback";
}

/**
 * Stores descriptions that already passed `validateDescription` (provenance `model`, or `fallback`), deletes their backlog rows and
 * updates the description columns of `fts_symbols` for every effective symbol with that content key, in one
 * transaction. By default a key that already has a description is left alone (first writer wins); `replace` overwrites.
 * Returns how many descriptions were stored.
 */
export function storeDescriptions(
  store: Store,
  accepted: AcceptedDescription[],
  opts: { replace?: boolean } = {},
): number {
  if (accepted.length === 0) return 0;
  const insert = store.db.prepare(
    `INSERT OR ${opts.replace ? "REPLACE" : "IGNORE"} INTO descriptions(content_key, behavior, search_terms, name_fits,
       suggested_name, provenance, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const drop = store.db.prepare("DELETE FROM backlog WHERE content_key = ?");
  const at = new Date().toISOString();
  return store.tx(() => {
    let stored = 0;
    const written = new Map<string, Description>();
    for (const a of accepted) {
      const d = a.description;
      const r = insert.run(
        a.contentKey,
        d.behavior,
        JSON.stringify(d.searchTerms),
        d.nameFits ? 1 : 0,
        d.suggestedName ?? null,
        a.provenance ?? "model",
        a.model,
        PROMPT_MAJOR,
        at,
      );
      stored += r.changes;
      if (r.changes > 0) written.set(a.contentKey, d);
      drop.run(a.contentKey);
    }
    refreshDescriptionFts(store, { keys: new Set(written.keys()) });
    return stored;
  });
}

/**
 * Counts one failed attempt for a backlog row: `attempts + 1`, `last_error`, back to `pending` for another try, or
 * `failed` once the row's limit is reached (`describeAttemptLimit`: `MAX_DESCRIBE_ATTEMPTS`, or one more after a
 * `shape`/`identifier` second failure; then nobody retries it until `gantry backlog --retry-failed`).
 * With `keepClaim` (the describer submit path, #147) a row that still has an attempt left stays `claimed` in its batch,
 * so the describer can resubmit a corrected description under the same `batch_id`, and a `failed` row keeps its
 * `claimed_by` so a late resubmit is answered `attempts_exhausted` instead of `not_in_batch`. Returns the new
 * attempt count and whether the row is now `failed` (attempts 0 when there is no such row). `extendable` (default
 * false: the caller must show it) allows the extra attempt for this failure; `tainted` (default true) marks
 * `last_error` with `NO_EXTRA_MARK`, which rules the extra attempt out after this failure. The read and the write run
 * in one transaction, so two processes recording a failure for the same row never lose an attempt (#175).
 */
export function recordDescribeFailure(
  store: Store,
  key: string,
  errorText: string,
  opts: { keepClaim?: boolean; extendable?: boolean; tainted?: boolean } = {},
): { attempts: number; failed: boolean } {
  const extendable = opts.extendable ?? false;
  const tainted = opts.tainted ?? true;
  const error = tainted ? `${errorText}${NO_EXTRA_MARK}` : errorText;
  return store.tx(() => {
    // The describer path counts only a row still claimed; the worker path any row not already failed.
    const row = store.db
      .prepare(
        `SELECT attempts, last_error FROM backlog WHERE content_key = ? AND ${opts.keepClaim ? "status = 'claimed'" : "status <> 'failed'"}`,
      )
      .get(key) as { attempts: number | null; last_error: string | null } | undefined;
    if (!row) return { attempts: 0, failed: false };
    const attempts = (row.attempts ?? 0) + 1;
    const failed =
      attempts >= describeAttemptLimit(attempts, errorReason(error), row.last_error, extendable && !tainted);
    if (opts.keepClaim) {
      store.db
        .prepare(
          `UPDATE backlog SET attempts = ?, last_error = ?, status = ?, claimed_at = CASE WHEN ? THEN NULL ELSE claimed_at END
           WHERE content_key = ?`,
        )
        .run(attempts, error, failed ? "failed" : "claimed", failed ? 1 : 0, key);
      return { attempts, failed };
    }
    store.db
      .prepare(
        `UPDATE backlog SET attempts = ?, last_error = ?, status = ?, claimed_by = NULL, claimed_at = NULL
         WHERE content_key = ?`,
      )
      .run(attempts, error, failed ? "failed" : "pending", key);
    return { attempts, failed };
  });
}
