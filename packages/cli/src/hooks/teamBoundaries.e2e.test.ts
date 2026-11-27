import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Group, indexRepo, resolvePaths } from "@gantry/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedTeamCache } from "../testing/teamCacheSeed.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
const cli = join(repoRoot, "plugin/dist/cli.js");
const fixtureDir = join(repoRoot, "fixtures/overlay-groups");
const EDIT = readFileSync(join(fixtureDir, "invoice.edited.txt"), "utf8");
const TEAM = JSON.parse(readFileSync(join(fixtureDir, "groups.json"), "utf8")) as Group[];
const TEAM_LINE =
  "Gantry: totalDue (src/orders/invoice.ts:3) in team group Orders uses formatPrice (src/catalog/price.ts:1) in team group Catalog, which Orders does not list. Warn only.";
const BUDGET_MS = 1500;

/** Loaded before the hook: `fetch` and every way to open a socket throw, and leave a note in `NET_LOG`. */
const PRELOAD = `
import net from "node:net";
import { appendFileSync } from "node:fs";
const refuse = (what) => () => {
  appendFileSync(process.env.NET_LOG, what + "\\n");
  throw new Error("network is off: " + what);
};
globalThis.fetch = refuse("fetch");
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
net.Socket.prototype.connect = refuse("net.Socket.connect");
`;

let fx: MaterializedFixture;
let work: string;
let env: NodeJS.ProcessEnv;
let preload: string;
let netLog: string;

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
});
beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "gantry-team-boundaries-e2e-"));
  preload = join(work, "no-network.mjs");
  netLog = join(work, "net.log");
  writeFileSync(preload, PRELOAD);
  env = {
    ...process.env,
    HOME: join(work, "home"),
    CLAUDE_PLUGIN_DATA: join(work, "data"),
    NET_LOG: netLog,
    NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
  };
  fx = await materializeFixture("overlay-groups");
  const paths = resolvePaths(fx.dir, env);
  await indexRepo(paths, { layer: "main" });
  seedTeamCache(paths, TEAM);
});
afterEach(async () => {
  await fx?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

/** Runs `node plugin/dist/cli.js hook <name>` in the fixture with `input` on stdin. */
function hook(name: string, input: object): Promise<{ out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("node", [cli, "hook", name], { cwd: fx.dir, env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("close", () => resolve({ out, ms: Date.now() - t0 }));
    child.stdin.end(JSON.stringify(input));
  });
}

const edited = () => {
  writeFileSync(join(fx.dir, "src/orders/invoice.ts"), EDIT);
  return {
    cwd: fx.dir,
    tool_name: "Write",
    tool_input: { file_path: join(fx.dir, "src/orders/invoice.ts") },
  };
};

describe("team boundaries in the built hooks, with the network off", () => {
  it("the preload makes fetch and net connect throw", async () => {
    const out = await new Promise<string>((resolve) => {
      const child = spawn(
        "node",
        [
          "-e",
          `try { fetch("http://127.0.0.1:9"); } catch (e) { console.log(e.message); } try { require("node:net").connect(9, "127.0.0.1"); } catch (e) { console.log(e.message); }`,
        ],
        { env },
      );
      let text = "";
      child.stdout.on("data", (d: Buffer) => {
        text += d.toString();
      });
      child.on("close", () => resolve(text));
    });
    expect(out).toContain("network is off: fetch");
    expect(out).toContain("network is off: net.connect");
    rmSync(netLog, { force: true });
  });

  it("post-tool-use prints the exact team line inside the budget", async () => {
    const r = await hook("post-tool-use", edited());
    expect(JSON.parse(r.out)).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: TEAM_LINE },
    });
    expect(r.ms).toBeLessThan(BUDGET_MS);
    expect(existsSync(netLog)).toBe(false);
  });

  it("stop prints the exact team line inside the budget", async () => {
    const input = edited();
    const trigger = await hook("post-tool-use", { ...input, session_id: "e2e" });
    expect(trigger.out).toBe("");
    const r = await hook("stop", { session_id: "e2e", cwd: fx.dir });
    expect(JSON.parse(r.out)).toEqual({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: TEAM_LINE },
    });
    expect(r.ms).toBeLessThan(BUDGET_MS);
    expect(existsSync(netLog)).toBe(false);
  });
});
