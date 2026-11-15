import { rmSync } from "node:fs";
import {
  contentKey,
  type GantryConfig,
  type GantryPaths,
  rebuildSimilarEdges,
  type Store,
  storeDescriptions,
} from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleApi } from "../api.js";
import { fixtureStore } from "../testkit.js";
import type { ApiContext, ViewResult } from "../types.js";

const SLUG_WEB = "sym:apps/web/src/lib/slug.ts#slugify";
const SLUG_UTILS = "sym:packages/utils/src/slug.ts#slugify";
const DATE = "sym:packages/utils/src/date.ts#formatRelativeDate";
const TIME = "sym:packages/utils/src/time.ts#parseTimestamp";
const BUTTON = "sym:packages/ui/src/button.tsx#Button";

let store: Store;
let dir: string;
let ctx: ApiContext;

beforeAll(async () => {
  ({ store, dir } = fixtureStore("pnpm-turbo"));
  const config = {
    duplicates: {
      mode: "warn",
      ignore: [],
      thresholds: {
        nearJaccard: 0.85,
        nearTokenJaccard: 0.75,
        codeVector: 0.96,
        codeVectorTokenJaccard: 0.5,
        semantic: 0.6,
      },
    },
  } as unknown as GantryConfig;
  await rebuildSimilarEdges(store, { config, tiers: ["exact", "near"] });
  // One honest description (Button) and one that says the name is wrong (parseTimestamp).
  const sym = (id: string) => store.effectiveSymbols().find((s) => s.id === id);
  const describe_ = (id: string, nameFits: boolean) => ({
    contentKey: contentKey(sym(id)?.exactHash ?? ""),
    description: { behavior: "Does something specific.", searchTerms: ["x"], nameFits },
    model: "test",
  });
  storeDescriptions(store, [describe_(BUTTON, true), describe_(TIME, false)]);
  ctx = { store, paths: { root: dir } as GantryPaths, config };
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const symbols = (): ViewResult =>
  handleApi(ctx, "/api/view/project-map", new URLSearchParams("level=symbols")) as ViewResult;
const badgesOf = (r: ViewResult, id: string): string[] | undefined =>
  r.nodes.find((n) => n.id === id)?.badges;

describe("M2 badges", () => {
  it("snapshot: badged symbols of the project map (fixture)", () => {
    const rows = symbols()
      .nodes.filter((n) => n.badges?.some((b) => ["dup", "undescribed", "misleading"].includes(b)))
      .map((n) => ({ id: n.id, badges: n.badges }));
    expect(rows).toMatchSnapshot();
  });

  it("dup: both ends of a similar_to edge", () => {
    const r = symbols();
    for (const id of [SLUG_WEB, SLUG_UTILS, DATE, TIME]) expect(badgesOf(r, id)).toContain("dup");
    expect(badgesOf(r, BUTTON)).not.toContain("dup");
  });

  it("undescribed / misleading follow the stored description", () => {
    const r = symbols();
    expect(badgesOf(r, BUTTON)).toEqual(["exported"]);
    expect(badgesOf(r, TIME)).toContain("misleading");
    expect(badgesOf(r, TIME)).not.toContain("undescribed");
    expect(badgesOf(r, DATE)).toContain("undescribed");
  });

  it("types and other non-function symbols are never 'undescribed'", () => {
    const r = symbols();
    const kinds = new Set(["function", "method", "component", "hook"]);
    const nonFn = r.nodes.filter((n) => n.id.startsWith("sym:") && !kinds.has(n.kind));
    for (const n of nonFn) expect(n.badges ?? []).not.toContain("undescribed");
  });

  it("the ego view carries the same badges", () => {
    const r = handleApi(
      ctx,
      "/api/view/ego",
      new URLSearchParams(`focus=${encodeURIComponent(TIME)}`),
    ) as ViewResult;
    expect(badgesOf(r, TIME)).toEqual(expect.arrayContaining(["dup", "misleading"]));
  });

  it("is deterministic", () => {
    expect(JSON.stringify(symbols())).toBe(JSON.stringify(symbols()));
  });

  it("a dismissed pair no longer badges, but a symbol with another live pair still does", () => {
    // Insert the dismissal only (the edge stays) to prove the badge itself honours it.
    const [lo, hi] = SLUG_WEB < SLUG_UTILS ? [SLUG_WEB, SLUG_UTILS] : [SLUG_UTILS, SLUG_WEB];
    store.db.prepare("INSERT INTO dismissals(a, b, reason) VALUES (?, ?, 'test')").run(lo, hi);
    const r = symbols();
    expect(badgesOf(r, SLUG_WEB)).not.toContain("dup");
    expect(badgesOf(r, SLUG_UTILS)).not.toContain("dup");
    expect(badgesOf(r, DATE)).toContain("dup");
  });
});
