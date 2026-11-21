import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import { CONSUMER_KINDS, HUB_THRESHOLD, MAX_CONSUMER_WALK, MAX_CONSUMERS } from "./consumers.js";
import { reviewDiff } from "./diff.js";
import { computeImpact, formatImpact, modifiedChanges, reviewImpact } from "./impact.js";

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

function write(fx: MaterializedFixture, rel: string, text: string): void {
  const p = join(fx.dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const read = (fx: MaterializedFixture, rel: string): string => readFileSync(join(fx.dir, rel), "utf8");
function commit(fx: MaterializedFixture, message: string): void {
  fx.git(["add", "-A"]);
  fx.git(["commit", "-m", message]);
}

async function setup(prepare?: (fx: MaterializedFixture) => void) {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  if (prepare) {
    prepare(fx);
    commit(fx, "prepare");
  }
  const data = mkdtempSync(join(tmpdir(), "gantry-consumers-data-"));
  dataDirs.push(data);
  const paths: GantryPaths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  stores.push(store);
  return { fx, paths, store };
}

const BUTTON = "sym:pnpm-turbo:packages/ui/src/button.tsx#Button";
const HOME = "sym:pnpm-turbo:apps/web/src/routes/index.tsx#HomePage";
const PROFILE = "sym:pnpm-turbo:apps/web/src/routes/settings/profile.tsx#ProfilePage";

describe("consumers of a review's changes (#169)", () => {
  it("a component rendered elsewhere lists its renderers directly and their route and importers as potential", async () => {
    const { fx, paths, store } = await setup();
    fx.git(["checkout", "-b", "feature"]);
    write(
      fx,
      "packages/ui/src/button.tsx",
      read(fx, "packages/ui/src/button.tsx").replace("{label}", "{label.trim()}"),
    );
    commit(fx, "button body");
    const diff = await reviewDiff(paths, "main", "feature");
    const impact = await reviewImpact(paths, store, diff);
    const sym = impact.consumers.find((c) => c.id === BUTTON);
    expect(sym?.target).toBe("symbol");
    // sorted by workspace, then path, then name
    expect(sym?.direct.map((d) => [d.workspace, d.id, d.uses, d.crosses])).toEqual([
      ["@acme/ui", "file:pnpm-turbo:packages/ui/src/index.ts", ["imports"], []],
      ["@acme/web", HOME, ["renders"], ["app"]],
      ["@acme/web", PROFILE, ["renders"], ["app"]],
    ]);
    expect(sym?.direct[1]).toMatchObject({ name: "HomePage", kind: "component", line: 7, hop: 1 });
    expect(sym?.directTotal).toBe(3);
    const route = sym?.potential.find((p) => p.id === "route:pnpm-turbo:@acme/web:/");
    expect(route).toMatchObject({ hop: 2, via: HOME, next: HOME, uses: ["serves"], kind: "route" });
    // profile.tsx imports the barrel: reached through the barrel at hop 2
    expect(
      sym?.potential.find((p) => p.id === "file:pnpm-turbo:apps/web/src/routes/settings/profile.tsx"),
    ).toMatchObject({
      hop: 2,
      via: "file:pnpm-turbo:packages/ui/src/index.ts",
      uses: ["imports"],
    });
    expect(sym?.potentialTotal).toBe(sym?.potential.length);
    // no potential consumer repeats a direct one or the change itself
    const direct = new Set(sym?.direct.map((d) => d.id));
    expect(sym?.potential.some((p) => direct.has(p.id) || p.id === BUTTON)).toBe(false);

    // the changed file: the files that import it
    const file = impact.consumers.find((c) => c.id === "file:pnpm-turbo:packages/ui/src/button.tsx");
    expect(file?.target).toBe("file");
    expect(file?.direct.map((d) => d.id)).toEqual([
      "file:pnpm-turbo:packages/ui/src/index.ts",
      "file:pnpm-turbo:apps/web/src/routes/index.tsx",
      "file:pnpm-turbo:apps/web/src/routes/settings/profile.tsx",
    ]);
    expect(
      file?.direct.every((d) => d.uses.join() === "imports" && d.kind === "file" && d.line === null),
    ).toBe(true);

    const text = formatImpact(diff, impact);
    expect(text).toContain(`Consumers of ${BUTTON}:`);
    expect(text).toContain("Directly affected (3):");
    expect(text).toContain("HomePage (component, apps/web/src/routes/index.tsx:7) renders; crosses app");
    expect(text).toContain("Potentially affected (");
  });

  it("a type used by another file lists the code that references it", async () => {
    const { fx, paths, store } = await setup((f) => {
      write(f, "packages/ui/src/size.ts", "export type Size = number;\n");
      write(
        f,
        "packages/ui/src/sized.ts",
        'import type { Size } from "./size";\nexport function sized(s: Size): number {\n  return s;\n}\n',
      );
    });
    fx.git(["checkout", "-b", "feature"]);
    write(fx, "packages/ui/src/size.ts", "export type Size = number | string;\n");
    commit(fx, "size");
    const impact = await reviewImpact(paths, store, await reviewDiff(paths, "main", "feature"));
    const size = impact.consumers.find((c) => c.id === "sym:pnpm-turbo:packages/ui/src/size.ts#Size");
    expect(size?.direct.map((d) => [d.id, d.uses])).toEqual([
      ["sym:pnpm-turbo:packages/ui/src/sized.ts#sized", ["references_type"]],
    ]);
    // the walk and the risk follow references_type at hop 1 too
    expect(impact.callersByHop[0]?.ids).toEqual(["sym:pnpm-turbo:packages/ui/src/sized.ts#sized"]);
  });

  it("caps each tier at MAX_CONSUMERS and reports the total", async () => {
    const n = MAX_CONSUMERS + 5;
    const { store } = await setup((f) => {
      for (let i = 0; i < n; i++) {
        const name = `f${String(i).padStart(3, "0")}`;
        write(
          f,
          `apps/web/src/gen/${name}.ts`,
          `import { slugify } from "../lib/slug";\nexport function ${name}(): string {\n  return slugify("x");\n}\n`,
        );
      }
    });
    const impact = computeImpact(
      store,
      modifiedChanges(store, ["sym:pnpm-turbo:apps/web/src/lib/slug.ts#slugify"]),
    );
    const c = impact.consumers[0];
    expect(c?.directTotal).toBe(n + 1); // the generated callers and PostList
    expect(c?.direct).toHaveLength(MAX_CONSUMERS);
    const paths = c?.direct.map((d) => d.path) ?? [];
    expect([...paths].sort()).toEqual(paths);
    expect(c?.direct[0]?.id).toBe("sym:pnpm-turbo:apps/web/src/components/PostList.tsx#PostList");
  }, 60_000);
});

describe("a hub's consumers are one entry (#294)", () => {
  const BASE = "sym:repo:packages/core/src/base.ts#base";
  const HUB = "sym:repo:packages/core/src/hub.ts#hub";

  async function indexedFixture(fx: MaterializedFixture) {
    fixtures.push(fx);
    const data = mkdtempSync(join(tmpdir(), "gantry-hubs-data-"));
    dataDirs.push(data);
    const paths: GantryPaths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    await indexRepo(paths, { layer: "main" });
    const store = openStore(paths.dbPath);
    stores.push(store);
    return { paths, store };
  }

  const callers = (prefix: string, n: number, callee: string): string =>
    Array.from(
      { length: n },
      (_, i) =>
        `export function ${prefix}${String(i).padStart(3, "0")}(): number { return ${callee}(${i}); }`,
    ).join("\n");

  it("on deep-radius the hub's users are one entry, the totals and the first tiers are unchanged", async () => {
    const fx = await materializeFixture("deep-radius", { feature: true, dirName: "repo" });
    const { paths, store } = await indexedFixture(fx);
    const diff = await reviewDiff(paths, "main", "feature");
    const impact = await reviewImpact(paths, store, diff);
    const off = await reviewImpact(paths, store, diff, { reachable: false });
    const base = impact.consumers.find((c) => c.id === BASE);
    const baseOff = off.consumers.find((c) => c.id === BASE);

    expect(base?.hubs).toHaveLength(1);
    const entry = base?.hubs[0];
    expect(entry).toMatchObject({
      hub: HUB,
      name: "hub",
      kind: "function",
      path: "packages/core/src/hub.ts",
      workspace: "@deep/core",
      hop: 4,
      consumersTotal: HUB_THRESHOLD + 2,
      byWorkspace: [
        { workspace: "@deep/api", count: (HUB_THRESHOLD + 2) / 2 },
        { workspace: "@deep/web", count: (HUB_THRESHOLD + 2) / 2 },
      ],
    });
    expect(entry?.members).toHaveLength(MAX_CONSUMERS);
    expect(entry?.members.every((m) => m.next === HUB && m.hop === 4)).toBe(true);
    expect(impact.hubs).toEqual([{ hub: HUB, consumersTotal: HUB_THRESHOLD + 2 }]);

    // The users are in the entry only; the hub itself and the rest of its hop stay listed.
    expect(base?.reachable.some((c) => c.path.includes("hubUsers"))).toBe(false);
    expect(base?.reachable.filter((c) => c.hop === 4).map((c) => c.name)).toEqual(["Runner.helper", "step4"]);
    expect(base?.potential.map((c) => c.name)).toContain("hub");
    // Totals count the collapsed consumers as before.
    expect(base?.reachableTotal).toBe(HUB_THRESHOLD + 7);
    expect(impact.reachable.total).toBe(HUB_THRESHOLD + 7);

    // Nothing else moved: the first tiers, the callers, the crossings and the risk are those without the walk.
    expect(base?.direct).toEqual(baseOff?.direct);
    expect(base?.potential).toEqual(baseOff?.potential);
    expect(base?.potentialTotal).toBe(baseOff?.potentialTotal);
    expect(impact.callersByHop).toEqual(off.callersByHop);
    expect(impact.crossings).toEqual(off.crossings);
    expect(impact.risk).toEqual(off.risk);
    expect(off.hubs).toEqual([]);
  }, 120_000);

  it("a hub at hop 2 collapses its hop-3 consumers out of the potential tier", async () => {
    const fx = await materializeFiles(
      {
        "package.json": '{ "name": "hubbed", "private": true }\n',
        "src/seed.ts": "export function seed(x: number): number {\n  return x;\n}\n",
        "src/d1.ts": 'import { seed } from "./seed";\nexport function d1(): number { return seed(1); }\n',
        "src/hub.ts":
          'import { d1 } from "./d1";\nexport function hub(x: number): number { return d1() + x; }\nexport function other(): number { return d1(); }\n',
        "src/users.ts": `import { hub } from "./hub";\n${callers("u", HUB_THRESHOLD + 1, "hub")}\n`,
        "src/top.ts": 'import { u000 } from "./users";\nexport function top(): number { return u000(); }\n',
      },
      "hubbed",
    );
    const { store } = await indexedFixture(fx);
    const changes = modifiedChanges(store, ["sym:hubbed:src/seed.ts#seed"]);
    const impact = computeImpact(store, changes);
    const off = computeImpact(store, changes, { reachable: false });
    const c = impact.consumers[0];

    expect(c?.hubs.map((h) => [h.hub, h.hop, h.consumersTotal])).toEqual([
      ["sym:hubbed:src/hub.ts#hub", 3, MAX_CONSUMER_WALK - 2],
    ]);
    // The potential walk stops at MAX_CONSUMER_WALK nodes (hub and other, then the users), so it counts 498 of the 609 users.
    expect(c?.hubs[0]?.byWorkspace).toEqual([{ workspace: "hubbed", count: MAX_CONSUMER_WALK - 2 }]);
    expect(c?.hubs[0]?.members).toHaveLength(MAX_CONSUMERS);
    // d1 is hop 1, hub and other hop 2, the users hop 3 (collapsed), top hop 4 (listed: u000 is not a hub).
    expect(c?.potential.map((p) => [p.name, p.hop])).toEqual([
      ["hub", 2],
      ["other", 2],
    ]);
    expect(c?.potentialTotal).toBe(MAX_CONSUMER_WALK);
    expect(c?.potentialTotal).toBe(off.consumers[0]?.potentialTotal);
    expect(c?.reachable.map((r) => [r.name, r.hop])).toEqual([["top", 4]]);
    expect(impact.hubs).toEqual([
      { hub: "sym:hubbed:src/hub.ts#hub", consumersTotal: MAX_CONSUMER_WALK - 2 },
    ]);
    expect(impact.risk).toEqual(off.risk);
  }, 120_000);

  it("the direct tier never collapses: a changed hub keeps its direct consumers, a direct hub collapses its own", async () => {
    const fx = await materializeFiles(
      {
        "package.json": '{ "name": "direct", "private": true }\n',
        "src/seed.ts": "export function seed(x: number): number {\n  return x;\n}\n",
        "src/callers.ts": `import { seed } from "./seed";\n${callers("c", HUB_THRESHOLD + 1, "seed")}\n`,
        "src/mid.ts": 'import { seed } from "./seed";\nexport function mid(): number { return seed(1); }\n',
        "src/midusers.ts": `import { mid } from "./mid";\n${callers("m", HUB_THRESHOLD + 1, "mid")}\n`,
      },
      "direct",
    );
    const { store } = await indexedFixture(fx);
    const c = computeImpact(store, modifiedChanges(store, ["sym:direct:src/seed.ts#seed"])).consumers[0];
    // seed is itself above the threshold (the c's and mid): its direct consumers are all listed (up to the cap).
    expect(c?.directTotal).toBe(HUB_THRESHOLD + 2);
    expect(c?.direct).toHaveLength(MAX_CONSUMERS);
    expect(c?.direct.every((d) => d.hop === 1)).toBe(true);
    // mid is a direct consumer and a hub: it is listed, its callers are one entry.
    expect(c?.hubs.map((h) => [h.hub, h.hop, h.consumersTotal])).toEqual([
      ["sym:direct:src/mid.ts#mid", 2, MAX_CONSUMER_WALK],
    ]);
    expect(c?.potential).toEqual([]);
    expect(c?.potentialTotal).toBe(MAX_CONSUMER_WALK);
  }, 120_000);

  it("pnpm-turbo has no node above the threshold, so a Button change has no hubs and the first tiers are as before", async () => {
    const { store } = await setup();
    const sources = new Map<string, Set<string>>();
    for (const e of store.effectiveEdges({ kind: [...CONSUMER_KINDS, "imports"] })) {
      const set = sources.get(e.dst) ?? new Set<string>();
      set.add(e.src);
      sources.set(e.dst, set);
    }
    const largest = Math.max(0, ...[...sources.values()].map((s) => s.size));
    expect(largest).toBeLessThanOrEqual(HUB_THRESHOLD);

    const changes = modifiedChanges(store, [BUTTON]);
    const impact = computeImpact(store, changes);
    const off = computeImpact(store, changes, { reachable: false });
    expect(impact.hubs).toEqual([]);
    expect(impact.consumers.every((c) => c.hubs.length === 0)).toBe(true);
    const tiers = (i: typeof impact) =>
      i.consumers.map((c) => [c.direct, c.directTotal, c.potential, c.potentialTotal]);
    expect(tiers(impact)).toEqual(tiers(off));
    expect(impact.risk).toEqual(off.risk);
  });
});
