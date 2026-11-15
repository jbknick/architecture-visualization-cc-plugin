import { randomUUID } from "node:crypto";
import {
  backlogCounts,
  CLAIM_SIZE,
  claimBatch,
  DESCRIBER_RUN_CLAIMS,
  type FactSheet,
  isIndexed,
  reissueBatch,
  releaseBatchItems,
  releaseExpiredClaims,
} from "@gantry/core";
import { z } from "zod";
/** Describer-only tool: 10 sheets are about 6,000 characters typical; 20,000 is what a subagent reads in one result (#141). */
export const CLAIM_MAX_CHARS = 20_000;

import { defineTool } from "../tool.js";

/**
 * Claims handed out in the current run of each describer, keyed by data dir and worker id (#147). In memory: a
 * server restart only makes the next run longer. A run ends with `stop: "run_limit"` after `DESCRIBER_RUN_CLAIMS`
 * claims, which resets the count, so a fresh describer started with the same worker id gets a full run.
 */
const runs = new Map<string, number>();

/** Forgets every run count (tests). */
export function resetDescriberRuns(): void {
  runs.clear();
}

interface ClaimItem {
  content_key: string;
  path: string;
  kind: string;
  signature: string;
  doc: string | null;
  callees: string[];
  return_type: string | null;
  body: string;
  body_truncated?: true;
}

const toItem = (s: FactSheet): ClaimItem => ({
  content_key: s.contentKey,
  path: s.path,
  kind: s.kind,
  signature: s.signature,
  doc: s.doc,
  callees: s.callees,
  return_type: s.returnType,
  body: s.body,
});

const length = (v: unknown): number => JSON.stringify(v).length;

/** Shrinks one oversized sheet so a single function always fits: shorter doc, callees and signature, then body. */
function shrink(base: object, item: ClaimItem): ClaimItem | undefined {
  const cur: ClaimItem = {
    ...item,
    doc: item.doc === null ? null : item.doc.slice(0, 200),
    callees: item.callees.slice(0, 10),
    signature: item.signature.slice(0, 300),
  };
  while (length({ ...base, items: [cur] }) > CLAIM_MAX_CHARS) {
    if (cur.body.length === 0) return undefined;
    cur.body = cur.body.slice(0, Math.floor(cur.body.length * 0.8));
    cur.body_truncated = true;
  }
  return cur;
}

/** The leading sheets that fit in one response (the payload may also carry `truncated: true`). */
function fit(base: object, items: ClaimItem[]): ClaimItem[] {
  const kept: ClaimItem[] = [];
  const room = { ...base, truncated: true };
  for (const item of items) {
    if (length({ ...room, items: [...kept, item] }) <= CLAIM_MAX_CHARS) {
      kept.push(item);
      continue;
    }
    if (kept.length === 0) {
      const small = shrink(room, item);
      if (small) kept.push(small);
    }
    break;
  }
  return kept;
}

export const claimTool = defineTool({
  name: "gantry_claim_batch",
  maxResponseChars: CLAIM_MAX_CHARS,
  description:
    "Describer agents only. Claims functions that still need a description and returns their fact sheets as {batch_id, items}, each item {content_key, path, kind, signature, doc, callees, return_type, body}. " +
    "Pass the worker_id from your prompt and reuse it on every call; if you have none, omit it and reuse the worker_id the response returns. " +
    "A batch you claimed and did not submit is returned again under the same batch_id before any new function is handed out, and claims expire after 10 minutes. Submit with the batch_id. " +
    "A response holds at most 20,000 characters; if the sheets do not all fit, fewer than size items come back (truncated: true) and the rest stay queued for your next call. " +
    "When items is empty the response says why in stop: backlog_empty (nothing left to claim), not_indexed (this data dir has no Gantry index for the repository, so run /gantry:init; never report it as an empty backlog) or run_limit (this run is over: stop and report; remaining says how much work is left). " +
    "Submit the descriptions with gantry_submit_descriptions.",
  inputSchema: {
    worker_id: z
      .string()
      .regex(/^[\w.:@-]{1,100}$/, "1 to 100 characters: letters, digits, _ . : @ -")
      .optional()
      .describe("The id from your prompt, reused on every call. Omit it to get a fresh one back"),
    size: z
      .number()
      .int()
      .min(1)
      .max(CLAIM_SIZE)
      .default(CLAIM_SIZE)
      .describe("How many functions to claim, at most 10 (the default)"),
  },
  run({ worker_id: given, size }, { store, paths }) {
    // Two describers must never share an id: a caller without one gets a fresh id back (#141).
    const worker_id = given ?? `w-${randomUUID().slice(0, 8)}`;
    const runKey = `${paths.dataDir}\0${worker_id}`;
    const used = runs.get(runKey) ?? 0;
    releaseExpiredClaims(store);
    const again = reissueBatch(store, worker_id, size);
    const reissued = again !== null && again.items.length > 0;
    const left = (): number => {
      const c = backlogCounts(store).byStatus;
      return c.pending + c.claimed;
    };
    // The run is over once it had its claims and holds nothing unsubmitted: the describer hands back before its turn
    // limit, and the skill starts a fresh one with the same id (#147).
    if (!reissued && used >= DESCRIBER_RUN_CLAIMS) {
      runs.delete(runKey);
      return {
        worker_id,
        batch_id: null,
        items: [],
        stop: "run_limit",
        remaining: left(),
        message:
          "This run is complete. Stop now and report; a fresh describer continues with your worker id.",
      };
    }
    const batch = reissued ? again : claimBatch(store, worker_id, size);
    const all = batch.items.map(toItem);
    const base = { worker_id, batch_id: batch.batchId, ...(reissued ? { reissued: true } : {}) };
    if (all.length === 0) {
      runs.delete(runKey);
      if (!isIndexed(store)) {
        return {
          ...base,
          items: [],
          stop: "not_indexed",
          indexed: false,
          data_dir: paths.dataDir,
          message:
            "This data dir has no Gantry index for the repository. Run /gantry:init; the backlog is not empty, it was never built.",
        };
      }
      return { ...base, items: [], stop: "backlog_empty", indexed: true, remaining: left() };
    }
    runs.set(runKey, used + 1);
    const items = fit(base, all);
    // Sheets of a fresh claim that did not fit go back to the queue. A reissued batch keeps its rows: the caller (or
    // another one holding the same id) may still be submitting them, so releasing would make the submit not_in_batch.
    if (!reissued) {
      releaseBatchItems(
        store,
        batch.batchId,
        all.slice(items.length).map((i) => i.content_key),
      );
    }
    if (items.length === 0 && all.length > 0) {
      return { ...base, items: [], error: "item_too_large", message: "No function fits in one response." };
    }
    return { ...base, items, ...(items.length < all.length ? { truncated: true } : {}) };
  },
});
