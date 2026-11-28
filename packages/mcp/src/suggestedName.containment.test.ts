// Containment for #118: a stored `suggestedName` is model-written and untrusted (spec section 8). With
// `renameSuggestions` on, the marker below may leave the store only as the value of `untrusted_suggested_name`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentKey, loadConfig, openStore, refreshDescriptionFts, writeCatalog } from "@gantry/core";
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

/** The marker is present only as a value of FIELD, and the serialized text has no other occurrence. */
function assertContained(label: string, value: unknown, text: string): number {
  const hits = leaves(value).filter((l) => l.text.includes(NAME_MARKER));
  for (const h of hits) expect({ label, key: h.key }).toEqual({ label, key: FIELD });
  const stripped = hits.reduce((acc, h) => acc.replaceAll(JSON.stringify(h.text), '""'), text);
  expect({ label, leak: stripped.includes(NAME_MARKER) }).toEqual({ label, leak: false });
  return hits.length;
}

/** Two exact copies in different files: the import advice (situation 1) outranks the rename advice. */
const TWO_FILES = {
  "src/a/clean.ts": fn("cleanText"),
  "src/b/clean.ts": fn("cleanText"),
};
/**
 * A renamed copy in the same file as the original: no import advice applies (caller and match are one file), so
 * the rename advice is the first line the duplicates view shows for it (#129).
 */
const SAME_FILE = {
  "src/a/clean.ts": `${fn("cleanText")}\n${fn("cleanTextCopy", "cleanText")}`,
};

async function setup(files: Record<string, string> = TWO_FILES) {
  const repo = makeRepo(files);
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
      ...ids.map((id): [string, Record<string, unknown>] => ["gantry_trace", { target: id }]),
      ...ids.map((id): [string, Record<string, unknown>] => [
        "gantry_trace",
        { target: id, direction: "up" },
      ]),
      // These never start the explorer: an unknown view and a reserved filter key are refused before it would.
      ["gantry_open_view", { view: "nope" }],
      ["gantry_open_view", { view: "duplicates", filters: { view: "x" } }],
    ];
    let surfaced = 0;
    for (const [name, args] of calls) {
      const r = await call(client, name, args);
      surfaced += assertContained(`${name} ${JSON.stringify(args)}`, r.json, r.text);
    }
    // not vacuous: the rename advice really carries the value somewhere
    expect(surfaced).toBeGreaterThan(0);

    // A submit whose wording the validator rejects: the reply names the item, never a stored suggested name.
    const claim = await call(client, "gantry_claim_batch", { worker_id: "w1", size: 10 });
    assertContained("gantry_claim_batch", claim.json, claim.text);
    const items = (claim.json.items ?? []) as { content_key: string }[];
    expect(items.length).toBeGreaterThan(0);
    const bad = { behavior: "The clean text of an input.", searchTerms: ["clean text"], nameFits: true };
    const sub = await call(client, "gantry_submit_descriptions", {
      batch_id: claim.json.batch_id,
      results: items.map((i) => ({ content_key: i.content_key, description: bad })),
    });
    assertContained("gantry_submit_descriptions", sub.json, sub.text);
    expect(sub.isError).toBe(false);
    // The rejected submit left the stored values alone.
    const left = repo.withStore(
      (st) =>
        (
          st.db
            .prepare("SELECT COUNT(*) AS n FROM descriptions WHERE suggested_name = ?")
            .get(NAME_MARKER) as {
            n: number;
          }
        ).n,
    );
    expect(left).toBeGreaterThan(0);
  });

  it("never writes it into the catalog files on disk", async () => {
    const { client, repo } = await setup();
    await call(client, "gantry_browse", { target: "src" });
    repo.withStore((s) => writeCatalog(s, repo.paths));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else files.push(join(dir, e.name));
      }
    };
    walk(repo.paths.catalogDir);
    expect(files.length).toBeGreaterThan(1);
    let described = 0;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect({ f, leak: text.includes(NAME_MARKER) }).toEqual({ f, leak: false });
      if (text.includes(BEHAVIOR)) described++;
    }
    // not vacuous: the catalog does carry the description next to the symbols
    expect(described).toBeGreaterThan(0);
  });

  it.each([
    ["two files (import advice wins)", TWO_FILES, false],
    ["a renamed copy in one file (rename advice wins)", SAME_FILE, true],
  ])(
    "keeps it in untrusted_suggested_name across explorer /api/*: %s",
    async (_label, files, mustSurface) => {
      const { repo } = await setup(files);
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
        let surfaced = 0;
        for (const [p, q] of paths) {
          let body: unknown;
          try {
            body = await handleApi(ctx, p, new URLSearchParams(q));
          } catch (err) {
            if (!(err instanceof HttpError)) throw err; // a 4xx for a combination a view does not support carries no store data
            continue;
          }
          surfaced += assertContained(`${p}?${q}`, body, JSON.stringify(body));
        }
        // The duplicates view reaches the rename only when no import advice outranks it: the same-file fixture
        // makes the rename the first advice, so the sweep must see the field there.
        if (mustSurface) {
          const dup = await handleApi(ctx, "/api/view/duplicates", new URLSearchParams());
          expect(assertContained("/api/view/duplicates", dup, JSON.stringify(dup))).toBeGreaterThan(0);
          expect(surfaced).toBeGreaterThan(0);
        }
      } finally {
        store.close();
      }
    },
  );
});
