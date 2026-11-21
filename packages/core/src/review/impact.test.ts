import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import { reviewDiff, type SymbolChange } from "./diff.js";
import { computeImpact, formatImpact, MAX_IMPACT_NODES, modifiedChanges, reviewImpact } from "./impact.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (
    name: string,
    opts?: { feature?: boolean; dirName?: string },
  ) => Promise<MaterializedFixture>;
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

/** A temp copy of fixtures/pnpm-turbo, indexed at `main` (the base of every review in this file). */
async function setup(prepare?: (fx: MaterializedFixture) => void) {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  if (prepare) {
    prepare(fx);
    commit(fx, "prepare");
  }
  const data = mkdtempSync(join(tmpdir(), "gantry-impact-data-"));
  dataDirs.push(data);
  const paths: GantryPaths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  stores.push(store);
  return { fx, paths, store };
}

const BUTTON = "sym:pnpm-turbo:packages/ui/src/button.tsx#Button";

function changeButtonSignature(fx: MaterializedFixture): void {
  fx.git(["checkout", "-b", "feature"]);
  write(
    fx,
    "packages/ui/src/button.tsx",
    read(fx, "packages/ui/src/button.tsx").replace(
      "{ label, onClick }: { label: string; onClick?: () => void }",
      "{ label, onClick, size }: { label: string; onClick?: () => void; size?: number }",
    ),
  );
  commit(fx, "button signature");
}

describe("impact on fixtures/pnpm-turbo", () => {
  it("a Button signature change reaches the pages that render it, crosses package to app and scores at least medium", async () => {
    const { fx, paths, store } = await setup();
    changeButtonSignature(fx);
    const diff = await reviewDiff(paths, "main", "feature");
    const impact = await reviewImpact(paths, store, diff);

    expect(impact.changed.map((c) => c.id)).toEqual([BUTTON]);
    expect(impact.changed[0]?.signatureChanged).toBe(true);
    const home = "sym:pnpm-turbo:apps/web/src/routes/index.tsx#HomePage";
    const profile = "sym:pnpm-turbo:apps/web/src/routes/settings/profile.tsx#ProfilePage";
    // The barrel re-exports button.tsx and no symbol of it renders Button, so the file itself is a direct consumer.
    expect(impact.callersByHop[0]).toEqual({
      hop: 1,
      ids: ["file:pnpm-turbo:packages/ui/src/index.ts", home, profile],
    });
    expect(impact.crossings).toEqual([
      { from: BUTTON, to: home, kind: "app" },
      { from: BUTTON, to: profile, kind: "app" },
    ]);
    // +30 signature, +6 for 3 direct consumers, +10 for 2 crossings, +10 no test imports button.tsx
    expect(impact.risk.score).toBe(56);
    expect(impact.risk.level).toBe("medium");
    expect(impact.risk.reasons).toEqual([
      "+30 signature changed on an exported symbol",
      "+6 3 direct callers",
      "+10 2 boundary crossings",
      "+10 changed function in a file no test imports",
    ]);
    expect(formatImpact(diff, impact)).toContain("Risk: medium (56/100)");
  });

  it("a test file that imports the changed file removes the untested points", async () => {
    const { fx, paths, store } = await setup((f) =>
      write(
        f,
        "packages/ui/src/button.test.tsx",
        'import { Button } from "./button";\nexport const sample = Button;\n',
      ),
    );
    changeButtonSignature(fx);
    const impact = await reviewImpact(paths, store, await reviewDiff(paths, "main", "feature"));
    // the test file imports button.tsx, so it is a fourth direct consumer (+8 instead of +6) and the untested 10 go
    expect(impact.risk.score).toBe(48);
    expect(impact.risk.reasons.join("\n")).not.toContain("no test imports");
  });

  it("removing an exported function that is still used gives a note and the removal points", async () => {
    const { fx, paths, store } = await setup();
    fx.git(["checkout", "-b", "feature"]);
    write(fx, "packages/utils/src/date.ts", "export const DATE_UNIT = 1;\n");
    commit(fx, "remove formatRelativeDate");
    const impact = await reviewImpact(paths, store, await reviewDiff(paths, "main", "feature"));
    const id = "sym:pnpm-turbo:packages/utils/src/date.ts#formatRelativeDate";
    expect(impact.changed.map((c) => `${c.kind} ${c.id}`)).toContain(`removed ${id}`);
    expect(impact.notes.join("\n")).toContain(`Removed export ${id} is still used by`);
    expect(impact.notes.join("\n")).toContain(
      "sym:pnpm-turbo:apps/web/src/routes/posts.$postId.tsx#PostPage",
    );
    expect(impact.risk.reasons).toContain("+30 removed exported symbol that still has callers");
    // the page is in an app and the removed function in a package
    expect(impact.crossings.some((c) => c.kind === "app" && c.from === id)).toBe(true);
  });

  it("notes new undeclared imports and added functions that duplicate indexed code", async () => {
    const { fx, paths, store } = await setup();
    fx.git(["checkout", "-b", "feature"]);
    write(
      fx,
      "packages/ui/src/card.tsx",
      `import { clsx } from "clsx";\n${read(fx, "packages/ui/src/card.tsx")}`,
    );
    write(
      fx,
      "apps/web/src/lib/slugCopy.ts",
      read(fx, "apps/web/src/lib/slug.ts").replace("slugify", "makeSlug"),
    );
    commit(fx, "imports and copy");
    const impact = await reviewImpact(paths, store, await reviewDiff(paths, "main", "feature"));
    expect(impact.notes).toContain('New undeclared import "clsx" in packages/ui/src/card.tsx:1.');
    expect(
      impact.notes.some((n) =>
        /^New function sym:pnpm-turbo:apps\/web\/src\/lib\/slugCopy\.ts#makeSlug duplicates sym:pnpm-turbo:apps\/web\/src\/lib\/slug\.ts#slugify \(/.test(
          n,
        ),
      ),
    ).toBe(true);
  });

  it("an added symbol has no callers and an unchanged branch has an empty impact", async () => {
    const { fx, paths, store } = await setup();
    fx.git(["checkout", "-b", "feature"]);
    write(
      fx,
      "packages/utils/src/slug.ts",
      `${read(fx, "packages/utils/src/slug.ts")}export const EXTRA = 1;\n`,
    );
    commit(fx, "add");
    const diff = await reviewDiff(paths, "main", "feature");
    const impact = computeImpact(store, diff.changes);
    expect(impact.callersByHop).toEqual([]);
    expect(impact.crossings).toEqual([]);
    expect(impact.risk).toEqual({ score: 0, level: "low", reasons: [] });
    const none = computeImpact(store, []);
    expect(none.changed).toEqual([]);
    expect(none.risk.score).toBe(0);
  });

  it("walks callers hop by hop, records the first hop and honors maxHops", async () => {
    const { store } = await setup();
    // slugify <- SLUG_VERSION (hop 1), and PostList calls apps/web slugify; use the web one: slugify <- PostList <- HomePage
    const changes = modifiedChanges(store, ["sym:pnpm-turbo:apps/web/src/lib/slug.ts#slugify"]);
    expect(changes).toHaveLength(1);
    const full = computeImpact(store, changes);
    expect(full.callersByHop).toEqual([
      { hop: 1, ids: ["sym:pnpm-turbo:apps/web/src/components/PostList.tsx#PostList"] },
      { hop: 2, ids: ["sym:pnpm-turbo:apps/web/src/routes/index.tsx#HomePage"] },
      // the route serves HomePage (route edges count as uses)
      { hop: 3, ids: ["route:pnpm-turbo:@acme/web:/"] },
    ]);
    const one = computeImpact(store, changes, { maxHops: 1 });
    expect(one.callersByHop).toEqual([
      { hop: 1, ids: ["sym:pnpm-turbo:apps/web/src/components/PostList.tsx#PostList"] },
    ]);
    // every caller is listed once, at its first hop
    const all = full.callersByHop.flatMap((h) => h.ids);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeLessThanOrEqual(MAX_IMPACT_NODES);
  });

  it("scores a changed function above complexity 15", async () => {
    const { store } = await setup();
    const [base] = modifiedChanges(store, ["sym:pnpm-turbo:apps/web/src/lib/slug.ts#slugify"]) as [
      SymbolChange,
    ];
    const hot: SymbolChange = {
      ...base,
      after: { ...(base.after as NonNullable<SymbolChange["after"]>), complexity: 20 },
    };
    const impact = computeImpact(store, [hot]);
    expect(impact.risk.reasons).toContain("+10 changed function with complexity above 15 (20)");
  });

  it("reports a client/server crossing when a use-client file calls server code", async () => {
    const { store } = await setup((f) =>
      write(
        f,
        "apps/web/src/components/PostList.tsx",
        `"use client";\n${read(f, "apps/web/src/components/PostList.tsx")}`,
      ),
    );
    const slugify = "sym:pnpm-turbo:apps/web/src/lib/slug.ts#slugify";
    const impact = computeImpact(store, modifiedChanges(store, [slugify]));
    expect(impact.crossings).toEqual([
      {
        from: slugify,
        to: "sym:pnpm-turbo:apps/web/src/components/PostList.tsx#PostList",
        kind: "client_server",
      },
    ]);
  });

  it("is deterministic: the same inputs give identical output", async () => {
    const { fx, paths, store } = await setup();
    changeButtonSignature(fx);
    const a = await reviewImpact(paths, store, await reviewDiff(paths, "main", "feature"));
    const b = await reviewImpact(paths, store, await reviewDiff(paths, "main", "feature"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("notes changed symbols the index does not know", async () => {
    const { store } = await setup();
    const ghost: SymbolChange = {
      id: "sym:pnpm-turbo:nowhere.ts#gone",
      kind: "removed",
      before: {
        id: "sym:pnpm-turbo:nowhere.ts#gone",
        path: "nowhere.ts",
        line: 1,
        signature: "gone()",
        exactHash: "x",
        kind: "function",
        exported: true,
        complexity: 1,
      },
      signatureChanged: false,
      exportedChanged: false,
      locDelta: -3,
    };
    const impact = computeImpact(store, [ghost]);
    expect(impact.notes[0]).toContain("not in the index");
    expect(impact.callersByHop).toEqual([]);
  });
});

describe("text summary of the reachable tier and hubs", () => {
  it("on deep-radius prints the reachable line, the reachable block and the hub line", async () => {
    const fx = await materializeFixture("deep-radius", { feature: true, dirName: "repo" });
    fixtures.push(fx);
    const data = mkdtempSync(join(tmpdir(), "gantry-impact-data-"));
    dataDirs.push(data);
    const paths: GantryPaths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    await indexRepo(paths, { layer: "main" });
    const store = openStore(paths.dbPath);
    stores.push(store);
    const diff = await reviewDiff(paths, "main", "feature");
    const impact = await reviewImpact(paths, store, diff);
    const lines = formatImpact(diff, impact).split("\n");
    const base = impact.consumers.find((c) => c.id.endsWith("#base"));
    expect(base?.reachableTotal).toBeGreaterThan(0);
    expect(lines).toContain(`  reachable (hop 4+): ${impact.reachable.total}`);
    expect(lines).toContain(`  Reachable (${base?.reachableTotal}):`);
    expect(lines.filter((l) => l.startsWith("  Hubs ("))).toEqual(["  Hubs (1):"]);
    expect(lines).toContain(
      `    hub (function, packages/core/src/hub.ts): ${base?.hubs[0]?.consumersTotal} consumers at hop 4 in 2 workspace(s)`,
    );
  });

  it("on pnpm-turbo adds no line when the tier is empty", async () => {
    const { fx, paths, store } = await setup();
    changeButtonSignature(fx);
    const diff = await reviewDiff(paths, "main", "feature");
    const impact = await reviewImpact(paths, store, diff);
    expect(impact.reachable.total).toBe(0);
    expect(formatImpact(diff, impact)).not.toMatch(/reachable|Reachable|Hubs/);
  });
});
