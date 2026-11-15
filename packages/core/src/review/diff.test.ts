import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { parseRange, type ReviewDiff, reviewDiff, type SymbolChange } from "./diff.js";

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
  const data = mkdtempSync(join(tmpdir(), "gantry-review-data-"));
  dataDirs.push(data);
  return resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
}

async function setup() {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  return { fx, paths: pathsFor(fx.dir) };
}

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

const stable = (d: ReviewDiff) => ({ ...d, ms: 0 });
const byId = (d: ReviewDiff, id: string): SymbolChange => {
  const c = d.changes.find((x) => x.id === id);
  if (!c)
    throw new Error(`no change for ${id}; have ${d.changes.map((x) => `${x.kind}:${x.id}`).join(", ")}`);
  return c;
};

/** Every scenario of the issue, on one branch of a temp copy of fixtures/pnpm-turbo. */
function applyScenarios(fx: MaterializedFixture): void {
  // body change
  write(
    fx,
    "packages/utils/src/date.ts",
    read(fx, "packages/utils/src/date.ts").replace('"just now"', '"now"'),
  );
  // signature change only: a new defaulted parameter, same body
  write(
    fx,
    "packages/utils/src/time.ts",
    read(fx, "packages/utils/src/time.ts").replace(
      "current: Date = new Date()",
      "current: Date = new Date(), tz = 0",
    ),
  );
  // added
  write(
    fx,
    "packages/utils/src/slug.ts",
    `${read(fx, "packages/utils/src/slug.ts")}export function slugifyAll(xs: string[]): string[] {\n  return xs.map((x) => slugify(x));\n}\n`,
  );
  // removed (and the import that used it)
  write(fx, "packages/ui/src/internal.ts", "// Not exposed by the exports map.\n");
  // export flip: same code, no longer exported
  write(
    fx,
    "apps/web/src/lib/slug.ts",
    read(fx, "apps/web/src/lib/slug.ts").replace("export function slugify", "function slugify"),
  );
  // move to another file (the old file stays with other code, so git sees no file rename)
  const hook = read(fx, "apps/web/src/hooks/useDebounce.ts");
  write(fx, "apps/web/src/hooks/useDebounce.ts", "export const DEBOUNCE_DEFAULT_MS = 250;\n");
  write(fx, "apps/web/src/lib/debounce.ts", hook);
  // rename in place
  write(
    fx,
    "packages/db/src/queries.ts",
    read(fx, "packages/db/src/queries.ts").replace(/\blistPosts\b/g, "listAllPosts"),
  );
  // import changes
  write(
    fx,
    "packages/ui/src/card.tsx",
    `import { clsx } from "clsx";\n${read(fx, "packages/ui/src/card.tsx")}`,
  );
}

describe("reviewDiff on fixtures/pnpm-turbo branches", () => {
  it("classifies added, removed, modified, signature-only, export flip, moved and renamed", async () => {
    const { fx, paths } = await setup();
    // sanity: the fixture has what the scenarios edit
    expect(read(fx, "packages/db/src/queries.ts")).toContain("listPosts");
    fx.git(["checkout", "-b", "feature"]);
    applyScenarios(fx);
    commit(fx, "scenarios");

    const d = await reviewDiff(paths, "main", "feature");
    const out = d.changes.map((c) => `${c.kind} ${c.id}`);

    const body = byId(d, "sym:packages/utils/src/date.ts#formatRelativeDate");
    expect(body.kind).toBe("modified");
    expect(body.signatureChanged).toBe(false);
    expect(body.exportedChanged).toBe(false);
    expect(body.before?.exactHash).not.toBe(body.after?.exactHash);

    const sig = byId(d, "sym:packages/utils/src/time.ts#parseTimestamp");
    expect(sig.kind).toBe("modified");
    expect(sig.signatureChanged).toBe(true);
    expect(sig.after?.signature).toContain("tz = 0");

    const added = byId(d, "sym:packages/utils/src/slug.ts#slugifyAll");
    expect(added.kind).toBe("added");
    expect(added.before).toBeUndefined();
    expect(added.locDelta).toBe(3);

    const flip = byId(d, "sym:apps/web/src/lib/slug.ts#slugify");
    expect(flip.kind).toBe("modified");
    expect(flip.exportedChanged).toBe(true);
    expect(flip.signatureChanged).toBe(false);
    expect(flip.before?.exactHash).toBe(flip.after?.exactHash);

    const moved = byId(d, "sym:apps/web/src/lib/debounce.ts#useDebounce");
    expect(moved.kind).toBe("moved");
    expect(moved.before?.id).toBe("sym:apps/web/src/hooks/useDebounce.ts#useDebounce");
    expect(moved.before?.path).toBe("apps/web/src/hooks/useDebounce.ts");
    expect(moved.after?.path).toBe("apps/web/src/lib/debounce.ts");
    expect(moved.locDelta).toBe(0);

    const renamed = byId(d, "sym:packages/db/src/queries.ts#listAllPosts");
    expect(renamed.kind).toBe("renamed");
    expect(renamed.before?.id).toBe("sym:packages/db/src/queries.ts#listPosts");

    // the constant removed from internal.ts is a removal, and the new constant in useDebounce.ts an addition
    expect(out).toContain("removed sym:packages/ui/src/internal.ts#INTERNAL_PADDING");
    expect(byId(d, "sym:packages/ui/src/internal.ts#INTERNAL_PADDING").after).toBeUndefined();
    expect(out).toContain("added sym:apps/web/src/hooks/useDebounce.ts#DEBOUNCE_DEFAULT_MS");

    expect(d.importChanges).toContainEqual({
      path: "packages/ui/src/card.tsx",
      added: ["clsx"],
      removed: [],
    });
    expect(d.files.map((f) => f.path)).toEqual([...d.files.map((f) => f.path)].sort());
    expect(d.files.find((f) => f.path === "apps/web/src/lib/debounce.ts")?.status).toBe("A");
    expect(d.base).toBe("main");
    expect(d.head).toBe("feature");
    expect(d.mergeBase).toBe(fx.git(["rev-parse", "main"]).trim());
    // nothing unrelated is reported
    expect(d.changes.every((c) => !c.id.includes("apps/api"))).toBe(true);
  });

  it("detects a renamed file as a move, with a content change inside it as a move of the same name", async () => {
    const { fx, paths } = await setup();
    fx.git(["checkout", "-b", "renamefile"]);
    fx.git(["mv", "packages/utils/src/time.ts", "packages/utils/src/clock.ts"]);
    commit(fx, "rename file");
    let d = await reviewDiff(paths, "main", "renamefile");
    expect(d.files).toEqual([{ path: "packages/utils/src/clock.ts", status: "R" }]);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]?.kind).toBe("moved");
    expect(d.changes[0]?.id).toBe("sym:packages/utils/src/clock.ts#parseTimestamp");

    write(
      fx,
      "packages/utils/src/clock.ts",
      read(fx, "packages/utils/src/clock.ts").replace('"just now"', '"moments ago"'),
    );
    commit(fx, "edit renamed file");
    d = await reviewDiff(paths, "main", "renamefile");
    expect(d.changes.map((c) => c.kind)).toEqual(["moved"]);
    expect(d.changes[0]?.before?.exactHash).not.toBe(d.changes[0]?.after?.exactHash);
  });

  it("reports a deleted file's functions as removed and ignores non-source files", async () => {
    const { fx, paths } = await setup();
    fx.git(["checkout", "-b", "del"]);
    fx.git(["rm", "-q", "packages/utils/src/time.ts"]);
    write(fx, "README.md", "hello\n");
    write(fx, ".env", "SECRET=1\n");
    commit(fx, "delete");
    const d = await reviewDiff(paths, "main", "del");
    expect(d.files).toEqual([{ path: "packages/utils/src/time.ts", status: "D" }]);
    expect(d.changes.map((c) => `${c.kind} ${c.id}`)).toEqual([
      "removed sym:packages/utils/src/time.ts#parseTimestamp",
    ]);
    expect(d.changes[0]?.locDelta).toBeLessThan(0);
    expect(d.importChanges).toEqual([]);
  });

  it("diffs from the merge base: changes that landed on base after the branch point are not the branch's", async () => {
    const { fx, paths } = await setup();
    fx.git(["checkout", "-b", "topic"]);
    write(fx, "packages/utils/src/extra.ts", "export function extra(): number {\n  return 1;\n}\n");
    commit(fx, "topic");
    fx.git(["checkout", "main"]);
    write(fx, "packages/utils/src/other.ts", "export function other(): number {\n  return 2;\n}\n");
    commit(fx, "main moved on");
    const d = await reviewDiff(paths, "main", "topic");
    expect(d.mergeBase).not.toBe(fx.git(["rev-parse", "main"]).trim());
    expect(d.changes.map((c) => c.id)).toEqual(["sym:packages/utils/src/extra.ts#extra"]);
    expect(d.changes[0]?.kind).toBe("added");
  });

  it("is deterministic and writes nothing: store untouched, no store created, working tree clean", async () => {
    const { fx, paths } = await setup();
    await indexRepo(paths, { layer: "main" });
    const sum = () => createHash("sha256").update(readFileSync(paths.dbPath)).digest("hex");
    fx.git(["checkout", "-b", "feature"]);
    applyScenarios(fx);
    commit(fx, "scenarios");
    fx.git(["checkout", "main"]);
    const before = sum();
    const a = await reviewDiff(paths, "main", "feature");
    const b = await reviewDiff(paths, "main", "feature");
    expect(JSON.stringify(stable(a))).toBe(JSON.stringify(stable(b)));
    expect(sum()).toBe(before);
    expect(existsSync(`${paths.dbPath}-wal`)).toBe(false);
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
    expect(fx.git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");

    // and with no store at all: still works and creates nothing
    const fresh = await setup();
    fresh.fx.git(["checkout", "-b", "feature"]);
    applyScenarios(fresh.fx);
    commit(fresh.fx, "scenarios");
    const d = await reviewDiff(fresh.paths, "main", "feature");
    expect(d.changes.length).toBeGreaterThan(5);
    expect(existsSync(fresh.paths.dataDir)).toBe(false);
  });

  it("rejects unknown refs, option-looking refs and bad ranges", async () => {
    const { paths } = await setup();
    await expect(reviewDiff(paths, "main", "nope")).rejects.toThrow(/unknown git ref: nope/);
    await expect(reviewDiff(paths, "--upload-pack=x", "main")).rejects.toThrow(/invalid git ref/);
    expect(parseRange("main...feature")).toEqual({ base: "main", head: "feature" });
    expect(parseRange("a/b..c")).toEqual({ base: "a/b", head: "c" });
    expect(() => parseRange("main")).toThrow(/expected <base>\.\.\.<head>/);
  });

  it("a 20-file synthetic diff (10 functions each) completes in under 3 s", async () => {
    const { fx, paths } = await setup();
    const fn = (f: number, i: number, tweak: string) =>
      `export function f${f}n${i}(a: number, b: number): number {\n  const x = a * ${i} + b;\n  if (x > ${f}) {\n    return x - ${tweak};\n  }\n  return x + ${tweak};\n}\n`;
    const file = (f: number, tweak: string) =>
      `import { z } from "z${tweak}";\n${Array.from({ length: 10 }, (_, i) => fn(f, i, tweak)).join("\n")}`;
    for (let f = 0; f < 20; f++) write(fx, `packages/utils/src/gen/g${f}.ts`, file(f, "1"));
    commit(fx, "base gen");
    fx.git(["checkout", "-b", "big"]);
    for (let f = 0; f < 20; f++) write(fx, `packages/utils/src/gen/g${f}.ts`, file(f, "2"));
    commit(fx, "change gen");
    const t0 = Date.now();
    const d = await reviewDiff(paths, "main", "big");
    const wall = Date.now() - t0;
    expect(d.files).toHaveLength(20);
    expect(d.changes.filter((c) => c.kind === "modified")).toHaveLength(200);
    expect(d.importChanges).toHaveLength(20);
    expect(d.ms).toBeLessThan(3000);
    expect(wall).toBeLessThan(3000);
  }, 30_000);
});
