import {
  BATCH_SIZE,
  claimBatch,
  type FactSheet,
  reissueBatch,
  releaseBatchItems,
  releaseExpiredClaims,
} from "@gantry/core";
import { z } from "zod";
import { MAX_RESPONSE_CHARS } from "../envelope.js";
import { defineTool } from "../tool.js";

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
  while (length({ ...base, items: [cur] }) > MAX_RESPONSE_CHARS) {
    if (cur.body.length === 0) return undefined;
    cur.body = cur.body.slice(0, Math.floor(cur.body.length * 0.8));
    cur.body_truncated = true;
  }
  return cur;
}

/** The leading sheets that fit in one 4,000-character response (the payload may also carry `truncated: true`). */
function fit(base: object, items: ClaimItem[]): ClaimItem[] {
  const kept: ClaimItem[] = [];
  const room = { ...base, truncated: true };
  for (const item of items) {
    if (length({ ...room, items: [...kept, item] }) <= MAX_RESPONSE_CHARS) {
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
  description:
    "Describer agents only. Claims functions that still need a description and returns their fact sheets as {batch_id, items}, each item {content_key, path, kind, signature, doc, callees, return_type, body}. " +
    "Pass your own stable worker_id. A batch you claimed and did not submit is returned again under the same batch_id before any new function is handed out, and claims expire after 10 minutes. " +
    "A response holds at most 4,000 characters, so fewer than size items can come back (truncated: true); the rest stay queued for your next call. " +
    "Submit the descriptions with gantry_submit_descriptions.",
  inputSchema: {
    worker_id: z
      .string()
      .regex(/^[\w.:@-]{1,100}$/, "1 to 100 characters: letters, digits, _ . : @ -")
      .describe("A stable id for this describer, reused on every call"),
    size: z
      .number()
      .int()
      .min(1)
      .max(BATCH_SIZE)
      .default(BATCH_SIZE)
      .describe("How many functions to claim, at most 40"),
  },
  run({ worker_id, size }, { store }) {
    releaseExpiredClaims(store);
    const again = reissueBatch(store, worker_id, size);
    const reissued = again !== null && again.items.length > 0;
    const batch = reissued ? again : claimBatch(store, worker_id, size);
    const all = batch.items.map(toItem);
    const base = { batch_id: batch.batchId, ...(reissued ? { reissued: true } : {}) };
    const items = fit(base, all);
    // Sheets that did not fit are not lost: they go back to the queue instead of waiting for the claim to expire.
    releaseBatchItems(
      store,
      batch.batchId,
      all.slice(items.length).map((i) => i.content_key),
    );
    if (items.length === 0 && all.length > 0) {
      return { ...base, items: [], error: "item_too_large", message: "No function fits in one response." };
    }
    return { ...base, items, ...(items.length < all.length ? { truncated: true } : {}) };
  },
});
