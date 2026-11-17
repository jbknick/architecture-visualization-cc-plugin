import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { INDEX_FORMAT_VERSION, indexFormatStale, openStore } from "../store/index.js";
import { heal, healPending, upgradeIndexFormat } from "./index.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<{ dir: string; cleanup(): Promise<void> }>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function indexed(): Promise<GantryPaths> {
  const fx = await materializeFixture("adapters");
  const data = mkdtempSync(join(tmpdir(), "gantry-format-"));
  cleanups.push(
    () => fx.cleanup(),
    () => rmSync(data, { recursive: true, force: true }),
  );
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  return paths;
}

function read<T>(paths: GantryPaths, fn: (s: ReturnType<typeof openStore>) => T): T {
  const s = openStore(paths.dbPath);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

const dump = (paths: GantryPaths): string => read(paths, (s) => JSON.stringify(dumpGraph(s)));
const count = (paths: GantryPaths, sql: string): number =>
  read(paths, (s) => (s.db.prepare(sql).get() as { n: number }).n);
const meta = (paths: GantryPaths, key: string): string | undefined => read(paths, (s) => s.getMeta(key));

/**
 * What a build from before the adapter framework left behind (#195): no adapter nodes, no adapter edges, edge evidence
 * cut at 3 lines, and no `meta.index_format`. Written on the raw database, so `openStore`'s own check does not run.
 */
async function simulatePreAdapterStore(paths: GantryPaths): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(paths.dbPath);
  try {
    db.exec("DELETE FROM adapter_nodes");
    db.exec(
      "DELETE FROM edges WHERE kind IN ('requests', 'handles', 'reads', 'writes', 'serves', 'contains')",
    );
    const rows = db.prepare("SELECT rowid AS r, evidence FROM edges").all() as {
      r: number;
      evidence: string;
    }[];
    const cut = db.prepare("UPDATE edges SET evidence = ? WHERE rowid = ?");
    for (const row of rows) {
      const ev = JSON.parse(row.evidence ?? "[]") as string[];
      if (ev.length > 3) cut.run(JSON.stringify(ev.slice(0, 3)), row.r);
    }
    db.exec("DELETE FROM meta WHERE key = 'index_format'");
  } finally {
    db.close();
  }
}

const ADAPTER_NODES = "SELECT COUNT(*) AS n FROM adapter_nodes WHERE layer = 'main'";
const REQUESTS = "SELECT COUNT(*) AS n FROM edges WHERE layer = 'main' AND kind = 'requests'";

describe("index format version (#195)", () => {
  it("a full main index records the current format, and reopening it keeps head_sha (no needless re-index)", async () => {
    const paths = await indexed();
    expect(meta(paths, "index_format")).toBe(String(INDEX_FORMAT_VERSION));
    const head = meta(paths, "head_sha");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(read(paths, (s) => indexFormatStale(s.db))).toBe(false);
    // Opened again (as every entry point does): nothing is forgotten, so nothing is re-indexed.
    expect(meta(paths, "head_sha")).toBe(head);
    expect(read(paths, (s) => healPending(paths, s))).toBe(false);
    expect(await heal(paths)).toMatchObject({ changed: 0, full: false });
    expect(await upgradeIndexFormat(paths)).toBe(false);
    expect(meta(paths, "head_sha")).toBe(head);
  });

  it("a store from before the adapters is detected on open and fully re-indexed by the next heal", async () => {
    const paths = await indexed();
    const fresh = dump(paths);
    const nodes = count(paths, ADAPTER_NODES);
    const requests = count(paths, REQUESTS);
    expect(nodes).toBeGreaterThan(0);
    expect(requests).toBeGreaterThan(0);

    await simulatePreAdapterStore(paths);
    // The old store's files are unchanged on disk, so only the format can trigger this.
    expect(count(paths, ADAPTER_NODES)).toBe(0);
    expect(count(paths, REQUESTS)).toBe(0);
    // Opening it forgot head_sha (once), so a heal is due for every entry point that heals.
    expect(meta(paths, "head_sha")).toBeUndefined();
    expect(read(paths, (s) => indexFormatStale(s.db))).toBe(true);
    expect(read(paths, (s) => healPending(paths, s))).toBe(true);

    const r = await heal(paths);
    expect(r.full).toBe(true);
    expect(count(paths, ADAPTER_NODES)).toBe(nodes);
    expect(count(paths, REQUESTS)).toBe(requests);
    expect(dump(paths)).toBe(fresh); // same graph as a fresh index, evidence included
    expect(meta(paths, "index_format")).toBe(String(INDEX_FORMAT_VERSION));
    expect(meta(paths, "head_sha")).toMatch(/^[0-9a-f]{40}$/);
    expect(await heal(paths)).toMatchObject({ changed: 0, full: false });
  });

  it("upgradeIndexFormat re-indexes a stale store once and is a no-op afterwards", async () => {
    const paths = await indexed();
    const fresh = dump(paths);
    await simulatePreAdapterStore(paths);
    expect(await upgradeIndexFormat(paths)).toBe(true);
    expect(dump(paths)).toBe(fresh);
    expect(count(paths, REQUESTS)).toBeGreaterThan(0);
    expect(await upgradeIndexFormat(paths)).toBe(false);
  });

  it("a store written by a newer format is not stale", async () => {
    const paths = await indexed();
    read(paths, (s) => s.setMeta("index_format", String(INDEX_FORMAT_VERSION + 1)));
    expect(read(paths, (s) => indexFormatStale(s.db))).toBe(false);
    expect(meta(paths, "head_sha")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a store that was never fully indexed is not stale", () => {
    const data = mkdtempSync(join(tmpdir(), "gantry-format-empty-"));
    cleanups.push(() => rmSync(data, { recursive: true, force: true }));
    const s = openStore(join(data, "gantry.db"));
    try {
      expect(indexFormatStale(s.db)).toBe(false);
    } finally {
      s.close();
    }
  });
});
