import { BATCH_SIZE, embedPending, submitDescriptions } from "@gantry/core";
import { z } from "zod";
import { defineTool } from "../tool.js";

/** Budget for embedding the vectors of freshly accepted descriptions, when the model is already cached. */
const EMBED_BUDGET_MS = 2000;
const DETAIL_MAX = 80;

export const submitTool = defineTool({
  name: "gantry_submit_descriptions",
  description:
    "Describer agents only. Submits the descriptions for a claimed batch as {batch_id, results: [{content_key, description}]}, where description is {behavior, searchTerms, nameFits, suggestedName?}: " +
    "behavior is one third-person sentence of at most 25 words, searchTerms are 1 to 6 short terms, suggestedName is required exactly when nameFits is false. " +
    "Every description is checked; the answer is {accepted, rejected: [{content_key, reason, detail?}]}. A rejected function returns to the queue and is dropped after 2 failed attempts. " +
    "A content_key that does not belong to batch_id is rejected as not_in_batch.",
  inputSchema: {
    batch_id: z.string().min(1).max(100).describe("The batch_id returned by gantry_claim_batch"),
    results: z
      .array(
        z.object({
          content_key: z.string().min(1).max(200),
          description: z
            .unknown()
            .describe(
              "{ behavior: string, searchTerms: string[], nameFits: boolean, suggestedName?: string }",
            ),
        }),
      )
      .min(1)
      .max(BATCH_SIZE),
  },
  async run({ batch_id, results }, { store, log, getEmbedder }) {
    const r = submitDescriptions(
      store,
      batch_id,
      results.map((x) => ({ contentKey: x.content_key, description: x.description })),
    );
    let embedded = 0;
    if (r.accepted > 0) {
      try {
        // Only when the model is already cached; otherwise the vectors wait for `gantry embed`.
        const embedder = await getEmbedder();
        if (embedder) {
          const e = await embedPending(store, { embedder, limit: r.accepted, timeBudgetMs: EMBED_BUDGET_MS });
          embedded = e.descriptions;
        }
      } catch (err) {
        log.error("embedding after submit failed; the vectors wait for gantry embed", err);
      }
    }
    return {
      accepted: r.accepted,
      rejected: r.rejected.map((x) => ({
        content_key: x.contentKey,
        reason: x.reason,
        ...(x.detail ? { detail: x.detail.slice(0, DETAIL_MAX) } : {}),
      })),
      embedded,
      ...(r.batchKnown ? {} : { batch_status: "unknown_or_expired" }),
    };
  },
});
