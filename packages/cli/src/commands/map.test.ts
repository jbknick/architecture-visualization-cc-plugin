import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliJs = join(here, "..", "..", "..", "..", "plugin", "dist", "cli.js");
const built = existsSync(cliJs);

// Exercises the bundled CLI, so it only runs after `pnpm build` (which `pnpm check` follows in the PR workflow).
describe.skipIf(!built)("gantry map (bundled CLI)", () => {
  let tmp: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let first: ChildProcess | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "gantry-map-"));
    repo = join(tmp, "repo");
    execFileSync("git", ["init", "-q", repo]);
    env = { ...process.env, HOME: join(tmp, "home"), CLAUDE_PLUGIN_DATA: join(tmp, "data") };
  });
  afterAll(() => {
    first?.kill("SIGINT");
    rmSync(tmp, { recursive: true, force: true });
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
