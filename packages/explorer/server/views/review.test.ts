import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { buildReview, clearReviewCache, type ReviewResult, ringPosition, ringRadii } from "./review.js";

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

const opts = (o: Record<string, unknown>) => ({ filters: [], options: o });
const strip = (r: ReviewResult) => ({
  ...r,
  review: r.review ? { ...r.review, ms: 0, cached: false } : null,
});

describe("ring layout", () => {
  it("puts one changed symbol in the centre and spaces rings at least RING_GAP apart, wider when crowded", () => {
    expect(ringRadii([1, 2, 1])).toEqual([0, 150, 300]);
    const crowded = ringRadii([3, 80]);
    expect(crowded[0]).toBe(70);
    expect(crowded[1]).toBeGreaterThan(220 * 1.7);
    expect(ringPosition(0, 1, 0, 0)).toEqual({ x: 0, y: 0 });
    // Nobody sits at the top, where the ring label is: even rings start half a step in, odd rings a quarter.
    expect(ringPosition(0, 4, 2, 100)).toEqual({ x: 70.7, y: -70.7 });
    expect(ringPosition(0, 4, 1, 100)).toEqual({ x: 38.3, y: -92.4 });
    expect(ringPosition(3, 4, 2, 100)).toEqual({ x: -70.7, y: -70.7 });
  });
});

describe("review view", () => {
  it("without range or pr returns an empty view and review: null", async () => {
    const { ctx } = await setup();
    expect(await buildReview(ctx, opts({}))).toEqual({
      nodes: [],
      edges: [],
      layoutHint: "radial",
      review: null,
    });
  });

  it("rings: Button in the centre with its signature change, callers by hop, edges between rings, the risk of reviewImpact", async () => {
    const { ctx, paths } = await setup();
    const r = await buildReview(ctx, opts({ range: "main...feature" }));
    expect(r.layoutHint).toBe("radial");
    const centre = r.nodes.filter((n) => n.hop === 0);
    expect(centre).toEqual([
      expect.objectContaining({
        id: BUTTON,
        change: "modified",
        signatureChanged: true,
        x: 0,
        y: 0,
        kind: "component",
      }),
    ]);
    const ring1 = r.nodes.filter((n) => n.hop === 1).map((n) => n.id);
    expect(ring1).toContain(HOME);
    expect(ring1).toEqual([...ring1].sort());
    // Every edge joins ring h + 1 to ring h.
    const hop = new Map(r.nodes.map((n) => [n.id, n.hop ?? 0]));
    for (const e of r.edges) expect((hop.get(e.src) ?? -1) - (hop.get(e.dst) ?? -9)).toBe(1);
    expect(r.edges.some((e) => e.src === HOME && e.dst === BUTTON && e.kind === "renders")).toBe(true);

    const diff = await reviewDiff(paths, "main", "feature");
    const impact = await reviewImpact(paths, ctx.store, diff);
    const review = r.review;
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
    expect(change?.callers).toBe(r.edges.filter((e) => e.dst === BUTTON).length);
    expect(review?.rules.map((x) => x.id)).toContain("signatureChangedExported");
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

  it("overlay: the project map's workspaces and files, the changed file and the caller files marked", async () => {
    const { ctx } = await setup();
    const r = await buildReview(ctx, opts({ range: "main...feature", mode: "overlay" }));
    expect(r.review?.mode).toBe("overlay");
    expect(r.edges).toEqual([]);
    const file = (p: string) => r.nodes.find((n) => n.id === `file:${p}`);
    expect(file("packages/ui/src/button.tsx")).toMatchObject({ mark: "changed", change: "modified" });
    expect(file("apps/web/src/routes/index.tsx")).toMatchObject({ mark: "affected" });
    expect(r.nodes.some((n) => n.kind === "file" && n.mark === undefined)).toBe(true);
    expect(r.nodes.filter((n) => n.kind === "workspace").length).toBe(ctx.store.listWorkspaces().length);
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

  it("is served through /api/view/review with the filters JSON, like the web sends it", async () => {
    const { ctx } = await setup();
    const q = new URLSearchParams({ filters: JSON.stringify({ range: "main...feature" }) });
    const body = (await handleApi(ctx, "/api/view/review", q)) as ReviewResult;
    expect(body.review?.changes.map((c) => c.id)).toEqual([BUTTON]);
  });

  it("returns a stored description only as untrusted_description", async () => {
    const { ctx } = await setup({ describe: true });
    for (const mode of ["rings", "overlay"]) {
      const r = await buildReview(ctx, opts({ range: "main...feature", mode }));
      const text = JSON.stringify(r);
      expect(r.review?.changes[0]?.untrusted_description).toContain(MARKER);
      const stripped = text.replaceAll(JSON.stringify(r.review?.changes[0]?.untrusted_description), '""');
      expect(stripped.includes(MARKER)).toBe(false);
    }
  });
});
