import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import {
  CONSUMER_KINDS,
  ConsumerGraph,
  FAN_IN_ORDER,
  HUB_THRESHOLD,
  REACHABLE_NODE_CAP,
} from "./consumers.js";
import { reviewDiff } from "./diff.js";
import { computeImpact, modifiedChanges, reviewImpact } from "./impact.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture, materializeFiles } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (
    name: string,
    opts?: { feature?: boolean; dirName?: string },
  ) => Promise<MaterializedFixture>;
  materializeFiles: (files: Record<string, string>, repo?: string) => Promise<MaterializedFixture>;
};

const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function indexed(fx: MaterializedFixture) {
  fixtures.push(fx);
  const data = mkdtempSync(join(tmpdir(), "gantry-reachable-data-"));
  dataDirs.push(data);
  const paths: GantryPaths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  stores.push(store);
  return { paths, store };
}

const BASE = "sym:repo:packages/core/src/base.ts#base";

async function deepRadius() {
  const fx = await materializeFixture("deep-radius", { feature: true, dirName: "repo" });
  const { paths, store } = await indexed(fx);
  const diff = await reviewDiff(paths, "main", "feature");
  return { paths, store, diff };
}

describe("constants fitted by the blast-depth spike", () => {
  it("are the values of the spike's Decisions table", () => {
    expect(REACHABLE_NODE_CAP).toBe(2500);
    expect(FAN_IN_ORDER).toBe("desc");
  });
});

describe("the reachable tier on fixtures/deep-radius", () => {
  it("lists hops 4 to 6 beyond the unchanged first two tiers, ranked by confidence then fan-in", async () => {
    const { paths, store, diff } = await deepRadius();
    const impact = await reviewImpact(paths, store, diff);
    expect(impact.callersByHop.map((h) => h.hop)).toEqual([1, 2, 3]);
    expect(impact.reachable).toEqual({
      total: HUB_THRESHOLD + 7,
      byHop: [
        { hop: 4, count: HUB_THRESHOLD + 4 },
        { hop: 5, count: 2 },
        { hop: 6, count: 1 },
      ],
    });
    expect(impact.notes).toEqual([]);

    const base = impact.consumers.find((c) => c.id === BASE);
    expect(base?.reachableTotal).toBe(HUB_THRESHOLD + 7);
    const reachable = base?.reachable ?? [];
    const hop4 = reachable.filter((c) => c.hop === 4);
    // The hub's users are one hub entry (#294), so hop 4 lists the two chain nodes only; the total still counts them.
    expect(hop4.map((c) => c.name)).toEqual(["Runner.helper", "step4"]);
    expect(base?.hubs.map((h) => h.consumersTotal)).toEqual([HUB_THRESHOLD + 2]);
    expect(hop4.every((c) => c.pathConfidence === "high")).toBe(true);
    expect(
      reachable.filter((c) => c.hop >= 5).map((c) => [c.name, c.hop, c.pathConfidence, c.fanIn]),
    ).toEqual([
      ["zetaHigh", 5, "high", 1],
      ["Runner.alphaLow", 5, "low", 0],
      ["Page", 6, "high", 0],
    ]);
    // Direct and potential entries carry no reachable-only fields.
    for (const c of [...(base?.direct ?? []), ...(base?.potential ?? [])]) {
      expect(c).not.toHaveProperty("pathConfidence");
      expect(c).not.toHaveProperty("fanIn");
    }
  });

  it("a node cap stops the walk, says so in a note and leaves the first two tiers as they are", async () => {
    const { store, diff } = await deepRadius();
    const full = computeImpact(store, diff.changes, { files: diff.files.map((f) => f.path) });
    const capped = computeImpact(store, diff.changes, {
      files: diff.files.map((f) => f.path),
      reachableCap: 3,
    });
    expect(capped.reachable.total).toBe(0);
    expect(capped.notes).toEqual(["The reachable walk stopped at 3 nodes; deeper consumers are not listed."]);
    expect(capped.callersByHop).toEqual(full.callersByHop);
    const [a, b] = [capped.consumers[0], full.consumers[0]];
    expect(a?.direct).toEqual(b?.direct);
    expect(a?.potential).toEqual(b?.potential);
    expect(a?.reachableTotal).toBe(0);

    const wider = computeImpact(store, diff.changes, { reachableCap: 8 });
    // step1, step2, step3, hub, then four of hop 4 in sorted id order: the walk stops with the first four.
    expect(wider.reachable).toEqual({ total: 4, byHop: [{ hop: 4, count: 4 }] });
    expect(wider.notes).toEqual(["The reachable walk stopped at 8 nodes; deeper consumers are not listed."]);
  });

  it("reachable: false leaves everything else as it is, and is deterministic otherwise", async () => {
    const { store, diff } = await deepRadius();
    const files = diff.files.map((f) => f.path);
    const on = computeImpact(store, diff.changes, { files });
    const off = computeImpact(store, diff.changes, { files, reachable: false });
    expect(off.reachable).toEqual({ total: 0, byHop: [] });
    expect(off.consumers.every((c) => c.reachable.length === 0 && c.reachableTotal === 0)).toBe(true);
    // The hubs are listed from the reachable walk here, so they go with it.
    const strip = (i: typeof on) => ({
      ...i,
      reachable: undefined,
      hubs: undefined,
      consumers: i.consumers.map((c) => ({
        ...c,
        reachable: undefined,
        reachableTotal: undefined,
        hubs: undefined,
      })),
    });
    expect(strip(off)).toEqual(strip(on));
    expect(JSON.stringify(computeImpact(store, diff.changes, { files }))).toBe(JSON.stringify(on));
  });
});

describe("the reachable tier on fixtures/pnpm-turbo", () => {
  it("with Button's signature changed, the walk adds nothing the first two tiers or the risk show", async () => {
    const fx = await materializeFixture("pnpm-turbo");
    fx.git(["checkout", "-b", "feature"]);
    const file = join(fx.dir, "packages/ui/src/button.tsx");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "{ label, onClick }: { label: string; onClick?: () => void }",
        "{ label, onClick, size }: { label: string; onClick?: () => void; size?: number }",
      ),
    );
    fx.git(["add", "-A"]);
    fx.git(["commit", "-m", "button"]);
    fx.git(["checkout", "main"]);
    const { paths, store } = await indexed(fx);
    const diff = await reviewDiff(paths, "main", "feature");
    const on = await reviewImpact(paths, store, diff);
    const off = await reviewImpact(paths, store, diff, { reachable: false });
    const strip = (i: typeof on) => ({
      ...i,
      reachable: undefined,
      consumers: i.consumers.map((c) => ({ ...c, reachable: undefined, reachableTotal: undefined })),
    });
    expect(JSON.stringify(strip(on))).toBe(JSON.stringify(strip(off)));
    expect(on.risk.score).toBe(56);
    expect(on.callersByHop.map((h) => h.hop)).toEqual(off.callersByHop.map((h) => h.hop));
  });
});

// ---- equal output against a per-node reference walk ---------------------------------------------------------------

const N = 120;

/** A repo of N one-function files: f(i) calls f(i-1), one earlier function and, every tenth, a later one (a cycle). */
function syntheticFiles(): Record<string, string> {
  let seed = 12345;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const files: Record<string, string> = { "package.json": '{ "name": "synthetic", "private": true }\n' };
  for (let i = 0; i < N; i++) {
    const callees = new Set<number>();
    if (i > 0) callees.add(i - 1);
    if (i > 1) callees.add(next(i - 1));
    if (i % 10 === 0 && i + 5 < N) callees.add(i + 5);
    const sorted = [...callees].sort((a, b) => a - b);
    const imports = sorted.map((j) => `import { f${j} } from "./f${j}";\n`).join("");
    const body = sorted.length === 0 ? "x" : sorted.map((j) => `f${j}(x)`).join(" + ");
    files[`src/f${i}.ts`] = `${imports}export function f${i}(x: number): number {\n  return ${body};\n}\n`;
  }
  return files;
}

/**
 * The walk to the end read one node at a time with a store query each: nothing shared with the shipped path but the
 * rules (consumer edge kinds, no `ext:` sources or self edges, a hop's new nodes taken in sorted id order up to the
 * cap, each node at its first hop).
 */
function referenceWalk(store: Store, seed: string, direct: string[], cap: number): Map<string, number> {
  const hops = new Map<string, number>();
  let frontier: string[] = [];
  for (const d of [...direct].sort()) {
    if (hops.size >= cap) return hops;
    hops.set(d, 1);
    frontier.push(d);
  }
  for (let hop = 2; frontier.length > 0; hop++) {
    const found = new Set<string>();
    for (const node of frontier) {
      const kinds = node.startsWith("file:") ? [...CONSUMER_KINDS, "imports" as const] : [...CONSUMER_KINDS];
      for (const e of store.effectiveEdges({ dst: node, kind: kinds })) {
        if (e.src.startsWith("ext:") || e.src === node || e.src === seed || hops.has(e.src)) continue;
        found.add(e.src);
      }
    }
    frontier = [];
    for (const id of [...found].sort()) {
      if (hops.size >= cap) return hops;
      hops.set(id, hop);
      frontier.push(id);
    }
  }
  return hops;
}

describe("the reachable tier when the first tiers hit their 500-node stop", () => {
  it("still lists everything from hop 4 on, and leaves the first tiers, their note and the risk as they are", async () => {
    // 520 functions call `seed` (hop 1, more than the 500-node stop), and a chain of four more starts at one of them.
    const callers = Array.from(
      { length: 520 },
      (_, i) => `export function c${i}(): number { return seed(${i}); }`,
    ).join("\n");
    const fx = await materializeFiles(
      {
        "package.json": '{ "name": "wide", "private": true }\n',
        "src/seed.ts": "export function seed(x: number): number {\n  return x;\n}\n",
        "src/callers.ts": `import { seed } from "./seed";\n${callers}\n`,
        "src/chain.ts":
          'import { c0 } from "./callers";\nexport function d1(): number { return c0(); }\nexport function d2(): number { return d1(); }\nexport function d3(): number { return d2(); }\nexport function d4(): number { return d3(); }\n',
      },
      "wide",
    );
    const { store } = await indexed(fx);
    const changes = modifiedChanges(store, ["sym:wide:src/seed.ts#seed"]);
    const on = computeImpact(store, changes);
    const off = computeImpact(store, changes, { reachable: false });

    expect(on.callersByHop.reduce((n, h) => n + h.ids.length, 0)).toBe(500);
    expect(on.notes).toEqual(["The caller walk stopped at 500 nodes; deeper callers are not listed."]);
    // c0 is hop 1, d1 hop 2, d2 hop 3, d3 hop 4, d4 hop 5.
    expect(on.reachable).toEqual({
      total: 2,
      byHop: [
        { hop: 4, count: 1 },
        { hop: 5, count: 1 },
      ],
    });
    expect(on.consumers[0]?.reachable.map((c) => [c.name, c.hop])).toEqual([
      ["d3", 4],
      ["d4", 5],
    ]);
    expect(on.consumers[0]?.reachableTotal).toBe(2);
    const strip = (i: typeof on) => ({
      ...i,
      reachable: undefined,
      consumers: i.consumers.map((c) => ({ ...c, reachable: undefined, reachableTotal: undefined })),
    });
    expect(JSON.stringify(strip(on))).toBe(JSON.stringify(strip(off)));
  }, 60_000);
});

describe("the in-memory walk gives the output of a per-node reference walk", () => {
  it("on 9 seeds, the largest radius among them, at the default cap and at small caps", async () => {
    const fx = await materializeFiles(syntheticFiles(), "synthetic");
    const { store } = await indexed(fx);
    const seeds = [0, 1, 2, 3, 5, 8, 13, 40, 80].map((i) => `sym:synthetic:src/f${i}.ts#f${i}`);
    const radii: number[] = [];
    for (const seed of seeds) {
      const changes = modifiedChanges(store, [seed]);
      expect(changes).toHaveLength(1);
      const direct = [
        ...store.effectiveEdges({ dst: seed, kind: [...CONSUMER_KINDS] }).map((e) => e.src),
      ].filter((s) => s !== seed);
      for (const cap of [REACHABLE_NODE_CAP, 40, 7]) {
        const expected = referenceWalk(store, seed, [...new Set(direct)], cap);
        const impact = computeImpact(store, changes, { reachableCap: cap });
        const mine = impact.consumers[0];
        const wanted = [...expected].filter(([, hop]) => hop >= 4);
        const got = (mine?.reachable ?? []).map((c) => [c.id, c.hop] as const);
        expect(got.map(([id]) => id).sort()).toEqual(wanted.map(([id]) => id).sort());
        for (const [id, hop] of got) expect(expected.get(id)).toBe(hop);
        expect(mine?.reachableTotal).toBe(wanted.length);
        expect(impact.reachable.total).toBe(wanted.length);
        if (cap === REACHABLE_NODE_CAP) radii.push(expected.size);
      }
    }
    // The largest radius is among the seeds and reaches well past hop 3.
    expect(Math.max(...radii)).toBeGreaterThan(60);
    expect(radii.filter((n) => n > 3).length).toBeGreaterThan(5);
  }, 120_000);

  it("answers every incoming read from memory exactly as the per-node query does", async () => {
    const fx = await materializeFiles(syntheticFiles(), "synthetic");
    const { store } = await indexed(fx);
    const perNode = new ConsumerGraph(store);
    const loaded = new ConsumerGraph(store);
    loaded.preload();
    const ids = store.effectiveSymbols().map((s) => s.id);
    expect(ids.length).toBeGreaterThanOrEqual(N);
    for (const id of ids) expect(loaded.incoming(id)).toEqual(perNode.incoming(id));
    expect(loaded.fanIn(`sym:synthetic:src/f0.ts#f0`)).toBe(perNode.fanIn(`sym:synthetic:src/f0.ts#f0`));
  });
});
