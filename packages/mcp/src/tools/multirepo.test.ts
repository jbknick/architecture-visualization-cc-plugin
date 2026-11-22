import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heal, resolvePaths } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "../envelope.js";
import { type Connected, call, connect, type Repo } from "../testkit.js";

// The helper lives in core's test folder, outside any tsconfig rootDir, so load it dynamically by path.
interface MaterializedMultirepo {
  root: string;
  repos: { web: string; api: string };
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeMultirepo } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeMultirepo: () => Promise<MaterializedMultirepo>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** An indexed workspace of two repos, and an MCP client running in `from`. */
async function setup(from: "web" | "api"): Promise<Connected> {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-mcp-mr-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  const dir = mr.repos[from];
  await heal(resolvePaths(dir, env));
  // `connect` reads only the directory and the environment of a repo.
  const conn = await connect({ dir, env } as unknown as Repo);
  cleanups.push(() => conn.close());
  return conn;
}

describe("gantry_search across repos", () => {
  it("labels every hit with its repo and limits to one repo with repo", async () => {
    const { client } = await setup("web");
    const all = await call(client, "gantry_search", { query: "computeRetryDelay" });
    expect(all.isError).toBe(false);
    const hits = all.json.hits as { name: string; repo: string }[];
    expect(hits[0]).toMatchObject({ name: "computeRetryDelay", repo: "acme/api" });
    const web = await call(client, "gantry_search", { query: "computeRetryDelay", repo: "web" });
    expect(web.json.hits).toEqual([]);
    const api = await call(client, "gantry_search", { query: "computeRetryDelay", repo: "acme/api" });
    expect((api.json.hits as { repo: string }[])[0]?.repo).toBe("acme/api");
  });
});

describe("gantry_browse and gantry_node across repos", () => {
  it("lists the repos at the top level, then a repo's workspaces", async () => {
    const { client } = await setup("web");
    const top = await call(client, "gantry_browse", { target: "." });
    expect(top.text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect((top.json.items as { id: string; kind: string }[]).map((i) => [i.id, i.kind])).toEqual([
      ["repo:acme/api", "repo"],
      ["repo:web", "repo"],
    ]);
    const api = await call(client, "gantry_browse", { target: "repo:acme/api" });
    expect((api.json.items as { id: string }[]).map((i) => i.id)).toContain("ws:acme/api:mr-server");
    expect((await call(client, "gantry_browse", { target: "repo:nope" })).json.error).toBe("not_found");
  });

  it("shows the repo of a node", async () => {
    const { client } = await setup("web");
    const sym = await call(client, "gantry_node", {
      target: "sym:acme/api:apps/server/src/retry.ts#computeRetryDelay",
    });
    expect((sym.json.node as { repo: string }).repo).toBe("acme/api");
    const file = await call(client, "gantry_node", { target: "src/lib/slug.ts" });
    expect((file.json.node as { repo: string }).repo).toBe("web");
  });
});

describe("gantry_find_similar across repos", () => {
  const draft =
    "export function slugOf(text: string): string {\n" +
    "  const lower = text.toLowerCase();\n  const trimmed = lower.trim();\n" +
    '  const dashed = trimmed.replace(/\\s+/g, "-");\n  const clean = dashed.replace(/[^a-z0-9-]/g, "");\n' +
    '  const collapsed = clean.replace(/-+/g, "-");\n  return collapsed.replace(/^-|-$/g, "");\n}\n';

  it("returns a match in the sibling repo with its repo, and advice that says where it is", async () => {
    const { client } = await setup("web");
    const r = await call(client, "gantry_find_similar", { code: draft, caller_path: "src/lib/other.ts" });
    expect(r.isError).toBe(false);
    const apiMatch = (r.json.matches as { repo: string; name: string; advice: { situation: number } }[]).find(
      (m) => m.repo === "acme/api",
    );
    expect(apiMatch).toMatchObject({ name: "toSlug", advice: { situation: 7 } });
    expect((r.json.matches as { repo: string }[]).map((m) => m.repo)).toContain("web");
  });
});
