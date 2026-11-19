import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentKey, heal, openStore, refreshDescriptionFts, type TraceResult } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "../envelope.js";
import { type Connected, call, connect, type Repo } from "../testkit.js";
import { TOOLS } from "./index.js";
import { shapeTrace, traceTool } from "./trace.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const MARKER = "ZetaNineTraceMarker";
const ROUTE = "route:adapters:@demo/web:/posts/$postId";

const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
const conns: Connected[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

/** fixtures/adapters indexed, every symbol described with a marker (model provenance). */
async function setup() {
  const fx = await materializeFixture("adapters");
  fixtures.push(fx);
  const data = mkdtempSync(join(tmpdir(), "gantry-mcp-trace-"));
  dataDirs.push(data);
  const { resolvePaths } = await import("@gantry/core");
  const env = { ...process.env, HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  const paths = resolvePaths(fx.dir, env);
  await heal(paths);
  const withStore = <T>(f: (s: ReturnType<typeof openStore>) => T): T => {
    const s = openStore(paths.dbPath);
    try {
      return f(s);
    } finally {
      s.close();
    }
  };
  withStore((store) => {
    for (const s of store.effectiveSymbols()) {
      if (s.exactHash === "") continue;
      store.db
        .prepare(
          `INSERT OR REPLACE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
             provenance, model, prompt_version, created_at) VALUES (?, ?, '["a","b"]', 0, ?, 'model', 'test', 'p1', 'now')`,
        )
        .run(contentKey(s.exactHash), `Loads a thing. ${MARKER}`, `${MARKER}Name`);
    }
    refreshDescriptionFts(store);
  });
  const repo = { dir: fx.dir, env, paths, withStore } as unknown as Repo;
  const conn = await connect(repo, { getEmbedder: async () => undefined });
  conns.push(conn);
  return { withStore, ...conn };
}

describe("gantry_trace", () => {
  it("is registered with a target and an optional direction", () => {
    expect(TOOLS).toContain(traceTool);
    expect(Object.keys(traceTool.inputSchema).sort()).toEqual(["direction", "target"]);
    expect(traceTool.description).toContain("untrusted_description");
  });

  it("traces the page down to its endpoints and tables, and the table up to its pages", async () => {
    const { client } = await setup();
    const down = await call(client, "gantry_trace", { target: "/posts/$postId" });
    expect(down.isError).toBe(false);
    expect(down.text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const d = down.json as {
      target: string;
      direction: string;
      endpoints: { id: string; low?: boolean }[];
      tables: string[];
    };
    expect(d.target).toBe(ROUTE);
    expect(d.direction).toBe("down");
    expect(d.endpoints.map((e) => e.id)).toContain("ep:adapters:@demo/api:rpc posts.get");
    expect(d.endpoints.find((e) => e.id === "ep:adapters:@demo/server:PATCH /api/posts/:id")?.low).toBe(true);
    expect(d.tables).toContain("table:adapters:posts");

    const up = await call(client, "gantry_trace", { target: "table:posts" });
    const u = up.json as { direction: string; routes: string[] };
    expect(u.direction).toBe("up");
    expect(u.routes).toEqual([ROUTE]);
    expect((await call(client, "gantry_trace", { target: "nope" })).json.error).toBe("not_found");
  });

  it("never returns description text (containment)", async () => {
    const { client, withStore } = await setup();
    const ids = withStore((s) => [
      ...s.effectiveAdapterNodes().map((n) => n.id),
      ...s.effectiveSymbols().map((x) => x.id),
    ]);
    let steps = 0;
    for (const target of ids) {
      for (const direction of ["down", "up"] as const) {
        const r = await call(client, "gantry_trace", { target, direction });
        expect({ target, leak: r.text.includes(MARKER) }).toEqual({ target, leak: false });
        expect(r.text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
        steps += ((r.json.chain as unknown[] | undefined) ?? []).length;
      }
    }
    // not vacuous: the traces really return chains over described symbols
    expect(steps).toBeGreaterThan(50);
  });

  it("summarises a long chain with counts and stays under the limit", () => {
    const chain: TraceResult["chain"] = [
      { id: "route:repo:w:/a", kind: "route", label: "/a", via: "target", depth: 0 },
    ];
    for (let i = 0; i < 400; i++) {
      chain.push({
        id: `sym:repo:apps/web/src/components/c${i}.tsx#Component${i}`,
        kind: "component",
        label: `Component${i}`,
        via: "renders",
        depth: 2,
        from: "sym:repo:apps/web/src/a.tsx#Page",
      });
    }
    for (let i = 0; i < 60; i++) {
      chain.push({
        id: `ep:repo:w:rpc a.p${i}`,
        kind: "endpoint",
        label: `rpc a.p${i}`,
        via: "requests",
        depth: 3,
      });
      chain.push({ id: `table:repo:t${i}`, kind: "table", label: `t${i}`, via: "reads", depth: 6 });
    }
    const r: TraceResult = {
      target: "route:repo:w:/a",
      direction: "down",
      chain,
      edges: [],
      gaps: Array.from({ length: 30 }, (_, i) => `no table reached from ep:repo:w:rpc a.q${i}`),
      omitted: 0,
      truncated: false,
    };
    const out = shapeTrace(r) as Record<string, unknown>;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(out.repeats).toContainEqual(
      expect.objectContaining({ depth: 2, via: "renders", kind: "component", count: 400 }),
    );
    expect(out.endpoints_total).toBe(60);
    expect(out.tables_total).toBe(60);
    expect(out.gaps_total).toBe(30);
  });
});
