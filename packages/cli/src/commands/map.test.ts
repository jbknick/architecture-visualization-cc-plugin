import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function spawnAsync(
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { ...o, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    c.on("exit", (code) => resolve({ code, err }));
  });
}

interface TestBundle {
  home: string;
  cleanup(): void;
}
// The shared helper lives outside this package's rootDir, so it is loaded by a computed path.
const helperPath = "../../../../scripts/testBundle.js";
const { bundlePlugin } = (await import(/* @vite-ignore */ helperPath)) as {
  bundlePlugin: (names: string[]) => Promise<TestBundle>;
};

// Exercises the real CLI entry, bundled from source in beforeAll.
describe("gantry map (bundled CLI)", () => {
  let bundle: TestBundle | undefined;
  let cliJs: string;
  let tmp: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let first: ChildProcess | undefined;

  beforeAll(async () => {
    bundle = await bundlePlugin(["cli"]);
    cliJs = join(bundle.home, "dist/cli.js");
    tmp = mkdtempSync(join(tmpdir(), "gantry-map-"));
    repo = join(tmp, "repo");
    execFileSync("git", ["init", "-q", repo]);
    env = { ...process.env, HOME: join(tmp, "home"), CLAUDE_PLUGIN_DATA: join(tmp, "data") };
  }, 60_000);
  afterAll(() => {
    first?.kill("SIGINT");
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    bundle?.cleanup();
  });

  it("starts, serves the API, and a second `gantry map` reuses the same server", async () => {
    first = spawn("node", [cliJs, "map", "--no-open"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      let err = "";
      first?.stdout?.on("data", (c: Buffer) => {
        out += c.toString();
        const line = out.split("\n")[0];
        if (out.includes("\n") && line) resolve(line);
      });
      first?.stderr?.on("data", (c: Buffer) => {
        err += c.toString();
      });
      first?.on("exit", (code) => reject(new Error(`exited ${code}: ${err}`)));
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+$/);

    const { port, token } = { port: new URL(url).port, token: new URL(url).searchParams.get("t") ?? "" };
    const meta = await fetch(`http://127.0.0.1:${port}/api/meta`, { headers: { "x-gantry-token": token } });
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { views: { id: string }[] }).views[0]?.id).toBe("debug");
    expect((await fetch(`http://127.0.0.1:${port}/api/meta`)).status).toBe(403);

    const second = spawnSync("node", [cliJs, "map", "--no-open"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(url);

    // Ctrl-C stops the first one.
    const exited = new Promise<number | null>((resolve) => first?.on("exit", (c) => resolve(c)));
    first.kill("SIGINT");
    expect(await exited).toBe(0);
  });

  it("two concurrent starts leave one server; the loser exits 0 and prints no token", async () => {
    const repo2 = join(tmp, "race");
    execFileSync("git", ["init", "-q", repo2]);
    const run = () =>
      new Promise<{ code: number | null; out: string; child: ChildProcess }>((resolve) => {
        const child = spawn("node", [cliJs, "map", "--no-open", "--no-url"], {
          cwd: repo2,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout?.on("data", (c: Buffer) => {
          out += c.toString();
        });
        child.stderr?.on("data", (c: Buffer) => {
          out += `[stderr] ${c.toString()}`;
        });
        child.on("exit", (code) => resolve({ code, out, child }));
        setTimeout(() => resolve({ code: null, out, child }), 4000); // still serving
      });
    const [a, b] = await Promise.all([run(), run()]);
    const serving = [a, b].filter((r) => r.code === null);
    const exited = [a, b].filter((r) => r.code !== null);
    try {
      expect(serving).toHaveLength(1);
      expect(exited).toHaveLength(1);
      expect(exited[0]?.code, exited[0]?.out).toBe(0);
      for (const r of [a, b]) expect(r.out).not.toContain("?t=");
      const state = JSON.parse(
        readFileSync(join(resolvePaths(repo2, env).dataDir, "explorer.json"), "utf8"),
      ) as {
        pid: number;
      };
      expect(state.pid).toBe(serving[0]?.child.pid);
    } finally {
      for (const r of serving) r.child.kill("SIGINT");
    }
  }, 15000);

  it("starts against an explorer that is stopped fail with a message naming its pid and leave it alone", async () => {
    const repo3 = join(tmp, "stopped");
    execFileSync("git", ["init", "-q", repo3]);
    const a = spawn("node", [cliJs, "map", "--no-open", "--no-url"], { cwd: repo3, env, stdio: "ignore" });
    const file = join(resolvePaths(repo3, env).dataDir, "explorer.json");
    try {
      for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
      const before = readFileSync(file, "utf8");
      process.kill(a.pid as number, "SIGSTOP");
      const runs = await Promise.all(
        Array.from({ length: 6 }, () =>
          spawnAsync("node", [cliJs, "map", "--no-open", "--no-url"], { cwd: repo3, env }),
        ),
      );
      for (const r of runs) {
        expect(r.code).toBe(1);
        expect(r.err).toContain(String(a.pid));
        expect(r.err).not.toContain("    at "); // one line, no stack
      }
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      process.kill(a.pid as number, "SIGCONT");
      a.kill("SIGINT");
    }
  }, 30000);

  it("exits by itself after --idle-timeout without requests and removes explorer.json", async () => {
    const repo4 = join(tmp, "idle");
    execFileSync("git", ["init", "-q", repo4]);
    const r = await spawnAsync("node", [cliJs, "map", "--no-open", "--no-url", "--idle-timeout", "0.005"], {
      cwd: repo4,
      env,
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(resolvePaths(repo4, env).dataDir, "explorer.json"))).toBe(false);
  }, 15000);

  it("rejects an invalid --idle-timeout", () => {
    const r = spawnSync("node", [cliJs, "map", "--no-open", "--idle-timeout", "0"], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Invalid --idle-timeout");
  });

  it("rejects an invalid --port", () => {
    const r = spawnSync("node", [cliJs, "map", "--no-open", "--port", "abc"], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Invalid --port");
  });
});
