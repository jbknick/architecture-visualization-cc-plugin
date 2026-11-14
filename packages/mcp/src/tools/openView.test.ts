import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Connected, call, connect, indexAndSync, makeRepo, type Repo, silentLog } from "../testkit.js";
import { TOOLS } from "./index.js";
import { openViewTool } from "./openView.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliJs = join(here, "..", "..", "..", "..", "plugin", "dist", "cli.js");
const built = existsSync(cliJs);

const repos: Repo[] = [];
const conns: Connected[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
  for (const r of repos.splice(0)) {
    try {
      const state = JSON.parse(readFileSync(join(r.paths.dataDir, "explorer.json"), "utf8")) as {
        pid: number;
      };
      process.kill(state.pid, "SIGTERM");
    } catch {
      // no explorer was started
    }
    r.cleanup();
  }
  silentLog.errors.length = 0;
});

async function setup() {
  const repo = makeRepo();
  repos.push(repo);
  await indexAndSync(repo);
  const conn = await connect(repo);
  conns.push(conn);
  return { repo, ...conn };
}

describe("gantry_open_view registration", () => {
  it("is registered with the untrusted-data notice and takes view, focus, filters", () => {
    expect(TOOLS).toContain(openViewTool);
    expect(openViewTool.name).toBe("gantry_open_view");
    expect(openViewTool.description).toContain("untrusted_description");
    expect(Object.keys(openViewTool.inputSchema).sort()).toEqual(["filters", "focus", "view"]);
  });
});

describe("gantry_open_view", () => {
  it("rejects an unknown view without starting a server", async () => {
    const { repo, client } = await setup();
    const r = await call(client, "gantry_open_view", { view: "nope" });
    expect(r.json.error).toBe("unknown_view");
    expect(r.json.views).toContain("project-map");
    expect(existsSync(join(repo.paths.dataDir, "explorer.json"))).toBe(false);
  });

  // Exercises the bundled CLI, so it only runs after `pnpm build`.
  it.skipIf(!built)(
    "starts a detached explorer within 3 s, returns a working URL, then reuses it",
    async () => {
      const { repo, client } = await setup();
      const t0 = Date.now();
      const r = await call(client, "gantry_open_view", {
        view: "ego",
        focus: "sym:src/math.ts#clamp",
        filters: { depth: "2" },
      });
      const elapsed = Date.now() - t0;
      expect(r.isError).toBe(false);
      expect(elapsed).toBeLessThan(3000);
      const url = new URL(r.json.url as string);
      expect(url.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(url.searchParams.get("t")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.hash).toBe(`#/ego?focus=${encodeURIComponent("sym:src/math.ts#clamp")}&depth=2`);

      // Working: the token authenticates, no token does not.
      const token = url.searchParams.get("t") ?? "";
      const meta = await fetch(`${url.origin}/api/meta`, { headers: { "x-gantry-token": token } });
      expect(meta.status).toBe(200);
      expect((await fetch(`${url.origin}/api/meta`)).status).toBe(403);

      // Detached with output in the data dir's logs, nothing in the working tree.
      expect(existsSync(join(repo.paths.logsDir, "explorer.log"))).toBe(true);
      expect(repo.git("status", "--porcelain").trim()).toBe("");

      // The second call reuses the running server (same port and token).
      const again = await call(client, "gantry_open_view", { view: "duplicates" });
      const url2 = new URL(again.json.url as string);
      expect(url2.origin).toBe(url.origin);
      expect(url2.searchParams.get("t")).toBe(token);
      expect(url2.hash).toBe("#/duplicates");
      expect(silentLog.errors).toEqual([]);
    },
    15000,
  );
});
