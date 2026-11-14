// End to end: the bundled server over real stdio. Bundles packages/mcp/src/main.ts the way tsup.config.ts does.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRepo, type Repo } from "./testkit.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const out = mkdtempSync(join(tmpdir(), "gantry-mcp-bundle-"));
let repo: Repo;

beforeAll(async () => {
  await build({
    entry: { mcp: join(here, "main.ts") },
    outDir: out,
    format: ["esm"],
    platform: "node",
    target: "node22",
    silent: true,
    dts: false,
    config: false,
    external: [
      "better-sqlite3",
      "sqlite-vec",
      "oxc-parser",
      "oxc-resolver",
      "@huggingface/transformers",
      "onnxruntime-node",
    ],
  });
  symlinkSync(join(repoRoot, "node_modules"), join(out, "node_modules"), "dir"); // native modules are external
  repo = makeRepo();
}, 120_000);

afterAll(() => {
  repo?.cleanup();
  rmSync(out, { recursive: true, force: true });
});

describe("node mcp.js over stdio", () => {
  it("initializes, lists tools and answers a tool call; stdout holds only JSON-RPC frames", async () => {
    const child = spawn(process.execPath, [join(out, "mcp.js")], {
      cwd: repo.dir,
      env: repo.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });

    const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const frames = (): Record<string, unknown>[] =>
      stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    const reply = async (id: number): Promise<Record<string, unknown>> => {
      for (let i = 0; i < 600; i++) {
        const f = frames().find((x) => x.id === id);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no reply to ${id}; stderr: ${stderr}`);
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "e2e", version: "1" },
        },
      });
      const init = (await reply(1)).result as { serverInfo: { name: string; version: string } };
      expect(init.serverInfo.name).toBe("gantry");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = ((await reply(2)).result as { tools: { name: string }[] }).tools
        .map((t) => t.name)
        .sort();
      expect(tools).toEqual([
        "gantry_browse",
        "gantry_claim_batch",
        "gantry_node",
        "gantry_search",
        "gantry_submit_descriptions",
      ]);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "gantry_claim_batch", arguments: { worker_id: "e2e", size: 5 } },
      });
      const call = (await reply(3)).result as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };
      expect(call.isError).toBeUndefined();
      expect(call.content).toHaveLength(1);
      const payload = JSON.parse(call.content[0]?.text as string) as { batch_id: string; items: unknown[] };
      expect(typeof payload.batch_id).toBe("string");
      expect(Array.isArray(payload.items)).toBe(true);
    } finally {
      child.stdin.end();
      child.kill();
    }

    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ jsonrpc: "2.0" });
  }, 120_000);
});
