// Fixed part of #224: committed, hand-written descriptions of `fixtures/go-basic` go through the same checks as
// TypeScript ones and are found by keyword search (no vectors) by what they do. No describer runs here.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claimBatch, syncBacklog } from "../describe/backlog.js";
import { buildFactSheet, contentKey } from "../describe/factsheet.js";
import { submitDescriptions } from "../describe/submit.js";
import { cleanupData, type Indexed, indexedFixture } from "../describe/testkit.js";
import { cachedEmbedder } from "../embed/model.js";
import { hybridSearch } from "./hybrid.js";

interface DescriptionRow {
  symbol: string;
  behavior: string;
  searchTerms: string[];
  nameFits: boolean;
}
interface QueryRow {
  q: string;
  expected: string;
}
const evalFile = <T>(name: string): T[] =>
  JSON.parse(readFileSync(join(import.meta.dirname, "../../../../evals/go-search", name), "utf8")) as T[];

const TOP_MIN = 8;
let modelsDir: string;
let savedModelsDir: string | undefined;

beforeAll(() => {
  // An empty model directory: no embedding model, so no vectors and only the keyword half of the search runs.
  savedModelsDir = process.env.GANTRY_MODELS_DIR;
  modelsDir = mkdtempSync(join(tmpdir(), "gantry-go-search-models-"));
  process.env.GANTRY_MODELS_DIR = modelsDir;
});
afterAll(() => {
  if (savedModelsDir === undefined) delete process.env.GANTRY_MODELS_DIR;
  else process.env.GANTRY_MODELS_DIR = savedModelsDir;
  rmSync(modelsDir, { recursive: true, force: true });
});
afterEach(cleanupData);

async function submitGo(ix: Indexed): Promise<{ accepted: number; rejected: unknown[]; submitted: number }> {
  // Go gets no templates, so every function goes to the describer.
  expect(syncBacklog(ix.store)).toMatchObject({ templated: 0 });
  const { batchId, items } = claimBatch(ix.store, "w1", 40);
  const byId = new Map(items.map((i) => [i.id, i.contentKey]));
  const repo = ix.store.repo();
  const results = evalFile<DescriptionRow>("descriptions.json").flatMap((d) => {
    const key = byId.get(`sym:${repo}:${d.symbol}`);
    // A function the fixture gained later has no entry; an entry whose function is gone is skipped too.
    if (key === undefined) return [];
    return [
      {
        contentKey: key,
        description: { behavior: d.behavior, searchTerms: d.searchTerms, nameFits: d.nameFits },
      },
    ];
  });
  const r = submitDescriptions(ix.store, batchId, results);
  return { accepted: r.accepted, rejected: r.rejected, submitted: results.length };
}

describe("Go descriptions and search (fixed part)", () => {
  it("accepts every committed Go description and finds the expected function in the top 5 by behaviour", async () => {
    const ix = await indexedFixture("go-basic");
    const sub = await submitGo(ix);
    expect(sub.rejected).toEqual([]);
    expect(sub.submitted).toBeGreaterThanOrEqual(10);
    expect(sub.accepted).toBe(sub.submitted);

    // No model files, so no vectors: this is the keyword half only.
    expect(await cachedEmbedder()()).toBeUndefined();

    const repo = ix.store.repo();
    const queries = evalFile<QueryRow>("queries.json");
    expect(queries).toHaveLength(10);
    let top5 = 0;
    const misses: string[] = [];
    for (const { q, expected } of queries) {
      const name = expected.slice(expected.indexOf("#") + 1).replace(/~\d+$/, "");
      expect(q.toLowerCase()).not.toContain(name.split(".").pop()?.toLowerCase());
      const hits = await hybridSearch(ix.store, q, { lang: "go", limit: 5 });
      if (hits.some((h) => h.id === `sym:${repo}:${expected}`)) top5++;
      else misses.push(`${q} -> ${hits.map((h) => h.name).join(", ")}`);
    }
    console.log(
      `vectors: none (GANTRY_MODELS_DIR is an empty directory)\ntop5: ${top5}/10${misses.length > 0 ? `\nmissed:\n${misses.join("\n")}` : ""}`,
    );
    expect(misses.length, misses.join("\n")).toBeLessThanOrEqual(10 - TOP_MIN);
    expect(top5).toBeGreaterThanOrEqual(TOP_MIN);
    await ix.close();
  });

  it("builds Go fact sheets with the language, the doc comment and the result type", async () => {
    const ix = await indexedFixture("go-basic");
    const repo = ix.store.repo();
    const src = (rel: string) => readFileSync(join(ix.fx.dir, rel), "utf8");
    const get = buildFactSheet(
      ix.store,
      `sym:${repo}:internal/store/store.go#Store.Get`,
      src("internal/store/store.go"),
    );
    expect(get).toMatchObject({
      language: "Go",
      doc: "Get returns the value stored under key.",
      returnType: "(string, bool)",
      kind: "method",
    });
    const nw = buildFactSheet(
      ix.store,
      `sym:${repo}:internal/store/store.go#New`,
      src("internal/store/store.go"),
    );
    expect(nw).toMatchObject({ language: "Go", returnType: "*Store" });
    const put = buildFactSheet(
      ix.store,
      `sym:${repo}:internal/store/store.go#Store.Put`,
      src("internal/store/store.go"),
    );
    expect(put.returnType).toBeNull();
    await ix.close();
  });

  it("leaves TypeScript descriptions unchanged apart from the language field", async () => {
    const ix = await indexedFixture();
    syncBacklog(ix.store);
    const { batchId, items } = claimBatch(ix.store, "w1", 40);
    const slug = items.find((i) => i.id.endsWith("slug.ts#slugify"));
    expect(slug).toMatchObject({ language: "TypeScript", contentKey: "8443c45ca4363d0363ffaab88cb18427:p1" });
    expect(contentKey("abc")).toBe("abc:p1");
    const behavior =
      "Converts text into a lowercase URL slug by trimming and replacing whitespace with dashes.";
    const r = submitDescriptions(ix.store, batchId, [
      {
        contentKey: slug?.contentKey ?? "",
        description: { behavior, searchTerms: ["slug", "url slug"], nameFits: true },
      },
    ]);
    expect(r).toMatchObject({ accepted: 1, rejected: [] });
    const hits = await hybridSearch(ix.store, "url slug", { lang: "typescript", limit: 5 });
    expect(hits[0]?.description).toBe(behavior);
    await ix.close();
  });
});
