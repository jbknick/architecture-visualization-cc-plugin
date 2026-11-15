import { BATCH_SIZE, embedPending, submitDescriptions, writeCatalogDebounced } from "@gantry/core";
import { z } from "zod";
import { defineTool } from "../tool.js";

/** Budget for embedding the vectors of freshly accepted descriptions, when the model is already cached. */
const EMBED_BUDGET_MS = 2000;

export const submitTool = defineTool({
  name: "gantry_submit_descriptions",
  description:
    "Describer agents only. Submits the descriptions for a claimed batch as {batch_id, results: [{content_key, description}]}, where description is {behavior, searchTerms, nameFits, suggestedName?}: " +
    "behavior is one third-person sentence of at most 25 words, searchTerms are 1 to 6 short terms, suggestedName is required exactly when nameFits is false. " +
    "Every description is checked; the answer is {accepted, rejected: [{content_key, reason, rule?, field?, fix?, resubmit?, fallback?}], fallbacks}. " +
    "For a rule rejection (schema, length, shape, identifier, injection, secret), fix says how to rewrite for that rule; it never quotes what you wrote. " +
    "While resubmit is true the function stays in your batch: write a new description that follows fix and submit it again with the same batch_id. " +
    "A function has 2 attempts, 3 when the second rejection was shape or identifier; after the last one it is failed, or, with fallback: true, the server stored a description written without a model and it is done. " +
    "The batch is found by batch_id alone, whichever worker claimed it; a content_key that does not belong to batch_id is rejected as not_in_batch.",
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
  async run({ batch_id, results }, { store, paths, log, getEmbedder }) {
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
    if (r.accepted > 0) {
      try {
        writeCatalogDebounced(store, paths); // at most once per 30 s; gantry_browse refreshes it on read
      } catch (err) {
        log.error("catalog write after submit failed", err);
      }
    }
    // The validator's detail stays on the host (it can echo part of a token): the describer gets fixed text only.
    return {
      accepted: r.accepted,
      rejected: r.rejected.map((x) => ({
        content_key: x.contentKey,
        reason: x.reason,
        ...(x.rule !== undefined ? { rule: x.rule } : {}),
        ...(x.field !== undefined ? { field: x.field } : {}),
        ...(x.fix !== undefined ? { fix: x.fix } : {}),
        ...(x.resubmit !== undefined ? { resubmit: x.resubmit } : {}),
        ...(x.fallback ? { fallback: true } : {}),
      })),
      fallbacks: r.fallbacks,
      embedded,
      ...(r.batchKnown ? {} : { batch_status: "unknown_or_expired" }),
    };
  },
});
