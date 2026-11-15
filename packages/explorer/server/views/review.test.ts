import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentKey,
  type GantryPaths,
  indexRepo,
  loadConfig,
  openStore,
  refreshDescriptionFts,
  resolvePaths,
  reviewDiff,
  reviewImpact,
  type Store,
} from "@gantry/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError, handleApi } from "../api.js";
import type { ApiContext } from "../types.js";
import { projectMapView } from "./projectMap.js";
import { clearReviewCache, type ReviewResult, ringPosition, ringRadii, ringSlots } from "./review.js";
import { buildReview } from "./reviewView.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const BUTTON = "sym:packages/ui/src/button.tsx#Button";
const HOME = "sym:apps/web/src/routes/index.tsx#HomePage";
const MARKER = "ZetaNineReviewMarker";

const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
const stores: Store[] = [];
beforeEach(() => clearReviewCache());
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

/** fixtures/pnpm-turbo indexed at main, with a `feature` branch that adds `size` to Button's props; main checked out. */
async function setup(
  opts: { describe?: boolean } = {},
): Promise<{ ctx: ApiContext; fx: MaterializedFixture; paths: GantryPaths }> {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  const data = mkdtempSync(join(tmpdir(), "gantry-review-view-"));
  dataDirs.push(data);
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  stores.push(store);
  if (opts.describe) {
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
  }
  fx.git(["checkout", "-b", "feature"]);
  const file = join(fx.dir, "packages/ui/src/button.tsx");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "{ label, onClick }: { label: string; onClick?: () => void }",
      "{ label, onClick, size }: { label: string; onClick?: () => void; size?: number }",
    ),
  );
  fx.git(["add", "-A"]);
  fx.git(["commit", "-m", "button signature"]);
  fx.git(["checkout", "main"]);
  return { ctx: { store, paths, config: loadConfig(paths) }, fx, paths };
}

const opts = (o: Record<string, unknown>, level?: "workspaces" | "dirs" | "files" | "symbols") => ({
  filters: [],
  options: o,
  ...(level ? { level } : {}),
});
const strip = (r: ReviewResult) => ({
  ...r,
  review: r.review ? { ...r.review, ms: 0, cached: false } : null,
});
const fileId = (p: string) => `file:${p}`;
const BUTTON_FILE = fileId("packages/ui/src/button.tsx");
const HOME_FILE = fileId("apps/web/src/routes/index.tsx");

describe("review view", () => {
  it("without range or pr returns an empty view and review: null", async () => {
    const { ctx } = await setup();
    expect(await buildReview(ctx, opts({}))).toEqual({
      nodes: [],
      edges: [],
      layoutHint: "review",
      review: null,
    });
  });

  it("files level: the changed file coloured by kind, caller files by hop, file-to-file lines, the risk of reviewImpact", async () => {
    const { ctx, paths } = await setup();
    const r = await buildReview(ctx, opts({ range: "main...feature" }));
    expect(r.layoutHint).toBe("review");
    const layer = r.review?.layer;
    const mark = (id: string) => layer?.marks.find((m) => m.id === id);
    expect(mark(BUTTON_FILE)).toEqual({ id: BUTTON_FILE, change: "signature", changes: 1 });
    expect(mark(HOME_FILE)).toEqual({ id: HOME_FILE, hop: 1 });
    expect(layer?.placed).toContainEqual([BUTTON, BUTTON_FILE]);
    expect(layer?.unplaced).toEqual([]);
    expect(layer?.links).toContainEqual({
      id: `${HOME_FILE}->${BUTTON_FILE}`,
      src: HOME_FILE,
      dst: BUTTON_FILE,
      change: "signature",
      weight: 1,
    });
    // Every line points at the changed file and starts at a marked caller; all ends are nodes of this response.
    const ids = new Set(r.nodes.map((n) => n.id));
    for (const l of layer?.links ?? []) {
      expect(l.dst).toBe(BUTTON_FILE);
      expect(mark(l.src)?.hop).toBe(1);
      expect(ids.has(l.src) && ids.has(l.dst)).toBe(true);
    }
    for (const m of layer?.marks ?? []) expect(ids.has(m.id)).toBe(true);
    expect(layer?.linksTotal).toBe(layer?.links.length);

    const diff = await reviewDiff(paths, "main", "feature");
    const impact = await reviewImpact(paths, ctx.store, diff);
    const review = r.review;
    expect(review?.map).toBe("2d");
    expect(review?.risk).toEqual(impact.risk);
    expect(review?.crossings).toEqual(impact.crossings);
    expect(review?.notes).toEqual(impact.notes);
    expect(review?.callersByHop).toEqual(
      impact.callersByHop.map((h) => ({ hop: h.hop, count: h.ids.length })),
    );
    expect(review?.range).toBe("main...feature");
    expect(review?.files).toEqual([{ path: "packages/ui/src/button.tsx", status: "M", changes: 1 }]);
    const change = review?.changes[0];
    expect(change?.id).toBe(BUTTON);
    expect(change?.before?.signature).not.toEqual(change?.after?.signature);
    expect(change?.after?.signature).toContain("size?: number");
    expect(change?.callers).toBe(impact.callersByHop[0]?.ids.length);
    expect(review?.rules.map((x) => x.id)).toContain("signatureChangedExported");
  });

  it("function level: Button itself marked, function-to-function lines from its callers", async () => {
    const { ctx } = await setup();
    const r = await buildReview(ctx, opts({ range: "main...feature" }, "symbols"));
    const layer = r.review?.layer;
    expect(layer?.marks.find((m) => m.id === BUTTON)).toEqual({
      id: BUTTON,
      change: "signature",
      changes: 1,
    });
    // The file still counts as changed (a diff entry), the caller as hop 1.
    expect(layer?.marks.find((m) => m.id === BUTTON_FILE)?.change).toBe("modified");
    expect(layer?.marks.find((m) => m.id === HOME)).toEqual({ id: HOME, hop: 1 });
    expect(layer?.links).toContainEqual(
      expect.objectContaining({ src: HOME, dst: BUTTON, change: "signature", weight: 1 }),
    );
    for (const l of layer?.links ?? []) expect(l.dst).toBe(BUTTON);
    expect(layer?.placed).toContainEqual([BUTTON, BUTTON]);
  });

  it("workspace level: lines join workspaces, never a node to itself", async () => {
    const { ctx } = await setup();
    const r = await buildReview(ctx, opts({ range: "main...feature" }, "workspaces"));
    const layer = r.review?.layer;
    const ids = new Set(r.nodes.map((n) => n.id));
    expect(layer?.marks.some((m) => m.change === "signature" && m.id.startsWith("ws:"))).toBe(true);
    expect((layer?.links ?? []).length).toBeGreaterThan(0);
    for (const l of layer?.links ?? []) {
      expect(l.src).not.toBe(l.dst);
      expect(ids.has(l.src) && ids.has(l.dst)).toBe(true);
    }
  });

  it("positions: the review view's nodes and edges are the plain project map's for every level and filter", async () => {
    const { ctx } = await setup();
    const levels = ["workspaces", "dirs", "files", "symbols"] as const;
    for (const level of levels) {
      for (const extra of [{}, { hideTests: "false" }, { exportedOnly: "true" }]) {
        const plain = await projectMapView.build(ctx, opts(extra, level));
        const review = await buildReview(ctx, opts({ ...extra, range: "main...feature" }, level));
        const layered = (await projectMapView.build(
          ctx,
          opts({ ...extra, range: "main...feature" }, level),
        )) as ReviewResult;
        expect(review.nodes).toEqual(plain.nodes);
        expect(review.edges).toEqual(plain.edges);
        expect(layered.nodes).toEqual(plain.nodes);
        expect(layered.edges).toEqual(plain.edges);
        expect(layered.review?.layer).toEqual(review.review?.layer);
      }
    }
  });

  it("rings: Button in the centre, callers by hop grouped by file, edges from caller to callee, the same review data", async () => {
    const { ctx } = await setup();
    const r = await buildReview(ctx, opts({ range: "main...feature", mode: "rings" }));
    expect(r.review?.mode).toBe("rings");
    expect(r.nodes.filter((n) => n.hop === 0)).toEqual([
      expect.objectContaining({
        id: BUTTON,
        change: "modified",
        signatureChanged: true,
        group: "packages/ui/src/button.tsx",
        x: 0,
        y: 0,
      }),
    ]);
    const hop = new Map(r.nodes.map((n) => [n.id, n.hop ?? 0]));
    for (const e of r.edges) expect((hop.get(e.src) ?? -1) - (hop.get(e.dst) ?? -9)).toBe(1);
    expect(r.edges.some((e) => e.src === HOME && e.dst === BUTTON)).toBe(true);
    // Every caller carries its file as its group, and the layer marks the ring nodes themselves.
    for (const n of r.nodes) expect(n.group).toBe(n.path);
    expect(r.review?.layer.marks.find((m) => m.id === BUTTON)?.change).toBe("signature");
    expect(r.review?.layer.marks.find((m) => m.id === HOME)?.hop).toBe(1);
    const map = await buildReview(ctx, opts({ range: "main...feature" }));
    expect(r.review?.risk).toEqual(map.review?.risk);
    expect(r.review?.changes).toEqual(map.review?.changes);
  });

  it("ring slots: files grouped together with one empty slot between groups; radii fit the slots", () => {
    const { slots, at } = ringSlots([
      { id: "sym:b.ts#y", group: "b.ts" },
      { id: "sym:a.ts#z", group: "a.ts" },
      { id: "sym:b.ts#x", group: "b.ts" },
      { id: "sym:a.ts#w", group: "a.ts" },
      { id: "sym:c.ts#v", group: "c.ts" },
    ]);
    expect(Object.fromEntries(at)).toEqual({
      "sym:a.ts#w": 0,
      "sym:a.ts#z": 1,
      "sym:b.ts#x": 3,
      "sym:b.ts#y": 4,
      "sym:c.ts#v": 6,
    });
    expect(slots).toBe(8);
    expect(ringSlots([{ id: "x", group: "a" }])).toEqual({ slots: 1, at: new Map([["x", 0]]) });
    expect(ringRadii([1, 2, 1])).toEqual([0, 150, 300]);
    expect(ringRadii([3, 80])[1]).toBeGreaterThan(380);
    expect(ringPosition(0, 1, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(ringPosition(0, 4, 2, 100)).toEqual({ x: 70.7, y: -70.7 });
    expect(ringPosition(0, 4, 1, 100)).toEqual({ x: 38.3, y: -92.4 });
  });

  it("map=3d: the Files level (one building per file) whatever level is asked, and focus never narrows the map", async () => {
    const { ctx } = await setup();
    const plain = await projectMapView.build(ctx, opts({}, "files"));
    const r = await buildReview(ctx, opts({ range: "main...feature", map: "3d" }, "symbols"));
    expect(r.review?.map).toBe("3d");
    expect(r.nodes).toEqual(plain.nodes);
    expect(r.review?.layer.marks.find((m) => m.id === BUTTON_FILE)?.change).toBe("signature");
    const focused = await buildReview(ctx, { ...opts({ range: "main...feature" }), focus: BUTTON });
    expect(focused.nodes).toEqual(plain.nodes);
  });

  it("caches per (merge base, head): the second answer is cached and otherwise identical, and the index is unchanged", async () => {
    const { ctx } = await setup();
    const counts = () => ({
      files: ctx.store.effectiveFiles().length,
      symbols: ctx.store.effectiveSymbols().length,
      head: ctx.store.getMeta("head_sha"),
    });
    const before = counts();
    const a = await buildReview(ctx, opts({ range: "main...feature" }));
    const b = await buildReview(ctx, opts({ range: "main..feature" }));
    expect(a.review?.cached).toBe(false);
    expect(b.review?.cached).toBe(true);
    expect(strip(b)).toEqual({ ...strip(a), review: { ...strip(a).review, range: "main...feature" } });
    expect(counts()).toEqual(before);
  });

  it("is deterministic across runs (fresh caches)", async () => {
    const { ctx } = await setup();
    const a = strip(await buildReview(ctx, opts({ range: "main...feature" })));
    clearReviewCache();
    expect(strip(await buildReview(ctx, opts({ range: "main...feature" })))).toEqual(a);
  });

  it("rejects a bad range, an unknown ref, both range and pr, and a malformed pr with a 400", async () => {
    const { ctx } = await setup();
    const status = async (o: Record<string, unknown>) => {
      try {
        await buildReview(ctx, opts(o));
        return 200;
      } catch (e) {
        return e instanceof HttpError ? `${e.status} ${e.message}` : String(e);
      }
    };
    expect(await status({ range: "main" })).toMatch(/^400 expected <base>...<head>/);
    expect(await status({ range: "main...nope" })).toBe("400 unknown git ref: nope");
    expect(await status({ range: "--output=x...main" })).toMatch(/^400 invalid git ref/);
    expect(await status({ range: "main...feature", pr: "3" })).toBe("400 Give either range or pr, not both");
    expect(await status({ pr: "1; rm -rf" })).toMatch(/^400 invalid pull request number/);
  });

  it("recomputes after another process writes to the index (hooks and the MCP server re-index working edits)", async () => {
    const { ctx, paths } = await setup();
    expect((await buildReview(ctx, opts({ range: "main...feature" }))).review?.cached).toBe(false);
    expect((await buildReview(ctx, opts({ range: "main...feature" }))).review?.cached).toBe(true);
    // Another connection commits, as a hook process would; head_sha stays the same.
    const other = openStore(paths.dbPath);
    other.setMeta("last_refresh_at", "2026-01-01T00:00:00.000Z");
    other.close();
    expect((await buildReview(ctx, opts({ range: "main...feature" }))).review?.cached).toBe(false);
  });

  it("pr: resolves the pull request with gh once and reuses the refs for the next requests", async () => {
    const { ctx, fx } = await setup();
    const featureSha = fx.git(["rev-parse", "feature"]).trim();
    // As after a clone: the base branch is known as origin/main, so nothing is fetched.
    fx.git(["update-ref", "refs/remotes/origin/main", "main"]);
    const bin = mkdtempSync(join(tmpdir(), "gantry-fake-gh-"));
    dataDirs.push(bin);
    mkdirSync(bin, { recursive: true });
    const calls = join(bin, "calls.txt");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho x >> "${calls}"\necho '{"baseRefName":"main","headRefOid":"${featureSha}"}'\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const a = await buildReview(ctx, opts({ pr: "7" }));
      const b = await buildReview(ctx, opts({ pr: "7" }));
      expect(a.review?.pr).toBe(7);
      expect(a.review?.changes.map((c) => c.id)).toEqual([BUTTON]);
      expect(b.review?.cached).toBe(true);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      process.env.PATH = path;
    }
  });

  it("is served through /api/view/review with the filters JSON, like the web sends it", async () => {
    const { ctx } = await setup();
    const q = new URLSearchParams({ filters: JSON.stringify({ range: "main...feature" }) });
    const body = (await handleApi(ctx, "/api/view/review", q)) as ReviewResult;
    expect(body.review?.changes.map((c) => c.id)).toEqual([BUTTON]);
  });

  it("returns a stored description only as untrusted_description", async () => {
    const { ctx } = await setup({ describe: true });
    for (const map of ["2d", "3d", "rings"]) {
      const r = await buildReview(
        ctx,
        opts(map === "rings" ? { range: "main...feature", mode: map } : { range: "main...feature", map }),
      );
      const text = JSON.stringify(r);
      expect(r.review?.changes[0]?.untrusted_description).toContain(MARKER);
      const stripped = text.replaceAll(JSON.stringify(r.review?.changes[0]?.untrusted_description), '""');
      expect(stripped.includes(MARKER)).toBe(false);
    }
  });
});
