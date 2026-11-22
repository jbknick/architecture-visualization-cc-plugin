import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import { trace } from "../trace.js";

const helperPath = "../../test/helpers/fixture.js";
interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Indexes `fixtures/go-recipes/sql` into a fresh data dir and hands the open store to `fn`. */
async function withIndex<T>(fn: (store: ReturnType<typeof openStore>) => T): Promise<T> {
  const fx = await materializeFixture("go-recipes/sql");
  cleanups.push(() => fx.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-query-file-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

describe("a read or write written in a query file", () => {
  it("is stored with the text file's id, and only for the edges a query rule makes", async () => {
    await withIndex((store) => {
      const rows = store
        .effectiveEdges()
        .filter((e) => e.kind === "reads" || e.kind === "writes")
        .map((e) => `${e.src.slice(e.src.indexOf("#") + 1)} ${e.textFileId ?? "-"}`)
        .sort();
      const queried = rows.filter((r) => r.startsWith("Queries."));
      expect(queried).toHaveLength(4);
      for (const r of queried) expect(r.endsWith(" file:sql:db/queries/posts.sql")).toBe(true);
      for (const r of rows.filter((x) => !x.startsWith("Queries."))) expect(r.endsWith(" -")).toBe(true);
    });
  });

  it("is shown by trace as the query file", async () => {
    await withIndex((store) => {
      const t = trace(store, "sym:sql:db/gen/posts.sql.go#Queries.ListAuthorPosts", { direction: "down" });
      expect(t?.edges.map((e) => `${e.kind} ${e.textFile}`).sort()).toEqual([
        "reads db/queries/posts.sql",
        "reads db/queries/posts.sql",
      ]);
    });
  });

  it("makes index --dump the same bytes from two fresh data dirs", async () => {
    const a = await withIndex((store) => JSON.stringify(dumpGraph(store)));
    const b = await withIndex((store) => JSON.stringify(dumpGraph(store)));
    expect(a).toContain('"textFileId"');
    expect(a).toBe(b);
  });
});
