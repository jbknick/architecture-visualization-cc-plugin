// Containment for #118: a stored `suggestedName` is model-written and untrusted (spec section 8). With
// `renameSuggestions` on, the marker below may leave the store only as the value of `untrusted_suggested_name`.
import { writeFileSync } from "node:fs";
import { contentKey, loadConfig, openStore, refreshDescriptionFts } from "@gantry/core";
import { HttpError, handleApi, listViews } from "@gantry/explorer";
import { afterEach, describe, expect, it } from "vitest";
import { type Connected, call, connect, fn, indexAndSync, makeRepo, type Repo } from "./testkit.js";

const NAME_MARKER = "ZetaNineSuggestedMarker";
const FIELD = "untrusted_suggested_name";
const BEHAVIOR = "Normalizes the input text for use in a url.";

const repos: Repo[] = [];
const conns: Connected[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
  for (const r of repos.splice(0)) r.cleanup();
});

/** Every string leaf with the nearest object key above it. */
function leaves(v: unknown, key = "", out: { key: string; text: string }[] = []) {
  if (typeof v === "string") out.push({ key, text: v });
  else if (Array.isArray(v)) for (const x of v) leaves(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, k, out);
  return out;
}

/** The marker is present only as a value of FIELD, and the serialised text has no other occurrence. */
function assertContained(label: string, value: unknown, text: string): number {
  const hits = leaves(value).filter((l) => l.text.includes(NAME_MARKER));
  for (const h of hits) expect({ label, key: h.key }).toEqual({ label, key: FIELD });
  const stripped = hits.reduce((acc, h) => acc.replaceAll(JSON.stringify(h.text), '""'), text);
  expect({ label, leak: stripped.includes(NAME_MARKER) }).toEqual({ label, leak: false });
  return hits.length;
}

async function setup() {
  const repo = makeRepo({
    "src/a/clean.ts": fn("cleanText"),
    "src/b/clean.ts": fn("cleanText"),
  });
  repos.push(repo);
  await indexAndSync(repo);
  writeFileSync(repo.paths.configPath, JSON.stringify({ renameSuggestions: true }));
  expect(loadConfig(repo.paths).renameSuggestions).toBe(true);
  repo.withStore((store) => {
    for (const s of store.effectiveSymbols()) {
      if (s.exactHash === "") continue;
      store.db
        .prepare(
          `INSERT OR REPLACE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
             provenance, model, prompt_version, created_at) VALUES (?, ?, '["url","text"]', 0, ?, 'model', 'test', 'p1', 'now')`,
        )
        .run(contentKey(s.exactHash), BEHAVIOR, NAME_MARKER);
    }
    refreshDescriptionFts(store);
  });
  const conn = await connect(repo, { getEmbedder: async () => undefined });
  conns.push(conn);
  return { repo, ...conn };
}

describe("suggestedName containment (#118)", () => {
  it("keeps it in untrusted_suggested_name across every MCP tool", async () => {
    const { client, repo } = await setup();
    const ids = repo.withStore((s) => s.effectiveSymbols().map((x) => x.id));
    const files = repo.withStore((s) => s.effectiveFiles().map((x) => x.path));
    const calls: [string, Record<string, unknown>][] = [
      ["gantry_find_similar", { query: "clean text", caller_path: "src/a/clean.ts" }],
      ["gantry_find_similar", { code: fn("cleanText"), caller_path: "src/a/clean.ts" }],
      ["gantry_find_similar", { code: fn("cleanText"), caller_path: "src/other.ts" }],
      ["gantry_search", { query: "clean text" }],
      ["gantry_search", { query: NAME_MARKER }],
      ["gantry_find_similar", { query: NAME_MARKER }],
      ...files.map((f): [string, Record<string, unknown>] => ["gantry_browse", { target: f }]),
      ["gantry_browse", { target: "src" }],
      ...ids.map((id): [string, Record<string, unknown>] => ["gantry_node", { target: id }]),
    ];
    let surfaced = 0;
    for (const [name, args] of calls) {
      const r = await call(client, name, args);
      surfaced += assertContained(`${name} ${JSON.stringify(args)}`, r.json, r.text);
    }
    // not vacuous: the rename advice really carries the value somewhere
    expect(surfaced).toBeGreaterThan(0);
  });

  it("keeps it in untrusted_suggested_name across explorer /api/*", async () => {
    const { repo } = await setup();
    const store = openStore(repo.paths.dbPath);
    try {
      const ctx = {
        store,
        paths: repo.paths,
        config: loadConfig(repo.paths),
        getEmbedder: async () => undefined,
      };
      const paths: [string, string][] = [["/api/meta", ""]];
      for (const v of listViews().filter((x) => x.enabled)) {
        paths.push([`/api/view/${v.id}`, ""]);
        paths.push([`/api/view/${v.id}`, "level=symbol"]);
      }
      for (const s of store.effectiveSymbols()) {
        paths.push([`/api/node/${encodeURIComponent(s.id)}`, ""]);
        paths.push([`/api/layout/${encodeURIComponent(s.id)}`, ""]);
      }
      for (const f of store.effectiveFiles()) paths.push([`/api/node/${encodeURIComponent(f.id)}`, ""]);
      paths.push(["/api/search", "q=clean text"], ["/api/search", `q=${NAME_MARKER}`]);
      for (const [p, q] of paths) {
        let body: unknown;
        try {
          body = await handleApi(ctx, p, new URLSearchParams(q));
        } catch (err) {
          if (!(err instanceof HttpError)) throw err; // a 4xx for a combination a view does not support carries no store data
          continue;
        }
        assertContained(`${p}?${q}`, body, JSON.stringify(body));
      }
      // The duplicates view reaches the rename only when no import advice outranks it (dupAdvice.test.ts asserts the
      // field is filled then); here it may be absent, but it must never leak.
    } finally {
      store.close();
    }
  });
});
