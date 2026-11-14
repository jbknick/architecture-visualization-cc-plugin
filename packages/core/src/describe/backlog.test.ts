import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { openStore, type Store } from "../store/index.js";
import {
  BATCH_SIZE,
  backlogPriority,
  CLAIM_TTL_MS,
  claimBatch,
  estimate,
  releaseExpiredClaims,
  syncBacklog,
} from "./backlog.js";
import { contentKey } from "./factsheet.js";
import { cleanupData, fakeSymbol, type Indexed, indexedFixture, putFile } from "./testkit.js";

const here = dirname(fileURLToPath(import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanupData();
  for (const c of cleanups.splice(0)) c();
});

interface Row {
  content_key: string;
  symbol_id: string;
  priority: number;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
}
const backlog = (s: Store): Row[] =>
  s.db.prepare("SELECT * FROM backlog ORDER BY priority, symbol_id").all() as Row[];
const keyOf = (s: Store, id: string): string => contentKey(s.getSymbol(id)?.exactHash as string);

describe("backlogPriority", () => {
  it("follows spec section 9", () => {
    expect(backlogPriority("function", true, "src/util.ts")).toBe(0);
    expect(backlogPriority("method", true, "src/util.ts")).toBe(1);
    expect(backlogPriority("function", false, "src/util.ts")).toBe(2);
    expect(backlogPriority("function", false, "apps/web/src/routes/index.tsx")).toBe(0);
  });
});

describe("syncBacklog", () => {
  it("templates one-line functions and enqueues the rest with priorities", async () => {
    const ix = await indexedFixture();
    try {
      const r = syncBacklog(ix.store);
      expect(r.templated).toBeGreaterThan(0);
      expect(r.enqueued).toBeGreaterThan(0);
      expect(r.alreadyDescribed).toBe(0);

      // createPost is `return db.insert(...)`: described by template, not in the backlog.
      const createKey = keyOf(ix.store, "sym:packages/db/src/queries.ts#createPost");
      const d = ix.store.db.prepare("SELECT * FROM descriptions WHERE content_key = ?").get(createKey) as
        | Record<string, unknown>
        | undefined;
      expect(d?.provenance).toBe("template");
      expect(String(d?.behavior)).toMatch(/^Returns db\.insert\(posts\)/);
      expect(d?.name_fits).toBe(1);
      expect(d?.prompt_version).toBe("p1");
      expect(JSON.parse(String(d?.search_terms))).toContain("create post");
      expect(backlog(ix.store).some((b) => b.content_key === createKey)).toBe(false);

      const rows = backlog(ix.store);
      const byId = new Map(rows.map((b) => [b.symbol_id, b]));
      expect(byId.get("sym:apps/web/src/hooks/useDebounce.ts#useDebounce")).toMatchObject({
        priority: 0,
        status: "pending",
      });
      // utils/slug.ts#slugify is a local copy of the exported apps/web one: same contentKey, best priority wins.
      expect(byId.get("sym:apps/web/src/lib/slug.ts#slugify")?.priority).toBe(0);
      for (const b of rows) expect(b.content_key.endsWith(":p1")).toBe(true);

      // Idempotent.
      const again = syncBacklog(ix.store);
      expect(again.enqueued).toBe(0);
      expect(again.templated).toBe(0);
      expect(again.alreadyDescribed).toBe(r.templated);
      expect(backlog(ix.store)).toHaveLength(rows.length);
    } finally {
      await ix.close();
    }
  });

  it("skips functions that already have a description", async () => {
    const ix = await indexedFixture();
    try {
      const key = keyOf(ix.store, "sym:packages/utils/src/time.ts#parseTimestamp");
      ix.store.db
        .prepare(
          "INSERT INTO descriptions(content_key, behavior, search_terms, name_fits, provenance) VALUES (?, 'b', '[]', 1, 'model')",
        )
        .run(key);
      syncBacklog(ix.store);
      expect(backlog(ix.store).some((b) => b.content_key === key)).toBe(false);
    } finally {
      await ix.close();
    }
  });

  async function move(ix: Indexed): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const from = join(ix.fx.dir, "packages/utils/src/date.ts");
    writeFileSync(join(ix.fx.dir, "packages/utils/src/moved-date.ts"), readFileSync(from, "utf8"));
    unlinkSync(from);
    await indexRepo(ix.paths, { layer: "main", store: ix.store });
  }

  it("does not re-enqueue a pending function that moved to another file", async () => {
    const ix = await indexedFixture();
    try {
      syncBacklog(ix.store);
      const key = keyOf(ix.store, "sym:packages/utils/src/date.ts#formatRelativeDate");
      const before = backlog(ix.store);
      expect(before.find((b) => b.content_key === key)?.symbol_id).toBe(
        "sym:packages/utils/src/date.ts#formatRelativeDate",
      );
      await move(ix);
      const r = syncBacklog(ix.store);
      expect(r.enqueued).toBe(0);
      const after = backlog(ix.store);
      expect(after).toHaveLength(before.length);
      expect(after.find((b) => b.content_key === key)?.symbol_id).toBe(
        "sym:packages/utils/src/moved-date.ts#formatRelativeDate",
      );
    } finally {
      await ix.close();
    }
  });

  it("does not re-enqueue a described function that moved to another file", async () => {
    const ix = await indexedFixture();
    try {
      const key = keyOf(ix.store, "sym:packages/utils/src/date.ts#formatRelativeDate");
      ix.store.db
        .prepare(
          "INSERT INTO descriptions(content_key, behavior, search_terms, name_fits, provenance) VALUES (?, 'b', '[]', 1, 'model')",
        )
        .run(key);
      syncBacklog(ix.store);
      await move(ix);
      expect(ix.store.getSymbol("sym:packages/utils/src/moved-date.ts#formatRelativeDate")).toBeDefined();
      const r = syncBacklog(ix.store);
      expect(r.enqueued).toBe(0);
      expect(backlog(ix.store).some((b) => b.content_key === key)).toBe(false);
    } finally {
      await ix.close();
    }
  });

  it("drops pending rows for code that no longer exists, keeps claimed rows", async () => {
    const ix = await indexedFixture();
    try {
      syncBacklog(ix.store);
      claimBatch(ix.store, "w", 1);
      ix.store.db
        .prepare(
          "INSERT INTO backlog(content_key, symbol_id, priority, status) VALUES ('gone:p1', 'sym:x#y', 1, 'pending')",
        )
        .run();
      syncBacklog(ix.store);
      const rows = backlog(ix.store);
      expect(rows.some((b) => b.content_key === "gone:p1")).toBe(false);
      expect(rows.filter((b) => b.status === "claimed")).toHaveLength(1);
    } finally {
      await ix.close();
    }
  });

  it("syncs only the given symbols and does not prune", async () => {
    const ix = await indexedFixture();
    try {
      syncBacklog(ix.store);
      const before = backlog(ix.store).length;
      const sym = fakeSymbol("packages/utils/src/new.ts", "newFn", { exactHash: "newhash" });
      const r = syncBacklog(ix.store, {
        symbols: [sym],
        sources: new Map([
          ["packages/utils/src/new.ts", "export function newFn(a) {\n  a++;\n  return a;\n}\n"],
        ]),
      });
      expect(r).toEqual({ enqueued: 1, templated: 0, alreadyDescribed: 0 });
      expect(backlog(ix.store)).toHaveLength(before + 1);
    } finally {
      await ix.close();
    }
  });

  it("never templates when the file no longer matches the indexed hash", async () => {
    const ix = await indexedFixture();
    try {
      const { writeFileSync: w } = await import("node:fs");
      // createPost changed on disk after indexing; the index still has the old hash.
      w(
        join(ix.fx.dir, "packages/db/src/queries.ts"),
        "export async function createPost() {\n  return 42;\n}\n",
      );
      const key = keyOf(ix.store, "sym:packages/db/src/queries.ts#createPost");
      syncBacklog(ix.store);
      expect(
        ix.store.db.prepare("SELECT 1 FROM descriptions WHERE content_key = ?").get(key),
      ).toBeUndefined();
      expect(backlog(ix.store).some((b) => b.content_key === key)).toBe(true);
    } finally {
      await ix.close();
    }
  });

  it("skips sensitive paths", () => {
    const store = openStore(":memory:");
    putFile(store, "config/secrets.ts", [fakeSymbol("config/secrets.ts", "getKey")]);
    expect(syncBacklog(store, { root: "/nonexistent" })).toEqual({
      enqueued: 0,
      templated: 0,
      alreadyDescribed: 0,
    });
    expect(backlog(store)).toHaveLength(0);
    store.close();
  });
});

describe("claimBatch and releaseExpiredClaims", () => {
  it("claims by priority then symbol id and returns fact sheets", async () => {
    const ix = await indexedFixture();
    try {
      syncBacklog(ix.store);
      const pending = backlog(ix.store);
      const a = claimBatch(ix.store, "worker-1", 3);
      expect(a.items.map((i) => i.id)).toEqual(pending.slice(0, 3).map((b) => b.symbol_id));
      expect(a.batchId).toMatch(/^[0-9a-f-]{36}$/);
      const claimed = backlog(ix.store).filter((b) => b.status === "claimed");
      expect(claimed).toHaveLength(3);
      for (const c of claimed) {
        expect(c.claimed_by).toBe(`worker-1:${a.batchId}`);
        expect(Number.isNaN(Date.parse(c.claimed_at as string))).toBe(false);
      }
      for (const item of a.items) {
        expect(item.body.length).toBeGreaterThan(0);
        expect(item.contentKey).toBe(keyOf(ix.store, item.id));
      }
      const b = claimBatch(ix.store, "worker-2", 1000);
      const seen = new Set(a.items.map((i) => i.contentKey));
      for (const item of b.items) expect(seen.has(item.contentKey)).toBe(false);
      expect(a.items.length + b.items.length).toBe(pending.length);
      expect(claimBatch(ix.store, "worker-3", 5).items).toEqual([]);
      expect(claimBatch(ix.store, "worker-3", 0).items).toEqual([]);
    } finally {
      await ix.close();
    }
  });

  it("drops rows whose symbol changed or vanished and keeps rows it cannot read", async () => {
    const ix = await indexedFixture();
    try {
      syncBacklog(ix.store);
      ix.store.db
        .prepare(
          "INSERT INTO backlog(content_key, symbol_id, priority, status) VALUES ('old:p1', 'sym:packages/utils/src/slug.ts#slugify', 0, 'pending')",
        )
        .run();
      ix.store.db
        .prepare(
          "INSERT INTO backlog(content_key, symbol_id, priority, status) VALUES ('none:p1', 'sym:no/where.ts#f', 0, 'pending')",
        )
        .run();
      const r = claimBatch(ix.store, "w", 1000);
      expect(r.items.some((i) => i.contentKey === "old:p1" || i.contentKey === "none:p1")).toBe(false);
      expect(backlog(ix.store).some((b) => b.content_key === "old:p1" || b.content_key === "none:p1")).toBe(
        false,
      );

      // A missing file leaves the row pending.
      syncBacklog(ix.store);
      rmSync(join(ix.fx.dir, "packages/utils/src/time.ts"));
      const key = keyOf(ix.store, "sym:packages/utils/src/time.ts#parseTimestamp");
      ix.store.db
        .prepare("UPDATE backlog SET status = 'pending', claimed_by = NULL WHERE content_key = ?")
        .run(key);
      const r2 = claimBatch(ix.store, "w", 1000);
      expect(r2.items.some((i) => i.contentKey === key)).toBe(false);
      expect(backlog(ix.store).find((b) => b.content_key === key)?.status).toBe("pending");
    } finally {
      await ix.close();
    }
  });

  it("drops rows on sensitive paths without building a sheet", () => {
    const store = openStore(":memory:");
    const s = fakeSymbol("config/secrets.ts", "getKey");
    putFile(store, "config/secrets.ts", [s]);
    store.db
      .prepare("INSERT INTO backlog(content_key, symbol_id, priority, status) VALUES (?, ?, 0, 'pending')")
      .run(contentKey(s.exactHash), s.id);
    const r = claimBatch(store, "w", 5, {
      sources: new Map([["config/secrets.ts", "export function getKey() {}"]]),
    });
    expect(r.items).toEqual([]);
    expect(backlog(store)).toHaveLength(0);
    store.close();
  });

  it("expires claims after 10 minutes", async () => {
    const ix = await indexedFixture();
    try {
      syncBacklog(ix.store);
      const total = backlog(ix.store).length;
      const a = claimBatch(ix.store, "w1", 4);
      expect(a.items).toHaveLength(4);
      expect(releaseExpiredClaims(ix.store)).toBe(0);
      expect(releaseExpiredClaims(ix.store, new Date(Date.now() + CLAIM_TTL_MS - 5_000))).toBe(0);
      expect(releaseExpiredClaims(ix.store, new Date(Date.now() + CLAIM_TTL_MS + 5_000))).toBe(4);
      expect(backlog(ix.store).filter((b) => b.status === "pending")).toHaveLength(total);
      for (const b of backlog(ix.store)) expect(b.claimed_by).toBeNull();

      // claimBatch itself reclaims expired claims.
      claimBatch(ix.store, "w1", 2);
      ix.store.db
        .prepare("UPDATE backlog SET claimed_at = ? WHERE status = 'claimed'")
        .run(new Date(Date.now() - CLAIM_TTL_MS - 1000).toISOString());
      const again = claimBatch(ix.store, "w2", 2);
      expect(again.items).toHaveLength(2);
    } finally {
      await ix.close();
    }
  });

  it("two concurrent workers never claim the same item", async () => {
    const many = Array.from(
      { length: 120 },
      (_, i) => `export function fn${i}(a: number) {\n  const b = a + ${i};\n  return b * 2;\n}\n`,
    ).join("\n");
    const ix = await indexedFixture("pnpm-turbo", { "packages/utils/src/many.ts": many });
    const out = mkdtempSync(join(tmpdir(), "gantry-claim-bundle-"));
    cleanups.push(() => rmSync(out, { recursive: true, force: true }));
    try {
      syncBacklog(ix.store);
      const pending = backlog(ix.store).length;
      expect(pending).toBeGreaterThan(120);
      ix.store.close();

      // Workers cannot load .ts, so bundle the core once.
      mkdirSync(out, { recursive: true });
      await build({
        entry: { core: join(here, "../index.ts") },
        outDir: out,
        format: ["esm"],
        platform: "node",
        target: "node22",
        silent: true,
        dts: false,
        config: false,
      });
      symlinkSync(join(here, "../../node_modules"), join(out, "node_modules"), "dir");
      const workerPath = join(out, "worker.mjs");
      writeFileSync(
        workerPath,
        `import { parentPort, workerData } from "node:worker_threads";
import { openStore, claimBatch } from "./core.js";
const s = openStore(workerData.db);
const keys = [];
const flag = new Int32Array(workerData.barrier);
Atomics.add(flag, 0, 1);
while (Atomics.load(flag, 0) < 2) { /* wait for the other worker */ }
for (;;) {
  const r = claimBatch(s, workerData.id, 2);
  if (r.items.length === 0) break;
  for (const i of r.items) keys.push(i.contentKey);
}
s.close();
parentPort.postMessage(keys);
`,
      );
      const { Worker } = await import("node:worker_threads");
      const barrier = new SharedArrayBuffer(4);
      const run = (id: string) =>
        new Promise<string[]>((resolve, reject) => {
          const w = new Worker(workerPath, { workerData: { db: ix.paths.dbPath, id, barrier } });
          w.on("message", (m: string[]) => resolve(m));
          w.on("error", reject);
        });
      const [a, b] = await Promise.all([run("a"), run("b")]);
      expect(new Set([...a, ...b]).size).toBe(a.length + b.length);
      expect(a.length + b.length).toBe(pending);
    } finally {
      await ix.fx.cleanup();
    }
  }, 120_000);
});

describe("estimate", () => {
  it("uses the measured tokens per function and batches of 40 in rounds of 4", () => {
    const store = openStore(":memory:");
    const syms = Array.from({ length: 170 }, (_, i) =>
      fakeSymbol("src/a.ts", `f${i}`, { exported: i < 100, exactHash: `h${i}` }),
    );
    putFile(store, "src/a.ts", syms);
    store.db
      .prepare(
        "INSERT INTO descriptions(content_key, behavior, search_terms, name_fits, provenance) VALUES ('h0:p1', 'x', '[]', 1, 'template')",
      )
      .run();
    store.db
      .prepare(
        "INSERT INTO descriptions(content_key, behavior, search_terms, name_fits, provenance) VALUES ('h1:p1', 'x', '[]', 1, 'model')",
      )
      .run();
    const e = estimate(store);
    expect(e).toEqual({
      functionLike: 170,
      templated: 1,
      toDescribe: 168,
      inputTokens: 950 * 168,
      outputTokens: 250 * 168,
      batches: Math.ceil(168 / BATCH_SIZE),
      rounds: Math.ceil(Math.ceil(168 / BATCH_SIZE) / 4),
    });
    expect(e.batches).toBe(5);
    expect(e.rounds).toBe(2);

    const first = estimate(store, { exportsFirst: true });
    expect(first.functionLike).toBe(100);
    expect(first.toDescribe).toBe(98);
    expect(first.templated).toBe(1);
    expect(first.inputTokens).toBe(950 * 98);
    store.close();
  });

  it("is all zeros for an empty store", () => {
    const store = openStore(":memory:");
    expect(estimate(store)).toEqual({
      functionLike: 0,
      templated: 0,
      toDescribe: 0,
      inputTokens: 0,
      outputTokens: 0,
      batches: 0,
      rounds: 0,
    });
    store.close();
  });
});
