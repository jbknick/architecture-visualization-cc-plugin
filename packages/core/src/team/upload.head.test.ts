import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../heal/index.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { restrictScipEdges, type ScipResult } from "../scip/index.js";
import { openStore } from "../store/index.js";
import type { EdgeRecord } from "../types.js";
import { buildMainSnapshotChecked, buildMainSnapshotOfHead, sweepUploadLeftovers } from "./upload.js";

interface Fixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
interface Multirepo {
  root: string;
  repos: { web: string; api: string };
  cleanup(): Promise<void>;
}
const fixtureHelper = "../../test/helpers/fixture.js";
const uploadHelper = "../../test/helpers/upload-fixture.js";
const { materializeMultirepo } = (await import(/* @vite-ignore */ fixtureHelper)) as {
  materializeMultirepo: () => Promise<Multirepo>;
};
const { materializeUploadFixture } = (await import(/* @vite-ignore */ uploadHelper)) as {
  materializeUploadFixture: (name: string, opts: { dirName: string; origin?: string }) => Promise<Fixture>;
};
const scipFixture = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../fixtures/scip/pnpm-turbo.scip",
);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const dataDir = (): { dir: string; env: NodeJS.ProcessEnv } => {
  const dir = mkdtempSync(join(tmpdir(), "gantry-data-head-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { HOME: join(dir, "home"), CLAUDE_PLUGIN_DATA: dir } };
};
const upload = async (): Promise<{ fx: Fixture; paths: GantryPaths }> => {
  const fx = await materializeUploadFixture("pnpm-turbo", {
    dirName: "pnpm-turbo",
    origin: "https://github.com/fixture/pnpm-turbo.git",
  });
  cleanups.push(() => fx.cleanup());
  return { fx, paths: resolvePaths(fx.dir, dataDir().env) };
};
const body = async (paths: GantryPaths): Promise<string> =>
  JSON.stringify((await buildMainSnapshotOfHead(paths)).snapshot);

describe("a main snapshot of a multi-repo workspace", () => {
  async function workspace() {
    const mr = await materializeMultirepo();
    cleanups.push(() => mr.cleanup());
    writeFileSync(
      join(mr.root, "gantry-workspace.json"),
      JSON.stringify({
        repos: [
          { path: "./web", repo: "acme/web" },
          { path: "./api", repo: "acme/api" },
        ],
      }),
    );
    return { mr, web: resolvePaths(mr.repos.web, dataDir().env) };
  }

  it("keeps the edges into a sibling repo, as the user's own index has them", async () => {
    const { web } = await workspace();
    await rebuildIndex(web);
    const s = openStore(web.dbPath, { overlayPath: web.overlayPath, repo: web.repo });
    const own = buildMainSnapshotChecked(s, web).snapshot;
    s.close();
    const head = (await buildMainSnapshotOfHead(web)).snapshot;
    expect(head.edges).toEqual(own.edges);
    expect(head.edges).toHaveLength(13);
    const cross = head.edges.filter((e) => e.to.includes(":acme/api:"));
    expect(cross.map((e) => `${e.kind} ${e.to}`).sort()).toEqual([
      "calls sym:acme/api:packages/contracts/src/index.ts#formatDate",
      "imports file:acme/api:packages/contracts/src/index.ts",
    ]);
  });

  it("a dirty sibling repo changes nothing in the body", async () => {
    const { mr, web } = await workspace();
    const clean = await body(web);
    const contracts = join(mr.repos.api, "packages/contracts/src/index.ts");
    writeFileSync(
      contracts,
      `${readFileSync(contracts, "utf8")}\nexport function siblingDirty(): number {\n  return 1;\n}\n`,
    );
    writeFileSync(
      join(mr.repos.api, "packages/contracts/src/untracked.ts"),
      "export const siblingUntracked = 1;\n",
    );
    const text = await body(web);
    expect(text).not.toMatch(/siblingDirty|siblingUntracked/);
    expect(text).toBe(clean);
  });
});

describe("precise mode in a main upload", () => {
  it("reads precise.scip from the user's checkout, ignores file times, and differs from the inferred edges", async () => {
    const { fx, paths } = await upload();
    const plain = await body(paths);
    // The SCIP file is untracked, so it exists only in the user's checkout; it is older than every file.
    writeFileSync(join(fx.dir, "precise.scip"), readFileSync(scipFixture));
    const old = new Date(Date.now() - 3600 * 1000);
    utimesSync(join(fx.dir, "precise.scip"), old, old);
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.configPath, JSON.stringify({ precise: { scip: "precise.scip" } }));
    const precise = await body(paths);
    expect(precise).not.toBe(plain);
    expect(JSON.parse(precise).edges.length).toBeGreaterThan(0);
  });

  it("keeps only the SCIP edges whose ends are nodes of the index", () => {
    const edge = (src: string, dst: string): EdgeRecord => ({
      src,
      dst,
      kind: "calls",
      confidence: "high",
      count: 1,
      evidence: [],
      fileId: "file:r:a.ts",
      source: "scip",
    });
    const result: ScipResult = {
      edges: new Map([
        [
          "file:r:a.ts",
          [edge("sym:r:a.ts#f", "sym:r:b.ts#g"), edge("sym:r:a.ts#f", "sym:r:b.ts#uncommitted")],
        ],
      ]),
      stats: { documents: 1, edges: 2, unmapped: 0, stale: 0, otherRefs: 0 },
    };
    restrictScipEdges(result, new Set(["file:r:a.ts", "sym:r:a.ts#f", "sym:r:b.ts#g"]));
    expect(result.edges.get("file:r:a.ts")?.map((e) => e.dst)).toEqual(["sym:r:b.ts#g"]);
    expect(result.stats.edges).toBe(1);
  });
});

describe("the temporary checkout", () => {
  it("runs no smudge filter, whatever its name", async () => {
    const { fx, paths } = await upload();
    const marker = join(dataDir().dir, "smudge-ran");
    fx.git(["config", "filter.fake.smudge", `sh -c 'echo ran >> ${marker}; cat'`]);
    fx.git(["config", "filter.fake.clean", "cat"]);
    fx.git(["config", "filter.lfs.smudge", `sh -c 'echo lfs >> ${marker}; cat'`]);
    writeFileSync(join(fx.dir, ".gitattributes"), "*.ts filter=fake\n*.json filter=lfs\n");
    fx.git(["add", ".gitattributes"]);
    fx.git(["commit", "-q", "-m", "attributes"]);
    const built = await buildMainSnapshotOfHead(paths);
    expect(built.snapshot.symbols.length).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the sweep of leftovers", () => {
  it("removes stale registered worktrees and temp dirs of an upload that was killed, and keeps young ones", async () => {
    const { fx } = await upload();
    const scratch = mkdtempSync(join(tmpdir(), "gantry-sweep-"));
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    cleanups.push(() => {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    });
    const made = (name: string): string => join(scratch, name);
    const add = (dir: string) => fx.git(["worktree", "add", "--detach", "-q", dir, "HEAD"]);
    const stale = made("gantry-upload-head-stale");
    const young = made("gantry-upload-head-young");
    const gone = made("gantry-upload-head-gone");
    const other = made("someone-elses");
    for (const d of [stale, young, gone]) add(d);
    rmSync(gone, { recursive: true, force: true }); // registered, directory gone
    mkdirSync(other);
    const plain = made("gantry-upload-head-plain-old");
    mkdirSync(plain);
    const hours = (n: number) => new Date(Date.now() - n * 3600 * 1000);
    for (const d of [stale, plain, other]) utimesSync(d, hours(2), hours(2));

    sweepUploadLeftovers(fx.dir);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(other)).toBe(true); // not ours
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: fx.dir,
      encoding: "utf8",
    });
    expect(listed).toContain("gantry-upload-head-young");
    expect(listed).not.toContain("gantry-upload-head-stale");
    expect(listed).not.toContain("gantry-upload-head-gone");
  });
});
