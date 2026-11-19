import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findDuplicates } from "../../packages/core/src/index.js";
import { Harness, loadCases, loadNegatives } from "./lib.js";

/**
 * The Go seeded duplicates (spec section 17), without a model: exact and near tiers at the TypeScript thresholds.
 * g01 to g03 (misleading names) need embeddings and are measured by `run.ts --embed`.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create();
}, 120_000);
afterAll(() => h?.close());

const TS_ID = "web/slug.ts#slugify";

describe("seeded Go duplicates", () => {
  for (const c of loadCases()) {
    if (c.misleading) {
      it.skip(`${c.id}: ${c.existing} under a misleading name (needs embeddings: run.ts --embed)`, () => {});
      continue;
    }
    it(`${c.id}: finds ${c.existing} first, in tier ${c.expected.tiers.join(" or ")}`, async () => {
      const found = await h.place(c.targetFile, h.codeOf(c));
      h.clear(c.targetFile);
      const top = found.candidates[0];
      expect(top?.symbolId).toBe(h.id(c.existing));
      expect(c.expected.tiers).toContain(top?.tier);
      expect(found.candidates.map((x) => x.symbolId)).not.toContain(h.id(TS_ID));
    });
  }

  for (const n of loadNegatives()) {
    const what =
      n.kind === "cross_language" ? "a Go copy of the logic of web/slug.ts" : "an unrelated function";
    it(`${n.id}: ${what} matches nothing`, async () => {
      const found = await h.place(n.targetFile, n.newCode);
      h.clear(n.targetFile);
      console.log(`${n.id} (${n.kind}): ${found.candidates.length} candidates`);
      expect(found.candidates).toEqual([]);
    });
  }

  it("the TypeScript function has no Go candidate, in any tier", async () => {
    const ts = h.store.getSymbol(h.id(TS_ID));
    expect(ts?.lang).toBe("typescript");
    expect(await findDuplicates(h.store, { symbol: ts as NonNullable<typeof ts> }, { limit: 10 })).toEqual(
      [],
    );
  });
});
