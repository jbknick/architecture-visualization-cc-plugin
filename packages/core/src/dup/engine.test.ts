import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GantryConfigSchema, loadConfigForDb } from "../config/index.js";
import { contentKey } from "../describe/factsheet.js";
import { ensureVecTables, putVectors, vecAvailable } from "../embed/index.js";
import { MINHASH_PERMUTATIONS } from "../hash/index.js";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import type { FileRecord, SymbolRecord } from "../types.js";
import {
  type DupCandidate,
  dismiss,
  findDuplicates,
  findDuplicatesDetailed,
  rebuildSimilarEdges,
} from "./index.js";

// The fixture helper lives outside tsconfig rootDir (src), so load it dynamically by path.
interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

// The global config (~/.gantry/config.json) is read on every call: keep the developer's own out of the tests.
beforeAll(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "gantry-dup-home-"));
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

// --- helpers -------------------------------------------------------------------------------------

function tmpStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gantry-dup-"));
  const store = openStore(join(dir, "data", "gantry.db"));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

/** Seeded generator (mulberry32) so synthetic data is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMinhash(r: () => number): Uint32Array {
  const m = new Uint32Array(MINHASH_PERMUTATIONS);
  for (let i = 0; i < m.length; i++) m[i] = Math.floor(r() * 0xfffffffe);
  return m;
}

interface SymSpec {
  name: string;
  kind?: SymbolRecord["kind"];
  exported?: boolean;
  signature?: string;
  stmtCount?: number;
  exactHash: string;
  shapeHash: string;
  minhash: Uint32Array;
}

function addFile(store: Store, path: string, syms: SymSpec[]): SymbolRecord[] {
  const fileId = `file:${path}`;
  const file: FileRecord = {
    id: fileId,
    path,
    workspaceId: null,
    contentHash: path,
    mtimeMs: 0,
    deleted: false,
  };
  const records = syms.map(
    (s): SymbolRecord => ({
      id: `sym:${path}#${s.name}`,
      fileId,
      name: s.name,
      kind: s.kind ?? "function",
      exported: s.exported ?? true,
      signature: s.signature ?? "(a: string, b: number): string",
      startLine: 1,
      endLine: 10,
      loc: 10,
      complexity: 1,
      stmtCount: s.stmtCount ?? 8,
      exactHash: s.exactHash,
      shapeHash: s.shapeHash,
      minhash: s.minhash,
    }),
  );
  store.replaceFile("main", file, records, []);
  return records;
}

/** `m` with `n` slots changed: its MinHash Jaccard with `m` is (64 - n) / 64. */
function perturb(m: Uint32Array, n: number): Uint32Array {
  const out = Uint32Array.from(m);
  for (let i = 0; i < n; i++) out[i * 3] = ((out[i * 3] as number) + 1) >>> 0;
  return out;
}

const ids = (c: DupCandidate[]) => c.map((x) => x.symbolId);

// --- fixture pairs -------------------------------------------------------------------------------

async function fixtureStore(): Promise<{ store: Store; paths: GantryPaths; fx: MaterializedFixture }> {
  const fx = await materializeFixture("pnpm-turbo");
  const data = mkdtempSync(join(tmpdir(), "gantry-dup-data-"));
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  cleanups.push(async () => {
    store.close();
    rmSync(data, { recursive: true, force: true });
    await fx.cleanup();
  });
  return { store, paths, fx };
}

const sym = (store: Store, id: string): SymbolRecord => {
  const s = store.getSymbol(id);
  if (!s) throw new Error(`missing ${id}`);
  return s;
};

describe("fixture pnpm-turbo", () => {
  it("finds formatRelativeDate from parseTimestamp (misleading name) and the slugify copy as exact", async () => {
    const { store } = await fixtureStore();
    const parse = sym(store, "sym:packages/utils/src/time.ts#parseTimestamp");
    const fmt = "sym:packages/utils/src/date.ts#formatRelativeDate";
    const found = await findDuplicates(store, { symbol: parse });
    expect(ids(found)).toContain(fmt);
    const hit = found.find((c) => c.symbolId === fmt);
    // Same logic, different identifiers in the exact token stream: the near tier carries the misleading-name pair.
    expect(hit?.tier).toBe("near");
    expect(hit?.score).toBe(1);
    expect(ids(found)).not.toContain(parse.id);

    const slug = sym(store, "sym:packages/utils/src/slug.ts#slugify");
    const copy = "sym:apps/web/src/lib/slug.ts#slugify";
    const s = await findDuplicates(store, { symbol: slug });
    expect(s).toEqual([{ symbolId: copy, tier: "exact", score: 1 }]);
    // and the other way round
    expect(await findDuplicates(store, { symbol: sym(store, copy) })).toEqual([
      { symbolId: slug.id, tier: "exact", score: 1 },
    ]);
  });

  it("finds the same matches for unsaved code as for the indexed symbol", async () => {
    const { store, fx } = await fixtureStore();
    const parse = sym(store, "sym:packages/utils/src/time.ts#parseTimestamp");
    const indexed = await findDuplicates(store, { symbol: parse });
    const source = readFileSync(join(fx.dir, "packages/utils/src/time.ts"), "utf8");
    const unsaved = await findDuplicates(store, { code: { source, lang: "ts" } }, { excludeIds: [parse.id] });
    expect(unsaved).toEqual(indexed);

    // Unsaved code that was never written: renamed locals and a comment still hash the same.
    const edited = `// scratch\nexport function brandNew(a: Date, b: Date = new Date()): string {
  const x = b.getTime() - a.getTime();
  const s = Math.floor(x / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return \`\${d}d ago\`;
  if (h > 0) return \`\${h}h ago\`;
  if (m > 0) return \`\${m}m ago\`;
  return "just now";
}`;
    const fromScratch = await findDuplicates(store, { code: { source: edited, lang: "ts" } });
    expect(ids(fromScratch)).toEqual(expect.arrayContaining(ids(indexed)));
  });

  it("an unsaved copy of slugify is found exact in both places, with q.symbol excluding itself", async () => {
    const { store, fx } = await fixtureStore();
    const source = readFileSync(join(fx.dir, "apps/web/src/lib/slug.ts"), "utf8");
    const found = await findDuplicates(store, {
      code: { source, lang: "ts", path: "apps/web/src/lib/new.ts" },
    });
    expect(found.map((c) => [c.symbolId, c.tier]).sort()).toEqual([
      ["sym:apps/web/src/lib/slug.ts#slugify", "exact"],
      ["sym:packages/utils/src/slug.ts#slugify", "exact"],
    ]);
  });

  it("reports no function for code without one, and the below-floor tiers for tiny code", async () => {
    const { store } = await fixtureStore();
    const none = await findDuplicatesDetailed(store, { code: { source: "export const x = 1;", lang: "ts" } });
    expect(none.candidates).toEqual([]);
    expect(none.skipped.every((s) => s.reason === "no_function")).toBe(true);
    const tiny = await findDuplicatesDetailed(store, {
      code: { source: "export function f(a: number) { return a + 1; }", lang: "ts" },
    });
    expect(tiny.candidates).toEqual([]);
    expect(tiny.skipped.find((s) => s.tier === "exact")?.reason).toBe("below_statement_floor");
    expect(tiny.skipped.find((s) => s.tier === "near")?.reason).toBe("below_statement_floor");
  });

  it("rebuilds similar_to edges: one per pair, exact is high confidence, evidence is the tier", async () => {
    const { store } = await fixtureStore();
    const n = await rebuildSimilarEdges(store);
    const edges = store.effectiveEdges({ kind: ["similar_to"] });
    expect(edges).toHaveLength(n);
    const date = "sym:packages/utils/src/date.ts#formatRelativeDate";
    const time = "sym:packages/utils/src/time.ts#parseTimestamp";
    expect(edges).toContainEqual(
      expect.objectContaining({ src: date, dst: time, confidence: "high", evidence: ["near"] }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "sym:apps/web/src/lib/slug.ts#slugify",
        dst: "sym:packages/utils/src/slug.ts#slugify",
      }),
    );
    // Idempotent and deterministic.
    expect(await rebuildSimilarEdges(store)).toBe(n);
    expect(store.effectiveEdges({ kind: ["similar_to"] })).toEqual(edges);
  });
});

// --- synthetic store: tiers, filters, config ----------------------------------------------------------

describe("tiers and filters (synthetic hashes)", () => {
  const r = rng(7);
  const base = randomMinhash(r);

  function world() {
    const { store, dir } = tmpStore();
    const target = addFile(store, "src/a.ts", [
      { name: "target", exactHash: "E-target", shapeHash: "S-target", minhash: base },
    ])[0] as SymbolRecord;
    return { store, dir, target };
  }

  it("exact: same exactHash needs stmtCount >= 3; near: needs >= 6", async () => {
    const { store, target } = world();
    addFile(store, "src/b.ts", [
      { name: "dupe", exactHash: "E-target", shapeHash: "S-b", minhash: randomMinhash(r) },
    ]);
    addFile(store, "src/small.ts", [
      { name: "small", stmtCount: 2, exactHash: "E-target", shapeHash: "S-target", minhash: base },
      { name: "mid", stmtCount: 4, exactHash: "E-mid", shapeHash: "S-target", minhash: base },
    ]);
    const found = await findDuplicates(store, { symbol: target });
    expect(found).toEqual([{ symbolId: "sym:src/b.ts#dupe", tier: "exact", score: 1 }]);
  });

  it("near: same shape hash or Jaccard at the threshold, nothing below it, parameters within one", async () => {
    const { store, target } = world();
    addFile(store, "src/n.ts", [
      { name: "j94", exactHash: "E1", shapeHash: "S1", minhash: perturb(base, 4) }, // 60/64 = 0.9375
      { name: "j86", exactHash: "E2", shapeHash: "S2", minhash: perturb(base, 9) }, // 55/64 = 0.859
      { name: "j80", exactHash: "E3", shapeHash: "S3", minhash: perturb(base, 13) }, // 51/64 = 0.797
      { name: "sameShape", exactHash: "E4", shapeHash: "S-target", minhash: base },
      {
        name: "threeParams",
        exactHash: "E5",
        shapeHash: "S5",
        minhash: perturb(base, 2),
        signature: "(a: 1, b: 2, c: 3): void",
      },
    ]);
    const found = await findDuplicates(store, { symbol: target }, { limit: 20 });
    // target has 2 parameters; threeParams has 3 (within one).
    expect(found.map((c) => [c.symbolId.split("#")[1], c.tier])).toEqual([
      ["sameShape", "near"],
      ["threeParams", "near"],
      ["j94", "near"],
      ["j86", "near"],
    ]);
    const j94 = found.find((c) => c.symbolId.endsWith("j94"));
    expect(j94?.score).toBeCloseTo(60 / 64, 10);

    // A 4-parameter candidate is two away from the 2-parameter query and is dropped.
    addFile(store, "src/p.ts", [
      {
        name: "p4",
        exactHash: "E7",
        shapeHash: "S7",
        minhash: perturb(base, 1),
        signature: "(a: 1, b: 2, c: 3, d: 4): void",
      },
    ]);
    expect(ids(await findDuplicates(store, { symbol: target }, { limit: 20 }))).not.toContain(
      "sym:src/p.ts#p4",
    );
  });

  it("reads the thresholds from config on every call", async () => {
    const { store, dir, target } = world();
    addFile(store, "src/n.ts", [
      { name: "j80", exactHash: "E3", shapeHash: "S3", minhash: perturb(base, 13) },
    ]);
    expect(await findDuplicates(store, { symbol: target })).toEqual([]);
    const cfg = join(dir, "data", "config.json");
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ duplicates: { thresholds: { nearJaccard: 0.75 } } }));
    expect(ids(await findDuplicates(store, { symbol: target }))).toEqual(["sym:src/n.ts#j80"]);
    writeFileSync(cfg, JSON.stringify({ duplicates: { thresholds: { nearJaccard: 0.9 } } }));
    expect(await findDuplicates(store, { symbol: target })).toEqual([]);
    expect(
      loadConfigForDb(join(dir, "data", "gantry.db"), { HOME: dir }).duplicates.thresholds.nearJaccard,
    ).toBe(0.9);
  });

  it("only compares within a kind family", async () => {
    const { store, target } = world();
    addFile(store, "src/k.tsx", [
      { name: "Comp", kind: "component", exactHash: "E-target", shapeHash: "S-target", minhash: base },
      { name: "useThing", kind: "hook", exactHash: "E-target", shapeHash: "S-target", minhash: base },
      { name: "meth", kind: "method", exactHash: "E-target", shapeHash: "S-target", minhash: base },
    ]);
    expect(ids(await findDuplicates(store, { symbol: target }))).toEqual(["sym:src/k.tsx#meth"]);
    const comp = store.getSymbol("sym:src/k.tsx#Comp") as SymbolRecord;
    expect(await findDuplicates(store, { symbol: comp })).toEqual([]);
  });

  it("skips tests, fixtures, generated files and duplicates.ignore globs", async () => {
    const { store, target } = world();
    const twin = { exactHash: "E-target", shapeHash: "S-target", minhash: base };
    for (const p of [
      "src/a.test.ts",
      "src/a.spec.tsx",
      "src/__tests__/helper.ts",
      "fixtures/x/a.ts",
      "src/__fixtures__/a.ts",
      "src/api.gen.ts",
      "src/generated/api.ts",
      "src/__generated__/api.ts",
    ]) {
      addFile(store, p, [{ name: "twin", ...twin }]);
    }
    addFile(store, "legacy/old.ts", [{ name: "twin", ...twin }]);
    addFile(store, "src/real.ts", [{ name: "twin", ...twin }]);
    expect(ids(await findDuplicates(store, { symbol: target }))).toEqual([
      "sym:legacy/old.ts#twin",
      "sym:src/real.ts#twin",
    ]);
    const config = GantryConfigSchema.parse({
      ...loadConfigForDb(store.db.name, { HOME: "/nonexistent" }),
    });
    config.duplicates.ignore = ["legacy/**"];
    expect(ids(await findDuplicates(store, { symbol: target }, { config }))).toEqual([
      "sym:src/real.ts#twin",
    ]);
  });

  it("honours dismissals in both orders, and excludeIds", async () => {
    const { store, target } = world();
    const twin = { exactHash: "E-target", shapeHash: "S-target", minhash: base };
    addFile(store, "src/b.ts", [{ name: "b", ...twin }]);
    addFile(store, "src/c.ts", [{ name: "c", ...twin }]);
    expect(ids(await findDuplicates(store, { symbol: target }))).toEqual([
      "sym:src/b.ts#b",
      "sym:src/c.ts#c",
    ]);
    dismiss(store, "sym:src/b.ts#b", target.id, "intentional");
    expect(ids(await findDuplicates(store, { symbol: target }))).toEqual(["sym:src/c.ts#c"]);
    const b = store.getSymbol("sym:src/b.ts#b") as SymbolRecord;
    expect(ids(await findDuplicates(store, { symbol: b }))).toEqual(["sym:src/c.ts#c"]);
    dismiss(store, target.id, "sym:src/b.ts#b", "updated reason");
    const rows = store.db.prepare("SELECT a, b, reason FROM dismissals").all();
    expect(rows).toEqual([{ a: "sym:src/a.ts#target", b: "sym:src/b.ts#b", reason: "updated reason" }]);
    expect(ids(await findDuplicates(store, { symbol: target }, { excludeIds: ["sym:src/c.ts#c"] }))).toEqual(
      [],
    );
  });

  it("sorts by tier rank then score then id, stops at the limit and honours tiers", async () => {
    const { store, target } = world();
    addFile(store, "src/z.ts", [
      { name: "n1", exactHash: "N1", shapeHash: "S1", minhash: perturb(base, 2) },
      { name: "n2", exactHash: "N2", shapeHash: "S2", minhash: perturb(base, 6) },
      { name: "e2", exactHash: "E-target", shapeHash: "Sx", minhash: randomMinhash(r) },
      { name: "e1", exactHash: "E-target", shapeHash: "Sy", minhash: randomMinhash(r) },
      { name: "n0", exactHash: "N0", shapeHash: "S0", minhash: perturb(base, 2) },
    ]);
    const all = await findDuplicates(store, { symbol: target });
    expect(all.map((c) => [c.symbolId.split("#")[1], c.tier])).toEqual([
      ["e1", "exact"],
      ["e2", "exact"],
      ["n0", "near"],
      ["n1", "near"],
      ["n2", "near"],
    ]);
    expect(await findDuplicates(store, { symbol: target })).toEqual(all); // deterministic
    expect(await findDuplicates(store, { symbol: target }, { limit: 3 })).toEqual(all.slice(0, 3));
    expect(await findDuplicates(store, { symbol: target }, { limit: 0 })).toEqual([]);
    expect((await findDuplicates(store, { symbol: target }, { tiers: ["near"] })).map((c) => c.tier)).toEqual(
      ["near", "near", "near"],
    );
  });

  it("picks up changes written to the store after the first call", async () => {
    const { store, target } = world();
    expect(await findDuplicates(store, { symbol: target })).toEqual([]);
    addFile(store, "src/late.ts", [
      { name: "late", exactHash: "E-target", shapeHash: "S", minhash: randomMinhash(r) },
    ]);
    expect(ids(await findDuplicates(store, { symbol: target }))).toEqual(["sym:src/late.ts#late"]);
    store.markDeleted("main", "file:src/late.ts");
    expect(await findDuplicates(store, { symbol: target })).toEqual([]);
    // A write from another connection is seen too.
    const other = openStore(store.db.name);
    addFile(other, "src/other.ts", [
      { name: "o", exactHash: "E-target", shapeHash: "S", minhash: randomMinhash(r) },
    ]);
    other.close();
    expect(ids(await findDuplicates(store, { symbol: target }))).toEqual(["sym:src/other.ts#o"]);
  });

  it("working-layer edits override the main layer in queries", async () => {
    const { store, target } = world();
    addFile(store, "src/b.ts", [
      { name: "b", exactHash: "E-target", shapeHash: "S", minhash: randomMinhash(r) },
    ]);
    expect(ids(await findDuplicates(store, { symbol: target }))).toEqual(["sym:src/b.ts#b"]);
    const file: FileRecord = {
      id: "file:src/b.ts",
      path: "src/b.ts",
      workspaceId: null,
      contentHash: "w",
      mtimeMs: 1,
      deleted: false,
    };
    const changed: SymbolRecord = {
      ...(store.getSymbol("sym:src/b.ts#b") as SymbolRecord),
      exactHash: "E-other",
    };
    store.replaceFile("working", file, [changed], []);
    expect(await findDuplicates(store, { symbol: target })).toEqual([]);
  });
});

// --- vector tiers ------------------------------------------------------------------------------------

describe("vector tiers", () => {
  const D = 32;
  const unit = (i: number, j?: number, w = 0): Float32Array => {
    const v = new Float32Array(D);
    v[i] = 1;
    if (j !== undefined) v[j] = w;
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const r = rng(11);

  function vecWorld() {
    const { store } = tmpStore();
    if (!vecAvailable(store)) return null;
    ensureVecTables(store, D, "fake/test");
    const mk = (name: string, sig = "(a: string): string") =>
      addFile(store, `src/${name}.ts`, [
        { name, exactHash: `H-${name}`, shapeHash: `S-${name}`, minhash: randomMinhash(r), signature: sig },
      ])[0] as SymbolRecord;
    return { store, mk };
  }

  it("code_vector: cosine at or above the threshold, nearest first; semantic needs a compatible signature", async () => {
    const w = vecWorld();
    if (!w) return;
    const { store, mk } = w;
    const q = mk("q", "(a: string)"); // no return annotation: async-ness unknown
    const close = mk("close");
    const mid = mk("mid");
    const far = mk("far");
    const asyncOne = mk("asyncOne", "(a: string): Promise<string>");
    const manyParams = mk("many", "(a: 1, b: 2, c: 3, d: 4): string");
    const key = (s: SymbolRecord) => contentKey(s.exactHash);
    putVectors(store, "vec_code", [
      { contentKey: key(q), vector: unit(0) },
      { contentKey: key(close), vector: unit(0, 1, 0.1) }, // cosine 0.995
      { contentKey: key(mid), vector: unit(0, 1, 0.3) }, // cosine 0.958
      { contentKey: key(far), vector: unit(1) },
    ]);
    putVectors(store, "vec_descriptions", [
      { contentKey: key(q), vector: unit(2) },
      { contentKey: key(close), vector: unit(2, 3, 0.5) }, // 0.894
      { contentKey: key(mid), vector: unit(2, 3, 1.5) }, // 0.555
      { contentKey: key(asyncOne), vector: unit(2, 3, 0.2) }, // 0.98, async but q is unknown: compatible
      { contentKey: key(manyParams), vector: unit(2, 3, 0.1) }, // 0.995 but 4 params vs 1
      { contentKey: key(far), vector: unit(5) },
    ]);
    const code = await findDuplicates(store, { symbol: q }, { tiers: ["code_vector"] });
    expect(code.map((c) => [c.symbolId.split("#")[1], c.tier])).toEqual([["close", "code_vector"]]);
    expect(code[0]?.score).toBeCloseTo(1 / Math.hypot(1, 0.1), 5);

    // A lower threshold lets "mid" in, read on the next call.
    const config = loadConfigForDb(store.db.name, { HOME: "/nonexistent" });
    config.duplicates.thresholds.codeVector = 0.95;
    const wider = await findDuplicates(store, { symbol: q }, { tiers: ["code_vector"], config });
    expect(wider.map((c) => c.symbolId.split("#")[1])).toEqual(["close", "mid"]);

    const sem = await findDuplicates(store, { symbol: q }, { tiers: ["semantic"] });
    expect(sem.map((c) => c.symbolId.split("#")[1])).toEqual(["asyncOne", "close"]);
    // Everything together: vectors come after hashes and are deduplicated by symbol.
    const every = await findDuplicates(store, { symbol: q }, { limit: 20 });
    expect(every.map((c) => [c.symbolId.split("#")[1], c.tier])).toEqual([
      ["close", "code_vector"],
      ["asyncOne", "semantic"],
    ]);
  });

  it("semantic: async and sync functions with annotated returns do not match", async () => {
    const w = vecWorld();
    if (!w) return;
    const { store, mk } = w;
    const q = mk("q", "(a: string): string");
    const a = mk("a", "(a: string): Promise<string>");
    const key = (s: SymbolRecord) => contentKey(s.exactHash);
    putVectors(store, "vec_descriptions", [
      { contentKey: key(q), vector: unit(2) },
      { contentKey: key(a), vector: unit(2) },
    ]);
    expect(await findDuplicates(store, { symbol: q }, { tiers: ["semantic"] })).toEqual([]);
  });

  it("uses vectors the caller passes for unsaved code and for description text, and never embeds", async () => {
    const w = vecWorld();
    if (!w) return;
    const { store, mk } = w;
    const other = mk("other");
    const key = contentKey(other.exactHash);
    putVectors(store, "vec_code", [{ contentKey: key, vector: unit(0) }]);
    putVectors(store, "vec_descriptions", [{ contentKey: key, vector: unit(2) }]);
    const code = {
      source:
        "export function z(a: string, b: number) {\n  const x = a.length + b;\n  const y = x * 2;\n  const w = y - 1;\n  const v = w + x;\n  const u = v * y;\n  return u;\n}",
      lang: "ts" as const,
    };
    const without = await findDuplicatesDetailed(store, { code, description: "does a thing" });
    expect(without.candidates).toEqual([]);
    expect(without.skipped.map((s) => [s.tier, s.reason])).toEqual([
      ["code_vector", "not_embedded"],
      ["semantic", "not_embedded"],
    ]);
    const withVectors = await findDuplicatesDetailed(store, {
      code,
      description: "does a thing",
      vectors: { code: unit(0), description: unit(2) },
    });
    expect(withVectors.skipped).toEqual([]);
    expect(withVectors.candidates.map((c) => [c.symbolId, c.tier])).toEqual([[other.id, "code_vector"]]);
  });

  it("degrades when vectors are missing: exact and near still work, vector tiers say what was skipped", async () => {
    const { store, target } = (() => {
      const { store } = tmpStore();
      const m = randomMinhash(r);
      const [target] = addFile(store, "src/a.ts", [
        { name: "t", exactHash: "T", shapeHash: "St", minhash: m },
      ]);
      addFile(store, "src/b.ts", [{ name: "b", exactHash: "T", shapeHash: "Sb", minhash: randomMinhash(r) }]);
      return { store, target: target as SymbolRecord };
    })();
    const res = await findDuplicatesDetailed(store, { symbol: target });
    expect(ids(res.candidates)).toEqual(["sym:src/b.ts#b"]);
    if (vecAvailable(store)) {
      expect(res.skipped.map((s) => [s.tier, s.reason, s.message])).toEqual([
        ["code_vector", "not_embedded", "vector tiers unavailable: run gantry embed"],
        ["semantic", "no_description", "vector tiers unavailable: run gantry embed"],
      ]);
    }
    // sqlite-vec not loaded for this store: reported as unavailable, nothing thrown.
    store.setMeta("vec_available", "0");
    const off = await findDuplicatesDetailed(store, { symbol: target });
    expect(ids(off.candidates)).toEqual(["sym:src/b.ts#b"]);
    expect(off.skipped.map((s) => [s.tier, s.reason])).toEqual([
      ["code_vector", "vectors_unavailable"],
      ["semantic", "vectors_unavailable"],
    ]);
  });

  it("rebuildSimilarEdges adds low-confidence code_vector edges and a cheap rebuild keeps them", async () => {
    const w = vecWorld();
    if (!w) return;
    const { store, mk } = w;
    const a = mk("a");
    const b = mk("b");
    const c = mk("c");
    const ka = contentKey(a.exactHash);
    putVectors(store, "vec_code", [
      { contentKey: ka, vector: unit(0) },
      { contentKey: contentKey(b.exactHash), vector: unit(0, 1, 0.1) },
      { contentKey: contentKey(c.exactHash), vector: unit(7) },
    ]);
    expect(await rebuildSimilarEdges(store)).toBe(1);
    const edge = { src: a.id, dst: b.id, kind: "similar_to", confidence: "low", evidence: ["code_vector"] };
    expect(store.effectiveEdges({ kind: ["similar_to"] })).toEqual([expect.objectContaining(edge)]);
    expect(await rebuildSimilarEdges(store, { tiers: ["exact", "near"] })).toBe(0);
    expect(store.effectiveEdges({ kind: ["similar_to"] })).toEqual([expect.objectContaining(edge)]);
    // Dismissing removes the edge and keeps it away.
    dismiss(store, b.id, a.id, "ok");
    expect(store.effectiveEdges({ kind: ["similar_to"] })).toEqual([]);
    expect(await rebuildSimilarEdges(store)).toBe(0);
  });
});

describe("rebuildSimilarEdges (synthetic)", () => {
  it("covers exported or 6-statement symbols, one edge per pair, stronger tier wins, removes stale edges", async () => {
    const { store } = tmpStore();
    const r = rng(3);
    const m = randomMinhash(r);
    addFile(store, "src/a.ts", [
      { name: "a", exactHash: "E", shapeHash: "Sa", minhash: m },
      {
        name: "hidden",
        exported: false,
        stmtCount: 4,
        exactHash: "H",
        shapeHash: "Sh",
        minhash: randomMinhash(r),
      },
    ]);
    addFile(store, "src/b.ts", [
      { name: "b", exactHash: "E", shapeHash: "Sa", minhash: m }, // exact and near: exact wins
      { name: "c", exactHash: "C", shapeHash: "Sc", minhash: perturb(m, 4) }, // near to both
      {
        name: "hidden2",
        exported: false,
        stmtCount: 4,
        exactHash: "H",
        shapeHash: "Sh2",
        minhash: randomMinhash(r),
      },
    ]);
    const n = await rebuildSimilarEdges(store);
    const edges = store.effectiveEdges({ kind: ["similar_to"] });
    expect(n).toBe(edges.length);
    expect(edges.map((e) => [e.src, e.dst, e.confidence, e.evidence[0]])).toEqual([
      ["sym:src/a.ts#a", "sym:src/b.ts#b", "high", "exact"],
      ["sym:src/a.ts#a", "sym:src/b.ts#c", "high", "near"],
      ["sym:src/b.ts#b", "sym:src/b.ts#c", "high", "near"],
    ]); // the unexported 4-statement pair is exact-equal, but neither side is exported or has 6 statements
  });
});

// --- performance --------------------------------------------------------------------------------------

describe("performance", () => {
  it("checks one function against a 6,000-function index well inside the hook budget", async () => {
    const { store } = tmpStore();
    const r = rng(42);
    const FILES = 300;
    const PER_FILE = 20;
    let planted: SymbolRecord | undefined;
    const base = randomMinhash(r);
    for (let f = 0; f < FILES; f++) {
      const syms: SymSpec[] = [];
      for (let i = 0; i < PER_FILE; i++) {
        const k = f * PER_FILE + i;
        syms.push({
          name: `fn${k}`,
          exactHash: `E${k}`,
          shapeHash: `S${k}`,
          minhash: randomMinhash(r),
          stmtCount: 3 + (k % 12),
        });
      }
      if (f === 5)
        syms.push({ name: "exactTwin", exactHash: "E-q", shapeHash: "S-q", minhash: randomMinhash(r) });
      if (f === 9)
        syms.push({ name: "nearTwin", exactHash: "E-n", shapeHash: "S-n", minhash: perturb(base, 3) });
      const recs = addFile(store, `src/m${f}/file${f}.ts`, syms);
      if (f === 3) planted = recs[0];
    }
    const count = (store.db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
    expect(count).toBeGreaterThanOrEqual(6000);

    const query = {
      ...(planted as SymbolRecord),
      exactHash: "E-q",
      shapeHash: "S-query",
      minhash: base,
      stmtCount: 8,
    };
    const t0 = performance.now();
    const cold = await findDuplicates(store, { symbol: query }, { tiers: ["exact", "near", "code_vector"] });
    const coldMs = performance.now() - t0;
    expect(cold.map((c) => [c.symbolId.split("#")[1], c.tier])).toEqual([
      ["exactTwin", "exact"],
      ["nearTwin", "near"],
    ]);

    const runs = 20;
    const t1 = performance.now();
    for (let i = 0; i < runs; i++)
      await findDuplicates(store, { symbol: query }, { tiers: ["exact", "near", "code_vector"] });
    const warmMs = (performance.now() - t1) / runs;
    process.stderr.write(
      `dup perf: ${count} functions, cold (index build + query) ${coldMs.toFixed(1)} ms, warm query ${warmMs.toFixed(2)} ms\n`,
    );
    expect(warmMs).toBeLessThan(10);
    // A hook starts a fresh process per edit, so the cold path (index build included) is what counts. The
    // target is well under 100 ms; the bound is looser only so a busy machine does not fail the suite.
    expect(coldMs).toBeLessThan(250);

    // code_vector on 6,000 real-size (768-dimension) vectors: one KNN over the whole table.
    if (vecAvailable(store)) {
      const D = 768;
      ensureVecTables(store, D, "fake/perf");
      const vr = rng(5);
      const rows = (store.db.prepare("SELECT exact_hash FROM symbols").all() as { exact_hash: string }[]).map(
        (x) => {
          const v = new Float32Array(D);
          for (let i = 0; i < D; i++) v[i] = vr() - 0.5;
          return { contentKey: contentKey(x.exact_hash), vector: v };
        },
      );
      putVectors(store, "vec_code", rows);
      const q = rows[0] as { contentKey: string; vector: Float32Array };
      const t2 = performance.now();
      const withVec = await findDuplicates(
        store,
        { symbol: query, vectors: { code: q.vector } },
        { tiers: ["exact", "near", "code_vector"] },
      );
      const vecMs = performance.now() - t2;
      process.stderr.write(
        `dup perf: exact+near+code_vector with ${rows.length} vectors ${vecMs.toFixed(1)} ms\n`,
      );
      expect(vecMs).toBeLessThan(150);
      expect(withVec.map((c) => c.tier)).toEqual(["exact", "near", "code_vector"]);
    }
  });
});
