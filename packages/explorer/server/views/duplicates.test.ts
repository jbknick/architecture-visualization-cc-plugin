import { rmSync } from "node:fs";
import { type GantryConfig, type GantryPaths, rebuildSimilarEdges, type Store } from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleApi } from "../api.js";
import { fixtureStore } from "../testkit.js";
import type { ApiContext } from "../types.js";
import type { DuplicatesResult } from "./duplicates.js";

const SLUG_WEB = "sym:apps/web/src/lib/slug.ts#slugify";
const SLUG_UTILS = "sym:packages/utils/src/slug.ts#slugify";
const DATE = "sym:packages/utils/src/date.ts#formatRelativeDate";
const TIME = "sym:packages/utils/src/time.ts#parseTimestamp";

let store: Store;
let dir: string;
let ctx: ApiContext;
let config: GantryConfig;

beforeAll(async () => {
  ({ store, dir } = fixtureStore("pnpm-turbo"));
  config = {
    duplicates: {
      mode: "warn",
      ignore: [],
      thresholds: { nearJaccard: 0.85, codeVector: 0.96, semantic: 0.6 },
    },
  } as unknown as GantryConfig;
  await rebuildSimilarEdges(store, { config, tiers: ["exact", "near"] });
  ctx = { store, paths: { root: dir } as GantryPaths, config };
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const dups = (qs = ""): DuplicatesResult =>
  handleApi(ctx, "/api/view/duplicates", new URLSearchParams(qs)) as DuplicatesResult;

describe("duplicates view", () => {
  it("snapshot: fixture clusters", () => {
    expect(dups()).toMatchSnapshot();
  });

  it("lists the slugify exact pair with the keep candidate in packages/utils", () => {
    const c = dups().clusters.find((x) => x.members.some((m) => m.id === SLUG_UTILS));
    expect(c?.tier).toBe("exact");
    expect(c?.members.map((m) => m.id).sort()).toEqual([SLUG_WEB, SLUG_UTILS].sort());
    expect(c?.keep).toBe(SLUG_UTILS);
    const other = c?.members.find((m) => !m.keep);
    expect(other).toMatchObject({ id: SLUG_WEB, tier: "exact", score: 1 });
    expect(c?.keepReason).toContain("shared package");
  });

  it("lists formatRelativeDate / parseTimestamp as a near pair with the keep candidate in packages/utils", () => {
    const c = dups().clusters.find((x) => x.members.some((m) => m.id === DATE));
    expect(c?.members.map((m) => m.id).sort()).toEqual([DATE, TIME].sort());
    expect(c?.tier).toBe("near");
    const keep = c?.members.find((m) => m.keep);
    expect(keep?.path.startsWith("packages/utils/")).toBe(true);
    const other = c?.members.find((m) => !m.keep);
    expect(other?.tier).toBe("near");
    expect(other?.score).toBeGreaterThan(0.85);
    expect(other?.score).toBeLessThanOrEqual(1);
  });

  it("ranks by size x total lines, with totals and a summary that add up", () => {
    const r = dups();
    for (const c of r.clusters) {
      expect(c.rank).toBe(c.size * c.loc);
      expect(c.loc).toBe(c.members.reduce((s, m) => s + m.loc, 0));
      expect(c.members.filter((m) => m.keep)).toHaveLength(1);
      expect(c.members[0]?.keep).toBe(true);
    }
    const ranks = r.clusters.map((c) => c.rank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(r.summary.clusters).toBe(r.clusters.length);
    expect(r.summary.functions).toBe(r.clusters.reduce((s, c) => s + c.size, 0));
    expect(r.summary.duplicateLines).toBe(
      r.clusters.reduce((s, c) => s + c.members.filter((m) => !m.keep).reduce((t, m) => t + m.loc, 0), 0),
    );
    expect(r.splits.reduce((s, x) => s + x.clusters, 0)).toBe(r.clusters.length);
    expect(r.layoutHint).toBe("clusters");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(dups())).toBe(JSON.stringify(dups()));
  });

  it("filters by tier, workspace and size", () => {
    expect(dups("filters=tiers=exact").clusters.every((c) => c.tier === "exact")).toBe(true);
    expect(dups("filters=tiers=near").clusters.some((c) => c.members.some((m) => m.id === SLUG_UTILS))).toBe(
      false,
    );
    const web = dups(`filters=${encodeURIComponent(JSON.stringify({ workspaces: "ws:@acme/db" }))}`);
    expect(web.clusters).toEqual([]);
    expect(dups("filters=minSize=3").clusters.every((c) => c.size >= 3)).toBe(true);
    expect(dups(`filters=${encodeURIComponent(JSON.stringify({ tiers: "code_vector" }))}`).clusters).toEqual(
      [],
    );
  });

  it("reports the vector tiers as skipped when nothing is embedded", () => {
    const skipped = dups().skipped;
    expect(skipped.some((s) => s.tier === "code_vector")).toBe(true);
    expect(skipped.every((s) => s.message.length > 0)).toBe(true);
  });

  it("carries optional advice only when core exports adviseReuse", () => {
    for (const c of dups().clusters) for (const m of c.members) expect(m.advice).toBeUndefined();
  });
});
