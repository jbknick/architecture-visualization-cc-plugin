import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncBacklog } from "../describe/backlog.js";
import { contentKey } from "../describe/factsheet.js";
import { cleanupData, type Indexed, indexedFixture } from "../describe/testkit.js";
import { type Embedder, embedPending, offlineEmbedder, vecAvailable } from "../embed/index.js";
import { refreshDescriptionFts } from "./descfts.js";
import { ftsSearch } from "./fts.js";
import { hybridSearch } from "./hybrid.js";

/** Deterministic stand-in for the model: hashed bag of words, L2-normalized. Never loads the real model. */
function fakeEmbedder(dim = 64): Embedder {
  return {
    dim,
    modelId: "fake/test-model",
    available: true,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (const w of t
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean)) {
          let h = 2166136261;
          for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
          v[h % dim] = (v[h % dim] as number) + 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}

const SLUG = "sym:packages/utils/src/slug.ts#slugify";
const DATE = "sym:packages/utils/src/date.ts#formatRelativeDate";

let ix: Indexed;
beforeEach(async () => {
  ix = await indexedFixture();
  syncBacklog(ix.store);
});
afterEach(async () => {
  await ix.close();
  cleanupData();
});

function describeSymbol(
  id: string,
  behavior: string,
  terms: string[],
  suggested: string | null = null,
): void {
  const sym = ix.store.getSymbol(id);
  if (!sym) throw new Error(`no symbol ${id}`);
  ix.store.db
    .prepare(
      `INSERT OR REPLACE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
         provenance, model, prompt_version, created_at) VALUES (?, ?, ?, 1, ?, 'model', 'haiku', 'p1', 'now')`,
    )
    .run(contentKey(sym.exactHash), behavior, JSON.stringify(terms), suggested);
}

function describeAll(): void {
  describeSymbol(SLUG, "Converts a title into a url-safe lowercase string with dashes.", [
    "slug",
    "url safe",
  ]);
  describeSymbol(DATE, "Formats a date as a phrase relative to now, such as two days ago.", [
    "relative time",
  ]);
  refreshDescriptionFts(ix.store);
}

describe("description columns of fts_symbols", () => {
  it("are filled for template descriptions and again as a no-op", () => {
    const row = ix.store.db
      .prepare("SELECT behavior, search_terms FROM fts_symbols WHERE symbol_id = ?")
      .get("sym:packages/db/src/queries.ts#createPost") as { behavior: string; search_terms: string };
    expect(row.behavior).toMatch(/^Returns db\.insert\(posts\)/);
    expect(row.search_terms).toContain("create post");
    expect(refreshDescriptionFts(ix.store)).toBe(0);
  });

  it("are rewritten when a description changes, and survive a re-sync", () => {
    describeAll();
    const cols = () =>
      ix.store.db.prepare("SELECT behavior, search_terms FROM fts_symbols WHERE symbol_id = ?").get(SLUG) as {
        behavior: string;
        search_terms: string;
      };
    expect(cols().behavior).toContain("url-safe");
    expect(cols().search_terms).toBe("slug url safe");
    syncBacklog(ix.store);
    expect(cols().behavior).toContain("url-safe");
  });
});

describe("hybridSearch", () => {
  it("finds slugify from a query worded by meaning, with vectors", async () => {
    describeAll();
    if (!vecAvailable(ix.store)) return; // no sqlite-vec on this platform: the keyword test below covers it
    const embedder = fakeEmbedder();
    await embedPending(ix.store, { embedder });
    const hits = await hybridSearch(ix.store, "turn a title into a url-safe string", { embedder });
    const top = hits[0];
    expect(top?.name).toBe("slugify");
    expect(top?.description).toBe("Converts a title into a url-safe lowercase string with dashes.");
    expect(top?.signature).toBe("(input: string): string");
    expect(top?.score).toBeGreaterThan(0);
  });

  it("keyword half alone matches stored descriptions when there is no embedder", async () => {
    describeAll();
    const hits = await hybridSearch(ix.store, "title url safe");
    expect(hits[0]?.name).toBe("slugify");
    // the name/path-only keyword search of M1 cannot see the description
    expect(ftsSearch(ix.store, "title url safe", { limit: 5 }).some((h) => h.name === "slugify")).toBe(false);
  });

  it("treats the offline embedder like no embedder", async () => {
    describeAll();
    const a = await hybridSearch(ix.store, "relative time phrase");
    const b = await hybridSearch(ix.store, "relative time phrase", { embedder: offlineEmbedder() });
    expect(b).toEqual(a);
    expect(a[0]?.name).toBe("formatRelativeDate");
  });

  it("applies kind, workspace and exported filters to both halves", async () => {
    describeAll();
    const embedder = fakeEmbedder();
    if (vecAvailable(ix.store)) await embedPending(ix.store, { embedder });
    const q = "title into url-safe string";
    const all = await hybridSearch(ix.store, q, { embedder });
    expect(all.some((h) => h.name === "slugify")).toBe(true);
    const inDb = await hybridSearch(ix.store, q, { embedder, workspace: "ws:@acme/db" });
    expect(inDb.some((h) => h.name === "slugify")).toBe(false);
    const kindOnly = await hybridSearch(ix.store, q, { embedder, kind: ["class"] });
    expect(kindOnly).toEqual([]);
    const internal = await hybridSearch(ix.store, q, { embedder, exported: true });
    for (const h of internal) expect(ix.store.getSymbol(h.id)?.exported).toBe(true);
  });

  it("orders deterministically: score descending, then id", async () => {
    describeAll();
    const embedder = fakeEmbedder();
    if (vecAvailable(ix.store)) await embedPending(ix.store, { embedder });
    const first = await hybridSearch(ix.store, "string", { embedder, limit: 50 });
    const second = await hybridSearch(ix.store, "string", { embedder, limit: 50 });
    expect(second).toEqual(first);
    for (let i = 1; i < first.length; i++) {
      const a = first[i - 1];
      const b = first[i];
      if (!a || !b) continue;
      expect(a.score > b.score || (a.score === b.score && a.id < b.id)).toBe(true);
    }
  });

  it("returns nothing for an empty query and honours limit", async () => {
    describeAll();
    expect(await hybridSearch(ix.store, "   ")).toEqual([]);
    expect((await hybridSearch(ix.store, "date", { limit: 1 })).length).toBeLessThanOrEqual(1);
  });
});
