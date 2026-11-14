import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { PARSE_CACHE_FILE } from "../parse/cache.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import { refreshWorking } from "./index.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

function pathsFor(dir: string): GantryPaths {
  const data = mkdtempSync(join(tmpdir(), "gantry-cache-data-"));
  dataDirs.push(data);
  return resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
}

async function setup() {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  const paths = pathsFor(fx.dir);
  await indexRepo(paths, { layer: "main" });
  return { fx, paths };
}

function dump(paths: GantryPaths): string {
  const s = openStore(paths.dbPath);
  try {
    return JSON.stringify(dumpGraph(s));
  } finally {
    s.close();
  }
}

/** Dump of a fresh full index (cold parse cache, its own data dir) of whatever is in the tree. */
async function freshDump(fx: MaterializedFixture): Promise<string> {
  const p = pathsFor(fx.dir);
  await indexRepo(p, { layer: "main" });
  return dump(p);
}

const write = (fx: MaterializedFixture, rel: string, text: string): void =>
  writeFileSync(join(fx.dir, rel), text);
const edit = (fx: MaterializedFixture, rel: string, fn: (text: string) => string): void =>
  write(fx, rel, fn(readFileSync(join(fx.dir, rel), "utf8")));
const pause = (): Promise<void> => new Promise((res) => setTimeout(res, 20));

/** Refreshes against the cache the main index left behind, then compares with a cold fresh index. */
async function expectSameAsFresh(fx: MaterializedFixture, paths: GantryPaths): Promise<void> {
  await refreshWorking(paths);
  expect(dump(paths)).toBe(await freshDump(fx));
}

describe("refreshWorking with a warm parse cache", () => {
  const cases: [string, (fx: MaterializedFixture) => void][] = [
    [
      "an edit renames an export that a barrel and another file import",
      (fx) =>
        edit(fx, "packages/utils/src/date.ts", (t) =>
          t.replace("export function formatRelativeDate", "export function formatRelative"),
        ),
    ],
    [
      "an edit removes an export that other files import",
      (fx) =>
        edit(fx, "packages/db/src/queries.ts", (t) =>
          t.replace("export async function createPost", "async function createPost"),
        ),
    ],
    [
      "an edit adds an export that a star re-export forwards",
      (fx) => edit(fx, "packages/db/src/schema.ts", (t) => `${t}\nexport const comments = users;\n`),
    ],
    [
      "an edit changes only a function body",
      (fx) =>
        edit(fx, "apps/web/src/lib/slug.ts", (t) =>
          t.replace('replace(/\\s+/g, "-")', 'replace(/\\s+/g, "_")'),
        ),
    ],
    [
      "a new file imports an existing export",
      (fx) =>
        write(
          fx,
          "apps/web/src/lib/fresh.ts",
          'import { slugify } from "./slug";\nexport const fresh = (s: string) => slugify(s);\n',
        ),
    ],
    ["a file is deleted", (fx) => unlinkSync(join(fx.dir, "packages/utils/src/time.ts"))],
  ];

  for (const [name, mutate] of cases) {
    it(`matches a fresh index when ${name}`, async () => {
      const { fx, paths } = await setup();
      mutate(fx);
      await expectSameAsFresh(fx, paths);
    });
  }

  it("matches a fresh index after two successive edits through the cache", async () => {
    const { fx, paths } = await setup();
    edit(fx, "packages/utils/src/date.ts", (t) => t.replace("formatRelativeDate", "formatRelative"));
    await refreshWorking(paths);
    await pause();
    edit(fx, "packages/utils/src/date.ts", (t) => t.replace("formatRelative(", "formatRelativeDate("));
    await expectSameAsFresh(fx, paths);
  });

  it("ignores a cache written by another version and one that is corrupt", async () => {
    const { fx, paths } = await setup();
    const file = join(paths.dataDir, PARSE_CACHE_FILE);
    expect(existsSync(file)).toBe(true);

    // Another version, with rows that would produce a wrong graph if they were trusted.
    const db = new Database(file);
    db.pragma("user_version = 999");
    db.prepare("UPDATE parsed SET data = ?").run(
      JSON.stringify({
        fileId: "x",
        symbols: [],
        imports: [],
        exports: [],
        sites: [],
        bodies: [],
        errors: [],
      }),
    );
    db.close();
    edit(fx, "packages/utils/src/date.ts", (t) => t.replace("formatRelativeDate", "formatRelative"));
    await expectSameAsFresh(fx, paths);

    // Not a database at all.
    writeFileSync(file, "garbage");
    await pause();
    edit(fx, "apps/web/src/lib/slug.ts", (t) => `${t}\nexport const z = 1;\n`);
    await expectSameAsFresh(fx, paths);
  });

  it("keeps entries for unchanged files and replaces the one that changed", async () => {
    const { fx, paths } = await setup();
    const db = new Database(join(paths.dataDir, PARSE_CACHE_FILE));
    const hashOf = (p: string) =>
      (db.prepare("SELECT hash FROM parsed WHERE path = ?").get(p) as { hash: string } | undefined)?.hash;
    const slug = "apps/web/src/lib/slug.ts";
    const date = "packages/utils/src/date.ts";
    const before = { slug: hashOf(slug), date: hashOf(date) };
    expect(before.slug).toBeDefined();
    edit(fx, date, (t) => `${t}\nexport const d = 1;\n`);
    await refreshWorking(paths);
    expect(hashOf(slug)).toBe(before.slug);
    expect(hashOf(date)).not.toBe(before.date);
    db.close();
  });
});
