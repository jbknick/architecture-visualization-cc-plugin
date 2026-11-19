// Follow-ups of the final review of #178 (issue #180), item 6: the failure write checks batch membership in the same
// transaction, and a function that ended with a fallback description goes back to the model, at most three times.
import { afterEach, describe, expect, it } from "vitest";
import { claimBatch, MAX_FALLBACK_REQUEUES, syncBacklog } from "./backlog.js";
import { recordDescribeFailure } from "./store.js";
import { submitDescriptions } from "./submit.js";
import { cleanupData, type Indexed, indexedFixture } from "./testkit.js";

afterEach(cleanupData);

const SLUG = "8443c45ca4363d0363ffaab88cb18427:p1";
const SHAPE_BAD = { behavior: "The slug of a text.", searchTerms: ["slug"], nameFits: true };
const GOOD = {
  behavior: "Returns the slug for a text, lower-cased with spaces replaced by dashes.",
  searchTerms: ["slug"],
  nameFits: true,
};

const row = (ix: Indexed, key: string) =>
  ix.store.db.prepare("SELECT status, attempts, claimed_by FROM backlog WHERE content_key = ?").get(key) as
    | { status: string; attempts: number; claimed_by: string | null }
    | undefined;
const provenance = (ix: Indexed, key: string) =>
  (
    ix.store.db.prepare("SELECT provenance FROM descriptions WHERE content_key = ?").get(key) as
      | { provenance: string }
      | undefined
  )?.provenance;

/** Claims everything and fails `key` three times on wording: the third failure stores a fallback. */
function runToFallback(ix: Indexed, key: string): void {
  const { batchId } = claimBatch(ix.store, "w1", 40);
  for (let i = 0; i < 3; i++)
    submitDescriptions(ix.store, batchId, [{ contentKey: key, description: SHAPE_BAD }]);
}

describe("item 6: batch membership and the failure write are one transaction", () => {
  it("counts nothing for a row that another batch claimed since", async () => {
    const ix = await indexedFixture();
    syncBacklog(ix.store);
    const { batchId } = claimBatch(ix.store, "w1", 40);
    // another worker re-claimed the row after this batch expired
    ix.store.db
      .prepare("UPDATE backlog SET claimed_by = ? WHERE content_key = ?")
      .run("w2:other-batch", SLUG);
    expect(recordDescribeFailure(ix.store, SLUG, "shape: x", { keepClaim: true, batchId })).toEqual({
      attempts: 0,
      failed: false,
    });
    expect(row(ix, SLUG)).toMatchObject({ status: "claimed", attempts: 0, claimed_by: "w2:other-batch" });
    // the batch that holds the claim is charged as before
    ix.store.db.prepare("UPDATE backlog SET claimed_by = ? WHERE content_key = ?").run(`w1:${batchId}`, SLUG);
    expect(recordDescribeFailure(ix.store, SLUG, "shape: x", { keepClaim: true, batchId })).toEqual({
      attempts: 1,
      failed: false,
    });
    await ix.close();
  });

  it("submitDescriptions answers not_in_batch when the row moved between the check and the write", async () => {
    const ix = await indexedFixture();
    syncBacklog(ix.store);
    const { batchId } = claimBatch(ix.store, "w1", 40);
    const real = ix.store.tx.bind(ix.store);
    // Move the row to another batch just before the failure transaction runs (after the early membership check).
    ix.store.tx = ((fn: () => unknown) => {
      ix.store.db.prepare("UPDATE backlog SET claimed_by = 'w2:other-batch' WHERE content_key = ?").run(SLUG);
      return real(fn);
    }) as typeof ix.store.tx;
    const r = submitDescriptions(ix.store, batchId, [{ contentKey: SLUG, description: SHAPE_BAD }]);
    expect(r.rejected).toEqual([{ contentKey: SLUG, reason: "not_in_batch" }]);
    expect(row(ix, SLUG)).toMatchObject({ attempts: 0, claimed_by: "w2:other-batch" });
    await ix.close();
  });
});

describe("item 6: a fallback row is re-queued for the model, at most three times", () => {
  it("puts the function back as pending after a fallback, and a model description replaces the fallback", async () => {
    const ix = await indexedFixture();
    syncBacklog(ix.store);
    runToFallback(ix, SLUG);
    expect(provenance(ix, SLUG)).toBe("fallback");
    expect(row(ix, SLUG)).toBeUndefined();

    const sync = syncBacklog(ix.store);
    expect(sync.enqueued).toBeGreaterThanOrEqual(1);
    expect(row(ix, SLUG)).toMatchObject({ status: "pending", attempts: 0 });
    expect(ix.store.getMeta(`fallback_requeues:${SLUG}`)).toBe("1");

    const { batchId } = claimBatch(ix.store, "w1", 40);
    const ok = submitDescriptions(ix.store, batchId, [{ contentKey: SLUG, description: GOOD }]);
    expect(ok.accepted).toBe(1);
    expect(provenance(ix, SLUG)).toBe("model");
    expect(row(ix, SLUG)).toBeUndefined();
    syncBacklog(ix.store);
    expect(row(ix, SLUG)).toBeUndefined(); // a model description is final
    await ix.close();
  });

  it("keeps the fallback and stops re-queueing after the third return", async () => {
    const ix = await indexedFixture();
    syncBacklog(ix.store);
    runToFallback(ix, SLUG);
    expect(MAX_FALLBACK_REQUEUES).toBe(3);
    for (let n = 1; n <= 3; n++) {
      syncBacklog(ix.store);
      expect(row(ix, SLUG), `requeue ${n}`).toMatchObject({ status: "pending" });
      runToFallback(ix, SLUG); // fails again; the fallback that exists stays
      expect(provenance(ix, SLUG)).toBe("fallback");
    }
    syncBacklog(ix.store);
    expect(row(ix, SLUG)).toBeUndefined();
    expect(ix.store.getMeta(`fallback_requeues:${SLUG}`)).toBe("3");
    expect(provenance(ix, SLUG)).toBe("fallback");
    await ix.close();
  });

  it("does not put a second row next to one that is already pending or claimed", async () => {
    const ix = await indexedFixture();
    syncBacklog(ix.store);
    runToFallback(ix, SLUG);
    syncBacklog(ix.store);
    syncBacklog(ix.store);
    expect(ix.store.getMeta(`fallback_requeues:${SLUG}`)).toBe("1");
    await ix.close();
  });
});
