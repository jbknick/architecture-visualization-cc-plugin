import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import { heal, refreshWorking } from "./index.js";

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
  const data = mkdtempSync(join(tmpdir(), "gantry-heal-data-"));
  dataDirs.push(data);
  return resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
}

async function setup(name: "pnpm-turbo" | "single-pkg" = "pnpm-turbo") {
  const fx = await materializeFixture(name);
  fixtures.push(fx);
  const paths = pathsFor(fx.dir);
  await indexRepo(paths, { layer: "main" });
  return { fx, paths };
}

function dump(paths: GantryPaths) {
  const s = openStore(paths.dbPath);
  try {
    return JSON.stringify(dumpGraph(s));
  } finally {
    s.close();
  }
}

/** Dump of a fresh full index of whatever is checked out (the tree must be clean). */
async function freshDump(fx: MaterializedFixture): Promise<string> {
  const p = pathsFor(fx.dir);
  await indexRepo(p, { layer: "main" });
  return dump(p);
}

function write(fx: MaterializedFixture, rel: string, text: string): void {
  writeFileSync(join(fx.dir, rel), text);
}
function commit(fx: MaterializedFixture, msg: string, extra: string[] = []): void {
  fx.git(["add", "-A", "-f"]);
  fx.git(["commit", "-q", "-m", msg, ...extra]);
}
/** A commit that adds one function to `time.ts` and one new file. */
function featureCommit(fx: MaterializedFixture, tag: string): void {
  const time = readFileSync(join(fx.dir, "packages/utils/src/time.ts"), "utf8");
  write(
    fx,
    "packages/utils/src/time.ts",
    `${time}\nexport const ${tag}Hours = (n: number): number => n * 3600;\n`,
  );
  write(
    fx,
    `packages/utils/src/${tag}.ts`,
    `export function ${tag}Label(x: string): string {\n  return x + "${tag}";\n}\n`,
  );
  commit(fx, `feature ${tag}`);
}
function head(fx: MaterializedFixture): string {
  return fx.git(["rev-parse", "HEAD"]).trim();
}
function metaHead(paths: GantryPaths): string | undefined {
  const s = openStore(paths.dbPath);
  try {
    return s.getMeta("head_sha");
  } finally {
    s.close();
  }
}

describe("heal: git-flow matrix", () => {
  const cases: [string, (fx: MaterializedFixture) => void, ((fx: MaterializedFixture) => void)?][] = [
    [
      "checkout another branch",
      (fx) => {
        fx.git(["checkout", "-q", "-b", "other"]);
        featureCommit(fx, "alpha");
        fx.git(["checkout", "-q", "main"]);
        fx.git(["checkout", "-q", "other"]); // indexed at main, healed after switching
      },
    ],
    [
      "fast-forward merge",
      (fx) => {
        fx.git(["checkout", "-q", "-b", "other"]);
        featureCommit(fx, "alpha");
        fx.git(["checkout", "-q", "main"]);
        fx.git(["merge", "-q", "--ff-only", "other"]);
      },
    ],
    [
      "merge commit",
      (fx) => {
        fx.git(["checkout", "-q", "-b", "other"]);
        featureCommit(fx, "alpha");
        fx.git(["checkout", "-q", "main"]);
        write(
          fx,
          "packages/utils/src/slug.ts",
          `${readFileSync(join(fx.dir, "packages/utils/src/slug.ts"), "utf8")}\nexport const extraSlug = 1;\n`,
        );
        commit(fx, "main side");
        fx.git(["merge", "-q", "--no-ff", "-m", "merge", "other"]);
      },
    ],
    [
      "rebase",
      (fx) => {
        fx.git(["checkout", "-q", "-b", "other"]);
        featureCommit(fx, "alpha");
        fx.git(["checkout", "-q", "main"]);
        write(
          fx,
          "packages/utils/src/slug.ts",
          `${readFileSync(join(fx.dir, "packages/utils/src/slug.ts"), "utf8")}\nexport const extraSlug = 1;\n`,
        );
        commit(fx, "main side");
        fx.git(["checkout", "-q", "other"]);
        fx.git(["rebase", "-q", "main"]);
      },
    ],
    [
      "reset --hard HEAD~2",
      (fx) => {
        fx.git(["reset", "-q", "--hard", "HEAD~2"]);
      },
      (fx) => {
        featureCommit(fx, "alpha");
        featureCommit(fx, "beta");
      },
    ],
    [
      "amend",
      (fx) => {
        featureCommit(fx, "alpha");
        write(
          fx,
          "packages/utils/src/alpha.ts",
          "export function alphaLabel(x: string): string {\n  return x;\n}\n",
        );
        fx.git(["add", "-A"]);
        fx.git(["commit", "-q", "--amend", "--no-edit"]);
      },
    ],
    [
      "cherry-pick",
      (fx) => {
        fx.git(["checkout", "-q", "-b", "other"]);
        featureCommit(fx, "alpha");
        fx.git(["checkout", "-q", "main"]);
        fx.git(["cherry-pick", "other"]);
      },
    ],
    [
      "detached HEAD",
      (fx) => {
        fx.git(["checkout", "-q", "--detach", "HEAD~1"]);
      },
      (fx) => featureCommit(fx, "alpha"),
    ],
    [
      "commit with --no-verify",
      (fx) => {
        write(fx, "packages/utils/src/gamma.ts", "export const gamma = 3;\n");
        commit(fx, "skip hooks", ["--no-verify"]);
      },
    ],
    [
      "file deletion",
      (fx) => {
        fx.git(["rm", "-q", "packages/utils/src/time.ts"]);
        // time.ts has importers; removing the barrel line keeps the commit consistent
        const idx = readFileSync(join(fx.dir, "packages/utils/src/index.ts"), "utf8");
        write(
          fx,
          "packages/utils/src/index.ts",
          idx
            .split("\n")
            .filter((l) => !l.includes("time"))
            .join("\n"),
        );
        commit(fx, "remove time");
      },
    ],
  ];

  it.each(cases)("%s", async (_name, ops, pre) => {
    const fx = await materializeFixture("pnpm-turbo");
    fixtures.push(fx);
    pre?.(fx);
    const paths = pathsFor(fx.dir);
    await indexRepo(paths, { layer: "main" });
    ops(fx);
    const r = await heal(paths);
    expect(r.changed).toBeGreaterThan(0);
    expect(r.full).toBe(false);
    expect(metaHead(paths)).toBe(head(fx));
    expect(dump(paths)).toBe(await freshDump(fx));
    // Healing again is a no-op.
    expect(await heal(paths)).toMatchObject({ changed: 0, full: false });
  });
});

describe("heal: fallbacks and no-ops", () => {
  it("returns immediately when head_sha already matches HEAD", async () => {
    const { paths } = await setup();
    expect(await heal(paths)).toMatchObject({ changed: 0, full: false });
  });

  it("does a full re-index when the old sha is not a commit", async () => {
    const { fx, paths } = await setup();
    featureCommit(fx, "alpha");
    const r = await heal(paths, { from: "0123456789abcdef0123456789abcdef01234567" });
    expect(r.full).toBe(true);
    expect(dump(paths)).toBe(await freshDump(fx));
  });

  it("does a full re-index when nothing was indexed before", async () => {
    const fx = await materializeFixture("pnpm-turbo");
    fixtures.push(fx);
    const paths = pathsFor(fx.dir);
    const r = await heal(paths);
    expect(r.full).toBe(true);
    expect(metaHead(paths)).toBe(head(fx));
    expect(dump(paths)).toBe(await freshDump(fx));
  });

  it("does a full re-index when the diff touches more than 30% of the indexed files", async () => {
    const { fx, paths } = await setup();
    for (const f of ["a", "b", "c", "d", "e", "f", "g"]) {
      write(fx, `packages/utils/src/${f}.ts`, `export const ${f} = 1;\n`);
    }
    commit(fx, "many files");
    const r = await heal(paths);
    expect(r.full).toBe(true);
    expect(dump(paths)).toBe(await freshDump(fx));
  });

  it("honours --from by diffing against that commit", async () => {
    const { fx, paths } = await setup();
    const first = head(fx);
    featureCommit(fx, "alpha");
    // Pretend the recorded head is somewhere else entirely; --from says where main really was.
    const s = openStore(paths.dbPath);
    s.setMeta("head_sha", "0".repeat(40));
    s.close();
    const r = await heal(paths, { from: first });
    expect(r.full).toBe(false);
    expect(r.changed).toBe(2);
    expect(dump(paths)).toBe(await freshDump(fx));
  });

  it("reads blobs at HEAD, not the dirty working tree", async () => {
    const { fx, paths } = await setup();
    featureCommit(fx, "alpha");
    // Uncommitted rewrite of a file that the commit also changed.
    write(fx, "packages/utils/src/alpha.ts", "export function somethingElse(): number {\n  return 1;\n}\n");
    await heal(paths);
    const s = openStore(paths.dbPath);
    const names = (
      s.db
        .prepare(
          "SELECT name FROM symbols WHERE layer = 'main' AND file_id = 'file:packages/utils/src/alpha.ts'",
        )
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    s.close();
    expect(names).toEqual(["alphaLabel"]);
  });
});

describe("heal and the working layer", () => {
  const workingIds = (paths: GantryPaths): string[] => {
    const s = openStore(paths.dbPath);
    try {
      return (
        s.db.prepare("SELECT id FROM files WHERE layer = 'working' ORDER BY id").all() as { id: string }[]
      ).map((r) => r.id);
    } finally {
      s.close();
    }
  };

  it("keeps working rows for files that are still modified", async () => {
    const { fx, paths } = await setup();
    write(fx, "packages/utils/src/slug.ts", "export const dirtySlug = 1;\n");
    expect((await refreshWorking(paths)).reindexed).toBe(1);
    expect(workingIds(paths)).toContain("file:packages/utils/src/slug.ts");

    write(fx, "packages/utils/src/alpha.ts", "export const alpha = 1;\n");
    fx.git(["add", "packages/utils/src/alpha.ts"]);
    fx.git(["commit", "-q", "-m", "alpha only"]);
    const r = await heal(paths);
    expect(r.full).toBe(false);
    expect(workingIds(paths)).toContain("file:packages/utils/src/slug.ts");
    const s = openStore(paths.dbPath);
    const names = s.effectiveSymbols({ fileId: "file:packages/utils/src/slug.ts" }).map((x) => x.name);
    s.close();
    expect(names).toEqual(["dirtySlug"]);
  });

  it("clears working rows when the commit made main equal the tree", async () => {
    const { fx, paths } = await setup();
    write(fx, "packages/utils/src/slug.ts", "export const committedSlug = 1;\n");
    await refreshWorking(paths);
    expect(workingIds(paths)).toEqual(["file:packages/utils/src/slug.ts"]);
    commit(fx, "commit the dirty file");
    await heal(paths);
    expect(workingIds(paths)).toEqual([]);
    expect(dump(paths)).toBe(await freshDump(fx));
  });
});

describe("refreshWorking", () => {
  const rel = "packages/utils/src/slug.ts";
  const workingRows = (paths: GantryPaths) => {
    const s = openStore(paths.dbPath);
    try {
      return s.db.prepare("SELECT id, deleted FROM files WHERE layer = 'working' ORDER BY id").all() as {
        id: string;
        deleted: number;
      }[];
    } finally {
      s.close();
    }
  };

  it("re-indexes edits, tracks new and deleted files, and clears reverted ones", async () => {
    const { fx, paths } = await setup();
    const clean = dump(paths);

    write(fx, rel, "export const changedSlug = 1;\n");
    write(fx, "packages/utils/src/fresh.ts", "export const fresh = 1;\n");
    unlinkSync(join(fx.dir, "packages/utils/src/time.ts"));
    const r = await refreshWorking(paths);
    expect(r.reindexed).toBe(2);
    const rows = workingRows(paths);
    expect(rows.find((x) => x.id === "file:packages/utils/src/time.ts")?.deleted).toBe(1);
    expect(rows.map((x) => x.id)).toContain("file:packages/utils/src/fresh.ts");
    const s = openStore(paths.dbPath);
    const eff = s.effectiveFiles().map((f) => f.path);
    s.close();
    expect(eff).toContain("packages/utils/src/fresh.ts");
    expect(eff).not.toContain("packages/utils/src/time.ts");

    // The tree matches a fresh index of itself (main stays at HEAD, working holds the diff).
    const fresh = pathsFor(fx.dir);
    await indexRepo(fresh, { layer: "main" });
    expect(dump(paths)).toBe(dump(fresh));

    // Reverting through git drops every working row again.
    fx.git(["checkout", "--", "."]);
    fx.git(["clean", "-fdq"]);
    const r2 = await refreshWorking(paths);
    expect(r2.cleared).toBeGreaterThanOrEqual(3);
    expect(workingRows(paths)).toEqual([]);
    expect(dump(paths)).toBe(clean);
  });

  it("clears the working row when an edit is typed back to the committed text", async () => {
    const { fx, paths } = await setup();
    const original = readFileSync(join(fx.dir, rel), "utf8");
    write(fx, rel, `${original}\nexport const extra = 1;\n`);
    await refreshWorking(paths);
    expect(workingRows(paths)).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 20));
    write(fx, rel, original); // git status is clean again, mtime differs
    const r = await refreshWorking(paths);
    expect(r.cleared).toBe(1);
    expect(workingRows(paths)).toEqual([]);
  });

  it("takes under 150 ms when nothing changed", async () => {
    const { paths } = await setup();
    await refreshWorking(paths); // warm up git and sqlite
    const t0 = performance.now();
    const r = await refreshWorking(paths);
    const elapsed = performance.now() - t0;
    expect(r).toMatchObject({ reindexed: 0, cleared: 0 });
    expect(elapsed).toBeLessThan(150);
  });

  it("does nothing for a second call after the first has caught up", async () => {
    const { fx, paths } = await setup();
    write(fx, rel, "export const changedSlug = 1;\n");
    await refreshWorking(paths);
    expect(await refreshWorking(paths)).toMatchObject({ reindexed: 0, cleared: 0 });
  });
});

describe("concurrent heals", () => {
  const distCore = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
  it.skipIf(!existsSync(distCore))(
    "a second process waits on the lock, then no-ops",
    async () => {
      const { fx, paths } = await setup();
      featureCommit(fx, "alpha");
      const code = `
      const { heal, resolvePaths } = await import(${JSON.stringify(pathToFileURL(distCore).href)});
      const r = await heal(resolvePaths(${JSON.stringify(fx.dir)}));
      process.stdout.write(JSON.stringify(r));`;
      const env = {
        ...process.env,
        HOME: join(dirname(paths.dataDir), "..", "home"),
        CLAUDE_PLUGIN_DATA: dirname(dirname(paths.dataDir)),
      };
      const run = () =>
        new Promise<{ changed: number; full: boolean }>((resolve, reject) => {
          const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env });
          let out = "";
          let err = "";
          c.stdout.on("data", (d) => {
            out += d;
          });
          c.stderr.on("data", (d) => {
            err += d;
          });
          c.on("close", (n) => (n === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
        });
      const results = await Promise.all([run(), run()]);
      expect(results.map((r) => r.changed).sort()).toEqual([0, 2]);
      expect(dump(paths)).toBe(await freshDump(fx));
    },
    30_000,
  );
});
