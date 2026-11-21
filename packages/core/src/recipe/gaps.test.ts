import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { refreshWorking } from "../heal/index.js";
import { dumpGraph, indexRepo } from "../indexer.js";
import { openStore } from "../store/index.js";
import { looksLikeSql, openGaps, type RecipeGap } from "./gaps.js";
import { makeRepo, pathsFor } from "./testkit.js";

const helperPath = "../../test/helpers/fixture.js";
interface Fixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<Fixture>;
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function fixture(): Promise<Fixture> {
  const fx = await materializeFixture("pnpm-turbo");
  cleanups.push(() => fx.cleanup());
  return fx;
}

/** Indexes the committed tree into a fresh store and returns its gaps and the dump. */
async function gapsOf(dir: string): Promise<{ gaps: RecipeGap[]; dump: string }> {
  const paths = pathsFor(dir);
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  try {
    return { gaps: store.effectiveGaps(), dump: JSON.stringify(dumpGraph(store)) };
  } finally {
    store.close();
  }
}

const write = (dir: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

const commit = (fx: Fixture, msg: string): void => {
  fx.git(["add", "-A", "-f"]);
  fx.git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);
};

const ROUTE_FILE = [
  'import { Router } from "express";',
  "const router = Router();",
  'router.get("/health", () => {});',
  "export default router;",
  "",
].join("\n");
const SQL_FILE = [
  'import { sql } from "drizzle-orm";',
  "export const q = sql`SELECT * FROM posts`;",
  "",
].join("\n");

describe("recipe gaps", () => {
  it("has no dependency gap with the committed recipe, and none of the other kinds on the fixture", async () => {
    const fx = await fixture();
    const { gaps } = await gapsOf(fx.dir);
    expect(gaps).toEqual([]);
  });

  it("lists a new dependency, a route site and a SQL site, and nothing else", async () => {
    const fx = await fixture();
    const pkgPath = join(fx.dir, "apps/api/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies: Record<string, string> };
    pkg.dependencies.express = "^4.0.0";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    write(fx.dir, "apps/api/src/extra.ts", ROUTE_FILE);
    write(fx.dir, "apps/api/src/posts.ts", SQL_FILE);
    commit(fx, "add express and sql");
    const { gaps } = await gapsOf(fx.dir);
    expect(gaps.map((g) => [g.kind, g.file, g.line])).toEqual([
      ["dependency", "apps/api/package.json", 1],
      ["site", "apps/api/src/extra.ts", 3],
      ["site", "apps/api/src/posts.ts", 2],
    ]);
    expect(gaps[0]?.id).toBe("gap:dependency:@acme/api:express");
    expect(gaps[1]?.id).toBe('gap:site:apps/api/src/extra.ts#router.get("/health")');
    expect(gaps[2]?.id).toMatch(/^gap:site:apps\/api\/src\/posts\.ts#sql:[0-9a-f]{12}$/);
  });

  it("keeps the same set after an unrelated edit, and gives the same rows and dump twice", async () => {
    const fx = await fixture();
    write(fx.dir, "apps/api/src/extra.ts", ROUTE_FILE);
    commit(fx, "route");
    const first = await gapsOf(fx.dir);
    expect(first.gaps.length).toBe(1);
    const again = await gapsOf(fx.dir);
    expect(again.gaps).toEqual(first.gaps);
    expect(again.dump).toBe(first.dump);
    const utils = "packages/utils/src/index.ts";
    write(fx.dir, utils, `// an unrelated comment\n${readFileSync(join(fx.dir, utils), "utf8")}`);
    commit(fx, "comment");
    expect((await gapsOf(fx.dir)).gaps.map((g) => g.id)).toEqual(first.gaps.map((g) => g.id));
  });

  it("drops a gap whose id the recipe lists as dismissed", async () => {
    const fx = await fixture();
    write(fx.dir, "apps/api/src/extra.ts", ROUTE_FILE);
    commit(fx, "route");
    const id = 'gap:site:apps/api/src/extra.ts#router.get("/health")';
    expect((await gapsOf(fx.dir)).gaps.map((g) => g.id)).toEqual([id]);
    const recipePath = join(fx.dir, ".gantry/recipe.json");
    const recipe = JSON.parse(readFileSync(recipePath, "utf8")) as Record<string, unknown>;
    recipe.dismissed = [{ id, reason: "a health check the explorer does not need" }];
    writeFileSync(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
    commit(fx, "dismiss");
    expect((await gapsOf(fx.dir)).gaps).toEqual([]);
  });

  it("has no gaps without a recipe", async () => {
    const r = await makeRepo({
      "package.json": JSON.stringify({ name: "app", dependencies: { express: "^4" } }),
      "src/a.ts": ROUTE_FILE,
    });
    expect((await gapsOf(r.dir)).gaps).toEqual([]);
  });

  it("lists every dependency and site under an empty recipe", async () => {
    const r = await makeRepo({
      "package.json": JSON.stringify({ name: "app", dependencies: { express: "^4", zod: "^3" } }),
      ".gantry/recipe.json": JSON.stringify({ version: 1, dependencies: [], helpers: [], rules: [] }),
      "src/a.ts": ROUTE_FILE,
    });
    const { gaps } = await gapsOf(r.dir);
    expect(gaps.map((g) => g.id)).toEqual([
      "gap:dependency:.:express",
      "gap:dependency:.:zod",
      'gap:site:src/a.ts#router.get("/health")',
    ]);
  });

  it("lists a client call that no endpoint answers, with its file and line", async () => {
    const fx = await materializeFixture("adapters");
    cleanups.push(() => fx.cleanup());
    const { gaps } = await gapsOf(fx.dir);
    const call = gaps.find((g) => g.kind === "client_call" && g.id.endsWith("rpc posts.archive"));
    expect(call).toMatchObject({
      id: "gap:client_call:call:adapters:@demo/web:rpc posts.archive",
      file: "apps/web/src/hooks/usePostActions.ts",
      line: 12,
    });
    expect(
      gaps.filter((g) => g.kind === "client_call").every((g) => g.id.startsWith("gap:client_call:call:")),
    ).toBe(true);
  });

  it("recognises statements", () => {
    expect(looksLikeSql("  select id from t")).toBe(true);
    expect(looksLikeSql("UPDATE t SET a = 1")).toBe(true);
    expect(looksLikeSql("select a")).toBe(false);
    expect(looksLikeSql("please select from the list")).toBe(false);
  });
});

describe("recipe gaps in the working layer", () => {
  const ids = (gs: RecipeGap[]): string[] => gs.map((g) => g.id);
  const SITE = 'gap:site:apps/api/src/extra.ts#router.get("/health")';

  async function started() {
    const fx = await fixture();
    const paths = pathsFor(fx.dir);
    await indexRepo(paths, { layer: "main" });
    const read = <T>(fn: (s: ReturnType<typeof openStore>) => T): T => {
      const store = openStore(paths.dbPath);
      try {
        return fn(store);
      } finally {
        store.close();
      }
    };
    return { fx, paths, read, gaps: () => read((s) => s.effectiveGaps()) };
  }

  it("shows a gap from an uncommitted new file, and a second working run replaces the first", async () => {
    const { fx, paths, gaps } = await started();
    expect(gaps()).toEqual([]);
    write(fx.dir, "apps/api/src/extra.ts", ROUTE_FILE);
    await indexRepo(paths, { layer: "working" });
    expect(ids(gaps())).toEqual([SITE]);
    write(
      fx.dir,
      "apps/api/src/extra.ts",
      'import { Router } from "express";\nconst r = Router();\nr.post("/other", () => {});\n',
    );
    await indexRepo(paths, { layer: "working" });
    expect(ids(gaps())).toEqual(['gap:site:apps/api/src/extra.ts#r.post("/other")']);
  });

  it("drops the gap of a file removed in the working tree", async () => {
    const fx = await fixture();
    write(fx.dir, "apps/api/src/extra.ts", ROUTE_FILE);
    commit(fx, "route");
    const paths = pathsFor(fx.dir);
    await indexRepo(paths, { layer: "main" });
    rmSync(join(fx.dir, "apps/api/src/extra.ts"));
    await indexRepo(paths, { layer: "working" });
    const store = openStore(paths.dbPath);
    try {
      expect(store.effectiveGaps()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("goes back to the main set when the main set is replaced after a working run", async () => {
    const { fx, paths, read, gaps } = await started();
    write(fx.dir, "apps/api/src/extra.ts", ROUTE_FILE);
    await indexRepo(paths, { layer: "working" });
    expect(ids(gaps())).toEqual([SITE]);
    rmSync(join(fx.dir, "apps/api/src/extra.ts"));
    await indexRepo(paths, { layer: "main" });
    expect(gaps()).toEqual([]);
    expect(
      read((s) => s.db.prepare("SELECT COUNT(*) AS n FROM recipe_gaps WHERE layer = 'working'").get()),
    ).toEqual({ n: 0 });
    expect(read((s) => s.getMeta("recipe_gaps_working"))).toBeUndefined();
  });

  it("goes back to the main set when the tree is clean again", async () => {
    const { fx, paths, read, gaps } = await started();
    write(fx.dir, "apps/api/src/extra.ts", ROUTE_FILE);
    await indexRepo(paths, { layer: "working" });
    expect(ids(gaps())).toEqual([SITE]);
    rmSync(join(fx.dir, "apps/api/src/extra.ts"));
    await refreshWorking(paths);
    expect(gaps()).toEqual([]);
    expect(read((s) => s.getMeta("recipe_gaps_working"))).toBeUndefined();
  });

  it("hides a dismissed id from openGaps without an index run, counting the entries", async () => {
    const { fx, paths, read } = await started();
    write(fx.dir, "apps/api/src/extra.ts", ROUTE_FILE);
    await indexRepo(paths, { layer: "working" });
    expect(read((s) => openGaps(s, fx.dir))).toMatchObject({ dismissed: 0 });
    expect(read((s) => openGaps(s, fx.dir).gaps.length)).toBe(1);
    const recipePath = join(fx.dir, ".gantry/recipe.json");
    const recipe = JSON.parse(readFileSync(recipePath, "utf8")) as Record<string, unknown>;
    recipe.dismissed = [{ id: SITE, reason: "health check" }];
    writeFileSync(recipePath, JSON.stringify(recipe));
    expect(read((s) => openGaps(s, fx.dir))).toEqual({ gaps: [], dismissed: 1 });
  });
});
