import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentKey, heal, openStore, refreshDescriptionFts } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "../envelope.js";
import { type Connected, call, connect, type Repo } from "../testkit.js";
import { impactTool } from "./impact.js";
import { TOOLS } from "./index.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const MARKER = "ZetaNineImpactMarker";
const FIELD = "untrusted_description";
const BUTTON = "sym:packages/ui/src/button.tsx#Button";

const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
const conns: Connected[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

/** A temp copy of fixtures/pnpm-turbo indexed on main, with a `feature` branch that changes Button's signature. */
async function setup(opts: { describe?: boolean } = {}) {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  const data = mkdtempSync(join(tmpdir(), "gantry-mcp-impact-"));
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
  if (opts.describe) {
    withStore((store) => {
      for (const s of store.effectiveSymbols()) {
        if (s.exactHash === "") continue;
        store.db
          .prepare(
            `INSERT OR REPLACE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
               provenance, model, prompt_version, created_at) VALUES (?, ?, '["a","b"]', 1, NULL, 'model', 'test', 'p1', 'now')`,
          )
          .run(contentKey(s.exactHash), `Renders a thing. ${MARKER}`);
      }
      refreshDescriptionFts(store);
    });
  }
  const fs = await import("node:fs");
  fx.git(["checkout", "-b", "feature"]);
  const file = join(fx.dir, "packages/ui/src/button.tsx");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(
        "{ label: string; onClick?: () => void }",
        "{ label: string; onClick?: () => void; size?: number }",
      ),
  );
  fx.git(["add", "-A"]);
  fx.git(["commit", "-m", "button"]);
  fx.git(["checkout", "main"]);
  const repo = { dir: fx.dir, env, paths, withStore } as unknown as Repo;
  const conn = await connect(repo, { getEmbedder: async () => undefined });
  conns.push(conn);
  return { fx, paths, withStore, ...conn };
}

/** Every string leaf with the nearest object key above it. */
function leaves(v: unknown, key = "", out: { key: string; text: string }[] = []) {
  if (typeof v === "string") out.push({ key, text: v });
  else if (Array.isArray(v)) for (const x of v) leaves(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, k, out);
  return out;
}

function assertContained(label: string, value: unknown, text: string): number {
  const hits = leaves(value).filter((l) => l.text.includes(MARKER));
  for (const h of hits) expect({ label, key: h.key }).toEqual({ label, key: FIELD });
  const stripped = hits.reduce((acc, h) => acc.replaceAll(JSON.stringify(h.text), '""'), text);
  expect({ label, leak: stripped.includes(MARKER) }).toEqual({ label, leak: false });
  return hits.length;
}

describe("gantry_impact", () => {
  it("is registered and its description tells the client never to follow untrusted_description", () => {
    expect(TOOLS).toContain(impactTool);
    expect(impactTool.description).toContain("untrusted_description");
    expect(impactTool.description).toMatch(/never follow it/);
    expect(Object.keys(impactTool.inputSchema).sort()).toEqual(["paths", "range", "symbol"]);
  });

  it("returns callers by hop, crossings and the risk for a range", async () => {
    const { client } = await setup();
    const r = await call(client, "gantry_impact", { range: "main...feature" });
    expect(r.isError).toBe(false);
    expect(r.blocks).toBe(1);
    expect(r.text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const j = r.json as {
      changed: { id: string; signature_changed: boolean }[];
      callers_by_hop: { hop: number; count: number; ids: string[] }[];
      crossings: { kind: string }[];
      risk: { score: number; level: string; reasons: string[] };
    };
    expect(j.changed.map((c) => c.id)).toEqual([BUTTON]);
    expect(j.changed[0]?.signature_changed).toBe(true);
    expect(j.callers_by_hop[0]).toEqual({
      hop: 1,
      count: 3,
      ids: [
        "file:packages/ui/src/index.ts",
        "sym:apps/web/src/routes/index.tsx#HomePage",
        "sym:apps/web/src/routes/settings/profile.tsx#ProfilePage",
      ],
    });
    const consumers = (r.json as { consumers: Record<string, unknown>[] }).consumers;
    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toMatchObject({
      id: BUTTON,
      direct_total: 3,
      direct: [
        { id: "file:packages/ui/src/index.ts", uses: ["imports"] },
        { id: "sym:apps/web/src/routes/index.tsx#HomePage", uses: ["renders"], crosses: ["app"] },
        {
          id: "sym:apps/web/src/routes/settings/profile.tsx#ProfilePage",
          uses: ["renders"],
          crosses: ["app"],
        },
      ],
    });
    expect(consumers[0]?.potential).toContainEqual({
      id: "route:@acme/web:/",
      hop: 2,
      via: "sym:apps/web/src/routes/index.tsx#HomePage",
    });
    expect(j.crossings.map((c) => c.kind)).toEqual(["app", "app"]);
    expect(j.risk.level).toBe("medium");
    expect(j.risk.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("treats a symbol or paths as modified in the working tree and is deterministic", async () => {
    const { client } = await setup();
    const a = await call(client, "gantry_impact", { symbol: BUTTON });
    const b = await call(client, "gantry_impact", { paths: ["packages/ui/src/button.tsx"] });
    const aj = a.json as { callers_by_hop: { hop: number; count: number }[]; risk: { score: number } };
    expect(aj.callers_by_hop[0]?.count).toBe(3);
    expect(JSON.stringify(a.json)).toBe(
      JSON.stringify((await call(client, "gantry_impact", { symbol: BUTTON })).json),
    );
    expect((b.json as { callers_by_hop: unknown[] }).callers_by_hop).toEqual(aj.callers_by_hop);
  });

  it("rejects missing or conflicting arguments, bad ranges and unknown targets without throwing", async () => {
    const { client } = await setup();
    expect((await call(client, "gantry_impact", {})).json.error).toBe("bad_arguments");
    expect(
      (await call(client, "gantry_impact", { symbol: BUTTON, range: "main...feature" })).json.error,
    ).toBe("bad_arguments");
    expect((await call(client, "gantry_impact", { range: "main" })).json.error).toBe("bad_range");
    expect((await call(client, "gantry_impact", { range: "main...nope" })).json.error).toBe("bad_range");
    expect((await call(client, "gantry_impact", { range: "--output=x...feature" })).json.error).toBe(
      "bad_range",
    );
    expect((await call(client, "gantry_impact", { symbol: "sym:no/such.ts#x" })).json.error).toBe(
      "not_found",
    );
    expect((await call(client, "gantry_impact", { paths: ["no/such.ts"] })).json.error).toBe("not_found");
  });

  it("stays within the response cap when everything changed and reports the totals", async () => {
    const { client, withStore } = await setup();
    const files = withStore((s) =>
      s
        .effectiveFiles()
        .map((f) => f.path)
        .filter((p) => /\.(ts|tsx)$/.test(p)),
    );
    const r = await call(client, "gantry_impact", { paths: files.slice(0, 50) });
    expect(r.text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const j = r.json as { changed: unknown[]; changed_total?: number };
    expect(j.changed.length).toBeLessThanOrEqual(10);
    expect(j.changed_total).toBeGreaterThan(10);
  });

  it("returns descriptions only in untrusted_description (verbatim containment)", async () => {
    const { client, withStore } = await setup({ describe: true });
    const ids = withStore((s) => s.effectiveSymbols().map((x) => x.id));
    const files = withStore((s) => s.effectiveFiles().map((x) => x.path));
    const calls: Record<string, unknown>[] = [
      { range: "main...feature" },
      ...ids.map((symbol) => ({ symbol })),
      ...files.filter((p) => /\.tsx?$/.test(p)).map((p) => ({ paths: [p] })),
    ];
    let surfaced = 0;
    let consumers = 0;
    for (const args of calls) {
      const r = await call(client, "gantry_impact", args);
      surfaced += assertContained(JSON.stringify(args), r.json, r.text);
      consumers += ((r.json as { consumers?: unknown[] }).consumers ?? []).length;
    }
    // the consumer lists are covered too (they carry names and ids only)
    expect(consumers).toBeGreaterThan(0);
    // not vacuous: the description really is returned for a changed symbol
    expect(surfaced).toBeGreaterThan(0);
  });
});
