// The mutation runner must leave the source tree as it found it when it is interrupted (review of #121). The test runs
// the real script against a scratch copy of the first file it mutates, with a stub test command, and sends SIGTERM
// while a mutation is in place.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "..");

it("restores the mutated file when the runner is terminated mid-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gantry-mut-"));
  const original = readFileSync(join(root, "packages", "core", "src", "describe", "validate.ts"), "utf8");
  writeFileSync(join(dir, "validate.ts"), original);
  const marker = join(dir, "baseline-done");
  // first call (the baseline) exits 0 at once; later calls (a mutation in place) hang until killed
  const stub = `node -e "const f=require('fs');const m='${marker}';if(!f.existsSync(m)){f.writeFileSync(m,'1');process.exit(0)}setTimeout(()=>{},60000)"`;
  const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["scripts/describe-mutations.ts"], {
    cwd: root,
    env: {
      ...process.env,
      GANTRY_MUTATION_DIR: dir,
      GANTRY_MUTATION_CMD: stub,
      GANTRY_MUTATION_LIMIT: "1",
    },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && readFileSync(join(dir, "validate.ts"), "utf8") === original) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(join(dir, "validate.ts"), "utf8")).not.toBe(original); // mutation is in place
  // signal the tsx child directly: pnpm and tsx forward it to the script
  child.kill("SIGTERM");
  await exited;
  await new Promise((r) => setTimeout(r, 300));
  expect(readFileSync(join(dir, "validate.ts"), "utf8")).toBe(original);
}, 40_000);

// Stale and live lock files (second review of #121).
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const lockPath = (dir: string) =>
  join(
    tmpdir(),
    `gantry-describe-mutation-${createHash("sha1").update(dir).digest("hex").slice(0, 12)}.json`,
  );

function runScript(dir: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["scripts/describe-mutations.ts"], {
      cwd: root,
      env: {
        ...process.env,
        GANTRY_MUTATION_DIR: dir,
        GANTRY_MUTATION_CMD: `node -e "process.exit(0)"`,
        GANTRY_MUTATION_LIMIT: "1",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** A process id that was just used and has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(r.stdout.toString());
}

describe("mutation lock file", () => {
  const setup = (fileText: string) => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-mut-lock-"));
    writeFileSync(join(dir, "validate.ts"), fileText);
    return dir;
  };

  it("restores the file of a dead run when it still holds exactly the mutated text", async () => {
    const dir = setup("MUTATED");
    const path = join(dir, "validate.ts");
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: deadPid(), path, original: "ORIGINAL", mutatedHash: sha("MUTATED") }),
    );
    const r = await runScript(dir);
    expect(r.out).toContain("restored");
    expect(readFileSync(path, "utf8")).toBe("ORIGINAL");
    expect(existsSync(lockPath(dir))).toBe(false);
  }, 30_000);

  it("leaves a file with newer edits alone, warns and removes the stale lock", async () => {
    const dir = setup("ORIGINAL plus a newer edit");
    const path = join(dir, "validate.ts");
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: deadPid(), path, original: "ORIGINAL", mutatedHash: sha("MUTATED") }),
    );
    const r = await runScript(dir);
    expect(r.out).toContain("warning");
    expect(readFileSync(path, "utf8")).toBe("ORIGINAL plus a newer edit");
    expect(existsSync(lockPath(dir))).toBe(false);
  }, 30_000);

  it("refuses to run (exit 3) while the process that holds the lock is alive, keeping its lock and file", async () => {
    const dir = setup("MUTATED");
    const path = join(dir, "validate.ts");
    const live = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"]);
    try {
      writeFileSync(
        lockPath(dir),
        JSON.stringify({ pid: live.pid, path, original: "ORIGINAL", mutatedHash: sha("MUTATED") }),
      );
      const r = await runScript(dir);
      expect(r.code).toBe(3);
      expect(r.out).toContain("in progress");
      expect(readFileSync(path, "utf8")).toBe("MUTATED");
      expect(existsSync(lockPath(dir))).toBe(true);
    } finally {
      live.kill();
      rmSync(lockPath(dir), { force: true });
    }
  }, 30_000);
});
