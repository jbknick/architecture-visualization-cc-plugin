import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertThrowawayClone, isUnderTmp, ProbeGuard, STASH_PREFIX, THROWAWAY_FLAG } from "./m1-safety.js";

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  return r.stdout;
}

/** A throwaway repo with one committed file. */
function makeRepo(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "gantry-safety-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, file: "a.ts" };
}

const probe = (dir: string, file: string): void =>
  appendFileSync(join(dir, file), "\nexport const probe = 1;\n");
const state = (dir: string) => ({
  status: git(dir, "status", "--porcelain").trim(),
  stashes: git(dir, "stash", "list").trim(),
});

describe("assertThrowawayClone", () => {
  it("accepts a path under the system temp dir and rejects one outside it", () => {
    const { dir } = makeRepo();
    expect(isUnderTmp(dir)).toBe(true);
    expect(() => assertThrowawayClone(dir, false)).not.toThrow();
    expect(isUnderTmp(here)).toBe(false);
    expect(() => assertThrowawayClone(here, false)).toThrow(THROWAWAY_FLAG);
    expect(() => assertThrowawayClone(here, true)).not.toThrow();
  });

  it("does not treat the temp dir itself or a sibling with the same prefix as inside it", () => {
    expect(isUnderTmp(tmpdir(), [tmpdir()])).toBe(false);
    expect(isUnderTmp(`${tmpdir()}-other/x`, [tmpdir()])).toBe(false);
    expect(isUnderTmp("/tmp/some-clone")).toBe(true);
  });
});

describe("ProbeGuard", () => {
  it("restores a clean tree when the run dies between the edit and the stash", () => {
    const { dir, file } = makeRepo();
    const g = new ProbeGuard(dir, file);
    g.arm();
    try {
      probe(dir, file);
      g.markEdited();
      throw new Error("simulated crash");
    } catch {
      // the bench's finally block
    } finally {
      g.restore();
      g.disarm();
    }
    expect(state(dir)).toEqual({ status: "", stashes: "" });
    expect(g.isClean()).toBe(true);
  });

  it("restores a clean tree when the run dies after the stash", () => {
    const { dir, file } = makeRepo();
    const g = new ProbeGuard(dir, file);
    g.arm();
    probe(dir, file);
    g.markEdited();
    g.stash();
    expect(state(dir).stashes).toContain(g.message);
    g.restore();
    g.disarm();
    expect(state(dir)).toEqual({ status: "", stashes: "" });
  });

  it("is idempotent", () => {
    const { dir, file } = makeRepo();
    const g = new ProbeGuard(dir, file);
    g.arm();
    probe(dir, file);
    g.stash();
    g.restore();
    g.restore();
    g.disarm();
    expect(state(dir)).toEqual({ status: "", stashes: "" });
  });

  it("touches only its own stash entry, even when another one has a similar message", () => {
    const { dir, file } = makeRepo();
    writeFileSync(join(dir, "other.ts"), "export const o = 1;\n");
    git(dir, "add", "other.ts");
    git(dir, "stash", "push", "-q", "-m", STASH_PREFIX); // an old-style entry, not ours
    writeFileSync(join(dir, "mine.ts"), "export const m = 1;\n");
    git(dir, "add", "mine.ts");
    git(dir, "stash", "push", "-q", "-m", `${STASH_PREFIX}-someoneelse`);
    const before = git(dir, "stash", "list").trim().split("\n");

    const g = new ProbeGuard(dir, file, "abc123");
    g.arm();
    probe(dir, file);
    g.stash();
    g.restore();
    g.disarm();

    expect(git(dir, "stash", "list").trim().split("\n")).toEqual(before);
    expect(state(dir).status).toBe("");
  });

  it("falls back to git checkout when stash apply fails, and still drops the entry", () => {
    const { dir, file } = makeRepo();
    const g = new ProbeGuard(dir, file);
    g.arm();
    probe(dir, file);
    g.stash();
    // Make `stash apply` refuse: the target has a different local change.
    writeFileSync(join(dir, file), "export const a = 2;\n");
    g.restore();
    g.disarm();
    expect(state(dir)).toEqual({ status: "", stashes: "" });
  });

  it("refuses a dirty tree", () => {
    const { dir, file } = makeRepo();
    probe(dir, file);
    expect(() => new ProbeGuard(dir, file).arm()).toThrow(/local changes/);
  });

  it("leaves the clone clean when the process gets SIGINT between the edit and the restore", () => {
    const { dir, file } = makeRepo();
    const safety = join(here, "m1-safety.ts");
    const code = `
      import { appendFileSync } from "node:fs";
      import { ProbeGuard } from ${JSON.stringify(safety)};
      const g = new ProbeGuard(${JSON.stringify(dir)}, ${JSON.stringify(file)});
      g.arm();
      appendFileSync(${JSON.stringify(join(dir, file))}, "\\nexport const probe = 1;\\n");
      g.markEdited();
      g.stash();
      process.kill(process.pid, "SIGINT");
      setTimeout(() => process.exit(0), 5000);
    `;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: join(here, "..", ".."),
      encoding: "utf8",
    });
    expect(r.status).toBe(130);
    expect(state(dir)).toEqual({ status: "", stashes: "" });
  });
});
