import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashSymbol } from "../hash/index.js";
import { parseSource } from "../parse/index.js";
import { openStore, type Store } from "../store/index.js";
import type { FileRecord, SymbolRecord } from "../types.js";
import {
  blobToVec,
  CODE_EMBED_MAX_CHARS,
  descriptionText,
  EMBED_DIM,
  EMBED_MODEL_ID,
  type Embedder,
  embedPending,
  ensureVecTables,
  knn,
  MIN_CODE_STMTS,
  offlineEmbedder,
  putVectors,
  storedKeys,
  vecAvailable,
  vecToBlob,
} from "./index.js";
import { loadEmbedder } from "./model.js";

/** Deterministic stand-in for the model: hashed bag of words, L2-normalized. */
function fakeEmbedder(dim = 32, modelId = "fake/test-model"): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    dim,
    modelId,
    calls,
    available: true,
    async embed(texts) {
      calls.push(texts);
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

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gantry-embed-"));
  store = openStore(join(dir, "data", "gantry.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const unit = (d: number, i: number): Float32Array => {
  const v = new Float32Array(d);
  v[i] = 1;
  return v;
};

const BIG = (name: string, extra = "") => `export function ${name}(items: number[], k: number) {
  const out: number[] = [];
  for (const item of items) {
    if (item > k) {
      out.push(item * 2${extra});
    }
  }
  const total = out.reduce((a, b) => a + b, 0);
  return { out, total };
}
`;

/** Writes `files` under `dir/repo` and indexes their symbols into the store (no git needed). */
function indexFiles(files: Record<string, string>): string {
  const root = join(dir, "repo");
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
    const parsed = parseSource(path, source);
    const lang = path.endsWith(".tsx") ? "tsx" : "ts";
    const symbols: SymbolRecord[] = parsed.symbols.map((s) => {
      const body = parsed.bodies.get(s.id);
      const h = body
        ? hashSymbol(source, body, lang)
        : { exactHash: "", shapeHash: "", minhash: new Uint32Array(64) };
      return { ...s, ...h };
    });
    const file: FileRecord = {
      id: `file:${path}`,
      path,
      workspaceId: null,
      contentHash: "h",
      mtimeMs: 0,
      deleted: false,
    };
    store.replaceFile("main", file, symbols, []);
  }
  return root;
}

function addDescription(key: string, behavior: string, terms: string[]): void {
  store.db
    .prepare(
      `INSERT INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name, provenance, model, prompt_version, created_at)
       VALUES (?, ?, ?, 1, NULL, 'model', 'test', 'p1', '2026-01-01')`,
    )
    .run(key, behavior, JSON.stringify(terms));
}

describe("vector serialization", () => {
  it("round-trips and is little-endian float32", () => {
    const v = Float32Array.from([1, -2.5, 0.125, 3e-5]);
    const blob = vecToBlob(v);
    expect(blob.length).toBe(16);
    expect([...blob.subarray(0, 4)]).toEqual([0x00, 0x00, 0x80, 0x3f]); // 1.0f
    expect([...blobToVec(blob)]).toEqual([...v]);
  });
});

describe("store migration v2", () => {
  it("loads sqlite-vec, creates both vec tables for the M0 model and records the model", () => {
    expect(store.getMeta("schema_version")).toBe("2");
    expect(store.getMeta("vec_available")).toBe("1");
    expect(store.getMeta("embed_model")).toBe(EMBED_MODEL_ID);
    expect(store.getMeta("embed_dim")).toBe(String(EMBED_DIM));
    for (const t of ["vec_descriptions", "vec_code"]) {
      const row = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as { sql: string };
      expect(row.sql).toContain("float[768]");
      expect(row.sql).toContain("distance_metric=cosine");
    }
    expect(vecAvailable(store)).toBe(true);
  });

  it("survives a reopen", () => {
    putVectors(store, "vec_code", [{ contentKey: "a:p1", vector: unit(EMBED_DIM, 0) }]);
    store.close();
    store = openStore(join(dir, "data", "gantry.db"));
    expect(storedKeys(store, "vec_code")).toEqual(new Set(["a:p1"]));
  });
});

describe("knn", () => {
  it("returns the identical vector first with cosine 1, then others by distance", () => {
    const d = EMBED_DIM;
    const a = unit(d, 0);
    const near = new Float32Array(d);
    near[0] = Math.SQRT1_2;
    near[1] = Math.SQRT1_2;
    putVectors(store, "vec_code", [
      { contentKey: "far:p1", vector: unit(d, 5) },
      { contentKey: "self:p1", vector: a },
      { contentKey: "near:p1", vector: near },
    ]);
    const hits = knn(store, "vec_code", a, 3);
    expect(hits.map((h) => h.contentKey)).toEqual(["self:p1", "near:p1", "far:p1"]);
    expect(hits[0]?.cosine).toBeCloseTo(1, 5);
    expect(hits[0]?.distance).toBeCloseTo(0, 5);
    expect(hits[1]?.cosine).toBeCloseTo(Math.SQRT1_2, 4);
    expect(hits[2]?.cosine).toBeCloseTo(0, 5);
    expect(knn(store, "vec_code", a, 1)).toHaveLength(1);
  });

  it("is empty for an empty table, k < 1, and does not mix the two tables", () => {
    expect(knn(store, "vec_descriptions", unit(EMBED_DIM, 0), 5)).toEqual([]);
    expect(knn(store, "vec_code", unit(EMBED_DIM, 0), 0)).toEqual([]);
    putVectors(store, "vec_code", [{ contentKey: "x:p1", vector: unit(EMBED_DIM, 1) }]);
    expect(knn(store, "vec_descriptions", unit(EMBED_DIM, 1), 5)).toEqual([]);
  });

  it("putVectors replaces an existing key", () => {
    putVectors(store, "vec_code", [{ contentKey: "x:p1", vector: unit(EMBED_DIM, 1) }]);
    putVectors(store, "vec_code", [{ contentKey: "x:p1", vector: unit(EMBED_DIM, 2) }]);
    expect(storedKeys(store, "vec_code").size).toBe(1);
    expect(knn(store, "vec_code", unit(EMBED_DIM, 2), 1)[0]?.cosine).toBeCloseTo(1, 5);
  });
});

describe("ensureVecTables", () => {
  it("is idempotent for the same model and dimension", () => {
    putVectors(store, "vec_code", [{ contentKey: "x:p1", vector: unit(EMBED_DIM, 1) }]);
    expect(ensureVecTables(store, EMBED_DIM)).toBe(false);
    expect(storedKeys(store, "vec_code").size).toBe(1);
  });

  it("drops and recreates both tables when meta.embed_model changes, and records the new model", () => {
    putVectors(store, "vec_code", [{ contentKey: "x:p1", vector: unit(EMBED_DIM, 1) }]);
    putVectors(store, "vec_descriptions", [{ contentKey: "y:p1", vector: unit(EMBED_DIM, 2) }]);
    expect(ensureVecTables(store, 16, "other/model")).toBe(true);
    expect(store.getMeta("embed_model")).toBe("other/model");
    expect(store.getMeta("embed_dim")).toBe("16");
    expect(storedKeys(store, "vec_code").size).toBe(0);
    expect(storedKeys(store, "vec_descriptions").size).toBe(0);
    const row = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_code'").get() as {
      sql: string;
    };
    expect(row.sql).toContain("float[16]");
  });
});

describe("embedPending", () => {
  it("embeds descriptions as 'behavior + search terms' and is idempotent", async () => {
    addDescription("k1:p1", "Adds two numbers.", ["sum", "add"]);
    addDescription("k2:p1", "Reverses a string.", ["reverse"]);
    const emb = fakeEmbedder();
    expect(await embedPending(store, { embedder: emb })).toMatchObject({
      descriptions: 2,
      code: 0,
      remaining: 0,
      stoppedBy: "complete",
    });
    expect(emb.calls.flat().sort()).toEqual(["Adds two numbers. sum add", "Reverses a string. reverse"]);
    expect(storedKeys(store, "vec_descriptions")).toEqual(new Set(["k1:p1", "k2:p1"]));
    expect(await embedPending(store, { embedder: emb })).toMatchObject({
      descriptions: 0,
      code: 0,
      remaining: 0,
    });
    expect(emb.calls).toHaveLength(1);
    const [q] = await emb.embed(["adds two numbers sum add"], "query");
    expect(knn(store, "vec_descriptions", q as Float32Array, 1)[0]?.contentKey).toBe("k1:p1");
  });

  it("embeds normalized code of function-like symbols with stmtCount >= 3, once per contentKey", async () => {
    const small = "export function tiny(a: number) {\n  return a + 1;\n}\n";
    const root = indexFiles({
      "src/a.ts": BIG("alpha") + small,
      "src/b.ts": BIG("alpha"), // identical function in another file: same exactHash, one vector
      "src/c.ts": BIG("gamma", " + 1"),
    });
    const emb = fakeEmbedder();
    const r = await embedPending(store, { embedder: emb, root });
    expect(r).toMatchObject({ descriptions: 0, code: 2, remaining: 0, belowFloor: 1 });
    const texts = emb.calls.flat();
    expect(texts).toHaveLength(2);
    for (const t of texts) {
      expect(t).toMatch(/^function v1\(v2: number\[\], v3: number\) \{/);
      expect(t).not.toContain("alpha");
      expect(t).not.toContain("\n");
    }
    // KNN of a symbol's own code vector finds its contentKey first.
    const sym = store.getSymbol("sym:src/c.ts#gamma") as SymbolRecord;
    const key = `${sym.exactHash}:p1`;
    const [own] = await emb.embed([texts.find((t) => t.includes("+ 1")) as string], "code");
    expect(knn(store, "vec_code", own as Float32Array, 2)[0]).toMatchObject({ contentKey: key });
    expect(knn(store, "vec_code", own as Float32Array, 1)[0]?.cosine).toBeCloseTo(1, 5);
    expect((storedKeys(store, "vec_code") as Set<string>).has(key)).toBe(true);
  });

  it("skips code when no root is given and honours the limit and batches of the default size", async () => {
    for (let i = 0; i < 70; i++)
      addDescription(`k${String(i).padStart(2, "0")}:p1`, `Does thing ${i}.`, ["t"]);
    const emb = fakeEmbedder();
    expect(await embedPending(store, { embedder: emb })).toMatchObject({ descriptions: 70, code: 0 });
    expect(emb.calls.map((c) => c.length)).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 6]);
    for (let i = 70; i < 90; i++) addDescription(`k${i}:p1`, `Does thing ${i}.`, ["t"]);
    expect(await embedPending(store, { embedder: emb, limit: 5 })).toMatchObject({
      descriptions: 5,
      code: 0,
      remainingDescriptions: 15,
      stoppedBy: "limit",
    });
  });

  it("changing the embedding model rebuilds every vector", async () => {
    addDescription("k1:p1", "Adds two numbers.", ["sum"]);
    const root = indexFiles({ "src/a.ts": BIG("alpha") });
    await embedPending(store, { embedder: fakeEmbedder(32, "model/one"), root });
    expect(store.getMeta("embed_model")).toBe("model/one");
    expect(storedKeys(store, "vec_code").size).toBe(1);
    const two = fakeEmbedder(16, "model/two");
    const r = await embedPending(store, { embedder: two, root });
    expect(r).toMatchObject({ descriptions: 1, code: 1 });
    expect(store.getMeta("embed_model")).toBe("model/two");
    expect(store.getMeta("embed_dim")).toBe("16");
    expect(two.calls.flat()).toHaveLength(2);
  });

  it("offline embedder (zeros): returns zeros, stores nothing, consumers see no vectors", async () => {
    addDescription("k1:p1", "Adds two numbers.", ["sum"]);
    const root = indexFiles({ "src/a.ts": BIG("alpha") });
    expect(await embedPending(store, { embedder: offlineEmbedder(), root })).toMatchObject({
      descriptions: 0,
      code: 0,
      stoppedBy: "unavailable",
    });
    expect(storedKeys(store, "vec_descriptions").size).toBe(0);
    expect(storedKeys(store, "vec_code").size).toBe(0);
    expect(knn(store, "vec_code", unit(EMBED_DIM, 0), 5)).toEqual([]);
  });

  it("loadEmbedder falls back to the zero embedder when the model is neither cached nor downloadable", async () => {
    const empty = mkdtempSync(join(tmpdir(), "gantry-nomodel-"));
    try {
      const e = await loadEmbedder({ cacheDir: empty, allowRemote: false });
      expect(e.available).toBe(false);
      expect(e.dim).toBe(EMBED_DIM);
      const [v] = await e.embed(["x"], "code");
      expect(v?.length).toBe(EMBED_DIM);
      expect([...(v as Float32Array)].every((x) => x === 0)).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("descriptionText", () => {
  it("joins behavior and JSON search terms, tolerating plain strings and null", () => {
    expect(descriptionText("Does x.", '["a","b"]')).toBe("Does x. a b");
    expect(descriptionText("Does x.", "a b")).toBe("Does x. a b");
    expect(descriptionText("Does x.", null)).toBe("Does x.");
  });
});

/** A function with `n` statements (`let`, `n - 2` additions, `return`) and a unique body (`tag` makes the hash differ). */
function fn(name: string, n: number, opts: { exported?: boolean; tag?: string } = {}): string {
  const lines = Array.from(
    { length: Math.max(0, n - 2) },
    (_, i) => `  total += ${i} * ${JSON.stringify(opts.tag ?? name)}.length;`,
  );
  return `${opts.exported === false ? "" : "export "}function ${name}(items: number[]) {\n  let total = 0;\n${lines.join("\n")}\n  return total;\n}\n`;
}

describe("embedPending: lazy, bounded, resumable", () => {
  it("MIN_CODE_STMTS is 3 and functions below it are not embedded, with the count reported", async () => {
    expect(MIN_CODE_STMTS).toBe(3);
    const root = indexFiles({
      "src/a.ts": fn("two", 2) + fn("three", 3) + fn("one", 1),
    });
    const emb = fakeEmbedder();
    const r = await embedPending(store, { embedder: emb, root });
    expect(r).toMatchObject({ code: 1, belowFloor: 2, remaining: 0 });
    expect(emb.calls.flat()).toHaveLength(1);
  });

  it("cuts the normalized code to CODE_EMBED_MAX_CHARS", async () => {
    expect(CODE_EMBED_MAX_CHARS).toBe(1500);
    const root = indexFiles({ "src/a.ts": fn("huge", 400) + fn("short", 4) });
    const emb = fakeEmbedder();
    await embedPending(store, { embedder: emb, root });
    const lens = emb.calls.flat().map((t) => t.length);
    expect(Math.max(...lens)).toBe(CODE_EMBED_MAX_CHARS);
    expect(Math.min(...lens)).toBeLessThan(CODE_EMBED_MAX_CHARS);
  });

  it("orders work by backlog priority: entry and exported first, local last", async () => {
    const root = indexFiles({
      "src/a.ts": fn("localOne", 4, { exported: false }),
      "src/lib/b.ts": fn("exportedOne", 5),
      "src/routes/r.ts": fn("routeOne", 6, { exported: false }),
    });
    const emb = fakeEmbedder();
    await embedPending(store, { embedder: emb, root, batchSize: 1 });
    // `+=` lines tell the functions apart: exported 3, route 4, local 2
    const counts = emb.calls.flat().map((t) => (t.match(/\+=/g) ?? []).length);
    expect(counts).toEqual([3, 4, 2]); // both priority 0 (path order), then the local function
  });

  it("is resumable: an error mid-run keeps committed batches and the next run embeds only the rest", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) files[`src/f${i}.ts`] = fn(`f${i}`, 4, { tag: `t${i}` });
    const root = indexFiles(files);
    const good = fakeEmbedder();
    let calls = 0;
    const flaky: Embedder = {
      ...good,
      embed: async (t, k) => {
        if (++calls === 3) throw new Error("boom");
        return good.embed(t, k);
      },
    };
    await expect(embedPending(store, { embedder: flaky, root, batchSize: 2 })).rejects.toThrow("boom");
    expect(storedKeys(store, "vec_code").size).toBe(4); // two committed batches of 2
    const again = fakeEmbedder();
    const r = await embedPending(store, { embedder: again, root, batchSize: 2 });
    expect(r).toMatchObject({ code: 3, remaining: 0, stoppedBy: "complete" });
    expect(again.calls.flat()).toHaveLength(3);
    expect(storedKeys(store, "vec_code").size).toBe(7);
  });

  it("reports progress after every committed batch", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`src/f${i}.ts`] = fn(`f${i}`, 4, { tag: `t${i}` });
    const root = indexFiles(files);
    const seen: { done: number; total: number; phase: string }[] = [];
    await embedPending(store, {
      embedder: fakeEmbedder(),
      root,
      batchSize: 2,
      onProgress: (p) => seen.push({ done: p.done, total: p.total, phase: p.phase }),
    });
    expect(seen).toEqual([
      { done: 2, total: 5, phase: "code" },
      { done: 4, total: 5, phase: "code" },
      { done: 5, total: 5, phase: "code" },
    ]);
  });

  it("--budget: stops starting batches once the time budget is used", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`src/f${i}.ts`] = fn(`f${i}`, 4, { tag: `t${i}` });
    const root = indexFiles(files);
    let clock = 0;
    const base = fakeEmbedder();
    const slow: Embedder = {
      ...base,
      embed: async (t, k) => {
        clock += 100; // each batch "takes" 100 ms
        return base.embed(t, k);
      },
    };
    const r = await embedPending(store, {
      embedder: slow,
      root,
      batchSize: 1,
      timeBudgetMs: 250,
      now: () => clock,
    });
    expect(r.stoppedBy).toBe("budget");
    expect(r.code).toBe(2); // 0 + 100 <= 250, 100 + 100 <= 250, 200 + 100 > 250
    expect(r.remaining).toBe(8);
    expect(clock).toBeLessThanOrEqual(250);
  });

  it("stops on an abort signal after the batch in flight and keeps what it stored", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`src/f${i}.ts`] = fn(`f${i}`, 4, { tag: `t${i}` });
    const root = indexFiles(files);
    const ac = new AbortController();
    const r = await embedPending(store, {
      embedder: fakeEmbedder(),
      root,
      batchSize: 2,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.done >= 2) ac.abort();
      },
    });
    expect(r).toMatchObject({ code: 2, remaining: 4, stoppedBy: "aborted" });
    expect(storedKeys(store, "vec_code").size).toBe(2);
  });

  it("does not load the shared model when nothing is pending", async () => {
    const { resetEmbedderForTests } = await import("./index.js");
    resetEmbedderForTests();
    const root = indexFiles({ "src/a.ts": fn("tiny", 1) });
    // No embedder passed and no pending work: must return without calling getEmbedder (which would warn or download).
    const r = await embedPending(store, { root });
    expect(r).toMatchObject({ code: 0, descriptions: 0, remaining: 0, belowFloor: 1 });
  });
});
