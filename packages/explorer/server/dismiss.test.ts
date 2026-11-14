import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  findDuplicates,
  type GantryConfig,
  type GantryPaths,
  openStore,
  rebuildSimilarEdges,
  type Store,
} from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExplorerServer, startExplorerServer } from "./index.js";
import { fixtureStore } from "./testkit.js";
import type { DuplicatesResult } from "./views/duplicates.js";

const SLUG_WEB = "sym:apps/web/src/lib/slug.ts#slugify";
const SLUG_UTILS = "sym:packages/utils/src/slug.ts#slugify";
const DATE = "sym:packages/utils/src/date.ts#formatRelativeDate";
const TIME = "sym:packages/utils/src/time.ts#parseTimestamp";

const config = {
  duplicates: {
    mode: "warn",
    ignore: [],
    thresholds: { nearJaccard: 0.85, codeVector: 0.96, semantic: 0.6 },
  },
} as unknown as GantryConfig;

let dir: string;
let store: Store;
let srv: ExplorerServer;

const paths = (): GantryPaths => ({ root: dir, dataDir: dir, dbPath: join(dir, "gantry.db") }) as GantryPaths;

async function start(s: Store): Promise<ExplorerServer> {
  return startExplorerServer({ paths: paths(), store: s, config, writeStateFile: false });
}

const headers = (extra: Record<string, string> = {}) => ({ "x-gantry-token": srv.token, ...extra });
const url = (p: string) => `http://127.0.0.1:${srv.port}${p}`;
const put = (body: unknown, extra: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(url("/api/dismiss"), {
    method: "PUT",
    headers: headers(extra),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const clusters = async (): Promise<DuplicatesResult> =>
  (await (await fetch(url("/api/view/duplicates"), { headers: headers() })).json()) as DuplicatesResult;

beforeAll(async () => {
  ({ store, dir } = fixtureStore("pnpm-turbo"));
  await rebuildSimilarEdges(store, { config, tiers: ["exact", "near"] });
  srv = await start(store);
});
afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PUT /api/dismiss", () => {
  it("is gated by token, Host and Origin and takes JSON only", async () => {
    const body = { a: SLUG_WEB, b: SLUG_UTILS };
    const noToken = await fetch(url("/api/dismiss"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(noToken.status).toBe(403);
    expect(
      (await put(body, { "content-type": "application/json", origin: "http://evil.example" })).status,
    ).toBe(403);
    expect((await put(body, { "content-type": "text/plain" })).status).toBe(415);
    expect((await put(body, {})).status).toBe(415);
    // Nothing above changed anything.
    expect((await clusters()).clusters).toHaveLength(2);
  });

  it("only PUT writes: other methods and other API routes stay read-only", async () => {
    for (const method of ["POST", "DELETE", "PATCH"]) {
      const res = await fetch(url("/api/dismiss"), {
        method,
        headers: headers({ "content-type": "application/json" }),
        body: "{}",
      });
      expect(res.status).toBe(405);
    }
    const res = await fetch(url("/api/meta"), {
      method: "PUT",
      headers: headers({ "content-type": "application/json" }),
      body: "{}",
    });
    expect(res.status).toBe(405);
  });

  it("validates the body: shape, existing symbol ids, different ids, reason length, size", async () => {
    expect((await put("not json")).status).toBe(400);
    expect((await put([1])).status).toBe(400);
    expect((await put({ a: SLUG_WEB })).status).toBe(400);
    expect((await put({ a: 1, b: 2 })).status).toBe(400);
    expect((await put({ a: SLUG_WEB, b: SLUG_WEB })).status).toBe(400);
    expect((await put({ a: SLUG_WEB, b: "sym:nope.ts#missing" })).status).toBe(404);
    expect((await put({ a: SLUG_WEB, b: "file:packages/utils/src/slug.ts" })).status).toBe(404);
    expect((await put({ a: SLUG_WEB, b: SLUG_UTILS, reason: 5 })).status).toBe(400);
    expect((await put({ a: SLUG_WEB, b: SLUG_UTILS, reason: "x".repeat(201) })).status).toBe(400);
    // Over 4 KB: the server answers 413 and may cut the connection while the body is still being sent.
    const big = await put({ a: SLUG_WEB, b: SLUG_UTILS, pad: "x".repeat(5000) }).then(
      (r) => r.status,
      () => 413,
    );
    expect(big).toBe(413);
    expect((await clusters()).clusters).toHaveLength(2);
  });

  it("dismisses a pair, returns the updated summary, and survives a server restart", async () => {
    const res = await put({ a: DATE, b: TIME, reason: "different on purpose" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dismissed: { a: string; b: string; reason: string };
      summary: DuplicatesResult["summary"];
      clusters: { id: string; size: number }[];
    };
    expect(body.dismissed).toEqual({ a: DATE, b: TIME, reason: "different on purpose" });
    expect(body.summary.clusters).toBe(1);
    expect(body.clusters).toHaveLength(1);
    expect((await clusters()).clusters.map((c) => c.keep)).toEqual([SLUG_UTILS]);

    // Restart: a new server on a freshly opened store of the same database file.
    await srv.close();
    store.close();
    store = openStore(join(dir, "gantry.db"));
    srv = await start(store);
    const after = await clusters();
    expect(after.clusters).toHaveLength(1);
    expect(after.clusters[0]?.members.map((m) => m.id)).not.toContain(DATE);

    // The duplicate guard honours the same dismissal.
    const sym = store.getSymbol(DATE);
    if (!sym) throw new Error("fixture symbol missing");
    const found = await findDuplicates(store, { symbol: sym }, { config });
    expect(found.map((c) => c.symbolId)).not.toContain(TIME);

    // A later edge rebuild does not bring it back.
    await rebuildSimilarEdges(store, { config, tiers: ["exact", "near"] });
    expect((await clusters()).clusters).toHaveLength(1);
  });

  it("dismissing the same pair again, in the other order, just updates the reason", async () => {
    const res = await put({ a: SLUG_UTILS, b: SLUG_WEB });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { summary: { clusters: number } }).summary.clusters).toBe(0);
    expect((await clusters()).clusters).toEqual([]);
    expect((await put({ a: SLUG_WEB, b: SLUG_UTILS, reason: "again" })).status).toBe(200);
  });
});
