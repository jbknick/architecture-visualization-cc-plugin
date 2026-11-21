import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dismiss, findDuplicates } from "../dup/engine.js";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore, resetStaleStore, type Store } from "./index.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const fixtures: MaterializedFixture[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function setup(): Promise<GantryPaths> {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  const data = mkdtempSync(join(tmpdir(), "gantry-overlay-"));
  dirs.push(data);
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  mkdirSync(paths.dataDir, { recursive: true });
  return paths;
}

const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");
const open = (paths: GantryPaths): Store => openStore(paths.dbPath, { overlayPath: paths.overlayPath });

/** The rebuild of a store from another version (spec section 9): drop the version, then `resetStaleStore`. */
function rebuild(paths: GantryPaths): void {
  const s = open(paths);
  s.setMeta("schema_version", "1");
  s.close();
  expect(resetStaleStore(paths).reset).toBe(true);
  expect(existsSync(paths.dbPath)).toBe(false);
}

function slugPair(store: Store): [string, string] {
  const rows = store.db
    .prepare("SELECT id FROM symbols WHERE name = 'slugify' AND layer = 'main' ORDER BY id")
    .all() as { id: string }[];
  expect(rows).toHaveLength(2);
  return [(rows[0] as { id: string }).id, (rows[1] as { id: string }).id];
}

describe("the overlay file (overlay.db)", () => {
  it("is created by the first openStore and holds the curation tables; gantry.db has none of them", async () => {
    const paths = await setup();
    expect(paths.overlayPath).toBe(join(paths.dataDir, "overlay.db"));
    const s = open(paths);
    expect(existsSync(paths.overlayPath)).toBe(true);
    const main = (
      s.db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(main).not.toContain("dismissals");
    expect(main).not.toContain("layouts");
    const ov = (
      s.db.prepare("SELECT name FROM overlay.sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(ov.sort()).toEqual([
      "anchor_families",
      "anchor_renames",
      "anchors",
      "dismissals",
      "group_rules",
      "groups",
      "hidden",
      "labels",
      "layouts",
      "views",
    ]);
    s.close();
  });

  it("defaults to overlay.db beside the store, and to memory for :memory:", async () => {
    const paths = await setup();
    const s = openStore(paths.dbPath);
    s.close();
    expect(existsSync(join(paths.dataDir, "overlay.db"))).toBe(true);
    const m = openStore(":memory:");
    expect(m.db.prepare("SELECT count(*) AS n FROM overlay.dismissals").get()).toEqual({ n: 0 });
    m.close();
  });

  it("dismiss writes a row to overlay.dismissals", async () => {
    const paths = await setup();
    const s = open(paths);
    dismiss(s, "sym:r:b.ts#b", "sym:r:a.ts#a", "because");
    expect(s.db.prepare("SELECT a, b, reason FROM overlay.dismissals").all()).toEqual([
      { a: "sym:r:a.ts#a", b: "sym:r:b.ts#b", reason: "because" },
    ]);
    s.close();
  });

  it("openStore then close leaves an existing overlay byte-identical", async () => {
    const paths = await setup();
    open(paths).close();
    const before = sha(paths.overlayPath);
    open(paths).close();
    open(paths).close();
    expect(sha(paths.overlayPath)).toBe(before);
  });

  it("a full index leaves the overlay byte-identical; a rebuild plus a full index too", async () => {
    const paths = await setup();
    open(paths).close();
    const before = sha(paths.overlayPath);
    await indexRepo(paths, { layer: "main" });
    expect(sha(paths.overlayPath)).toBe(before);
    rebuild(paths);
    expect(sha(paths.overlayPath)).toBe(before);
    await indexRepo(paths, { layer: "main" });
    expect(sha(paths.overlayPath)).toBe(before);
  });

  it("a dismissal survives a rebuild and a full index: the slugify pair stays out of findDuplicates", async () => {
    const paths = await setup();
    await indexRepo(paths, { layer: "main" });
    let s = open(paths);
    const [a, b] = slugPair(s);
    const symA = s.getSymbol(a);
    expect(symA).toBeDefined();
    if (!symA) return;
    const ids = async (st: Store, sym: typeof symA) =>
      (await findDuplicates(st, { symbol: sym })).map((c) => c.symbolId);
    expect(await ids(s, symA)).toContain(b);
    dismiss(s, a, b, "intentional");
    expect(await ids(s, symA)).not.toContain(b);
    s.close();

    rebuild(paths);
    await indexRepo(paths, { layer: "main" });

    s = open(paths);
    expect(slugPair(s)).toEqual([a, b]);
    expect(s.db.prepare("SELECT a, b, reason FROM overlay.dismissals").all()).toEqual([
      { a, b, reason: "intentional" },
    ]);
    const symA2 = s.getSymbol(a);
    const symB2 = s.getSymbol(b);
    if (!symA2 || !symB2) throw new Error("slugify symbols missing");
    expect(await ids(s, symA2)).not.toContain(b);
    expect(await ids(s, symB2)).not.toContain(a);
    s.close();
  });
});
