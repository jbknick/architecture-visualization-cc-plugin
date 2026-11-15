// Containment for #175: a fallback description (written by the host without a model, after repeated wording
// rejections) is still description text. Read back through gantry_node, gantry_search, gantry_browse and the explorer
// /api/node, it appears only as the value of `untrusted_description`, and its provenance comes out separately as
// `described_by: "fallback"`, a fixed value outside the untrusted text.

import { readFileSync } from "node:fs";
import { FALLBACK_MARK, loadConfig, openStore } from "@gantry/core";
import { handleApi } from "@gantry/explorer";
import { afterEach, describe, expect, it } from "vitest";
import { type Connected, call, connect, fn, indexAndSync, makeRepo, type Repo } from "./testkit.js";

const FIELD = "untrusted_description";
const repos: Repo[] = [];
const conns: Connected[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
  for (const r of repos.splice(0)) r.cleanup();
});

function leaves(v: unknown, key = "", out: { key: string; text: string }[] = []) {
  if (typeof v === "string") out.push({ key, text: v });
  else if (Array.isArray(v)) for (const x of v) leaves(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, k, out);
  return out;
}

/** The fallback text appears only as a value of FIELD; returns how many times it surfaced. */
function assertContained(label: string, value: unknown, marker: string): number {
  const hits = leaves(value).filter((l) => l.text.includes(marker));
  for (const h of hits) expect({ label, key: h.key }).toEqual({ label, key: FIELD });
  return hits.length;
}

/** Every object in `value` that holds FIELD with the marker also says described_by: fallback. */
function assertLabelled(label: string, value: unknown, marker: string): void {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o[FIELD] === "string" && (o[FIELD] as string).includes(marker))
        expect({ label, by: o.described_by }).toEqual({ label, by: "fallback" });
      Object.values(o).forEach(walk);
    }
  };
  walk(value);
}

describe("fallback description containment (#175)", () => {
  it("reads back only inside untrusted_description, labelled described_by: fallback", async () => {
    const repo = makeRepo({ "src/text/clean.ts": fn("cleanText") });
    repos.push(repo);
    await indexAndSync(repo);
    const conn = await connect(repo, { getEmbedder: async () => undefined });
    conns.push(conn);
    const { client } = conn;

    const c = await call(client, "gantry_claim_batch", { worker_id: "w1", size: 10 });
    const items = c.json.items as { content_key: string; path: string }[];
    const key = items.find((i) => i.path === "src/text/clean.ts")?.content_key as string;
    const bad = { behavior: "The clean text of an input.", searchTerms: ["clean text"], nameFits: true };
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) {
      last = (
        await call(client, "gantry_submit_descriptions", {
          batch_id: c.json.batch_id,
          results: [{ content_key: key, description: bad }],
        })
      ).json;
    }
    expect(last).toMatchObject({ fallbacks: 1 });

    const stored = repo.withStore(
      (s) =>
        s.db.prepare("SELECT behavior, provenance FROM descriptions WHERE content_key = ?").get(key) as {
          behavior: string;
          provenance: string;
        },
    );
    expect(stored.provenance).toBe("fallback");
    expect(stored.behavior).toContain(FALLBACK_MARK);
    const marker = stored.behavior;

    const id = repo.withStore((s) => s.effectiveSymbols().find((x) => x.name === "cleanText")?.id as string);
    let surfaced = 0;
    for (const [name, args] of [
      ["gantry_node", { target: id }],
      ["gantry_search", { query: "clean text" }],
      ["gantry_browse", { target: "src/text/clean.ts" }],
      ["gantry_find_similar", { query: "clean text" }],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(client, name, args);
      surfaced += assertContained(name, r.json, marker);
      assertLabelled(name, r.json, marker);
    }
    expect(surfaced).toBeGreaterThanOrEqual(3);

    // The catalog line is tagged from the provenance column (round 2).
    const browse = await call(client, "gantry_browse", { target: "src/text" });
    const catalog = readFileSync(browse.json.catalog_path as string, "utf8");
    expect(catalog).toContain("{described by: fallback}");

    const store = openStore(repo.paths.dbPath);
    try {
      const ctx = {
        store,
        paths: repo.paths,
        config: loadConfig(repo.paths),
        getEmbedder: async () => undefined,
      };
      const body = await handleApi(ctx, `/api/node/${encodeURIComponent(id)}`, new URLSearchParams());
      expect(assertContained("/api/node", body, marker)).toBe(1);
      expect(body).toMatchObject({ described_by: "fallback" });
    } finally {
      store.close();
    }
  });
});
