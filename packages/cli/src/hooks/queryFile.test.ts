import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo, openStore, resolvePaths } from "@gantry/core";
import { afterAll, describe, expect, it } from "vitest";
import { postToolUse, settleBatch } from "./postToolUse.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

const QUERY = "db/queries/posts.sql";

async function indexed() {
  const fx = await materializeFixture("go-recipes/sql");
  cleanups.push(() => fx.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-hook-query-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  return { fx, paths };
}

/** `kind function table evidence` of every read and write of a generated `Queries` method, sorted. */
function accesses(dbPath: string): string[] {
  const store = openStore(dbPath);
  try {
    const label = new Map(store.effectiveAdapterNodes().map((n) => [n.id, n.label]));
    return store
      .effectiveEdges()
      .filter((e) => (e.kind === "reads" || e.kind === "writes") && e.src.includes("#Queries."))
      .map(
        (e) =>
          `${e.kind} ${e.src.slice(e.src.indexOf("#Queries.") + 9)} ${label.get(e.dst)} ${e.evidence.join(",")}`,
      )
      .sort();
  } finally {
    store.close();
  }
}

const original = (): string[] => [
  "reads ListAuthorPosts posts db/queries/posts.sql:10",
  "reads ListAuthorPosts users db/queries/posts.sql:11",
  "reads ListPosts posts db/queries/posts.sql:2",
  "writes PublishPost posts db/queries/posts.sql:6",
];

describe("PostToolUse and Stop on a query file", () => {
  it("an edit of only the query file re-indexes the Go functions that run it", async () => {
    const { fx, paths } = await indexed();
    expect(accesses(paths.dbPath)).toEqual(original());
    // PublishPost now also reads `users`.
    const file = join(fx.dir, QUERY);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "UPDATE posts SET published = TRUE WHERE id = $1;",
        "UPDATE posts SET published = TRUE WHERE id IN (SELECT id FROM users);",
      ),
    );
    const out = await postToolUse(paths, { toolName: "Edit", filePath: file, sessionId: "s1" });
    expect(out).toBeUndefined();
    expect(accesses(paths.dbPath)).toEqual(
      [...original(), "reads PublishPost users db/queries/posts.sql:6"].sort(),
    );
    // Stop has nothing left to re-index and clears the batch.
    expect(await settleBatch(paths, { sessionId: "s1" })).toBeUndefined();
    const st = openStore(paths.dbPath);
    try {
      expect(st.db.prepare("SELECT count(*) AS n FROM pending_files").get()).toEqual({ n: 0 });
    } finally {
      st.close();
    }
  });

  it("deleting the query file after an edit removes the edges that came from it at Stop", async () => {
    const { fx, paths } = await indexed();
    const file = join(fx.dir, QUERY);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    await postToolUse(paths, { toolName: "Edit", filePath: file, sessionId: "s2" });
    expect(accesses(paths.dbPath).length).toBe(4);
    rmSync(file);
    expect(await settleBatch(paths, { sessionId: "s2" })).toBeUndefined();
    expect(accesses(paths.dbPath)).toEqual([]);
  });

  it("a trigger cut off before its index leaves the file for Stop, which re-indexes it", async () => {
    const { fx, paths } = await indexed();
    const file = join(fx.dir, QUERY);
    rmSync(file);
    const { recordEdit } = await import("./postToolUse.js");
    const st = openStore(paths.dbPath, { repo: paths.repo });
    try {
      recordEdit(st, "s3", QUERY, false, false);
    } finally {
      st.close();
    }
    expect(accesses(paths.dbPath)).toEqual(original());
    expect(await settleBatch(paths, { sessionId: "s3" })).toBeUndefined();
    expect(accesses(paths.dbPath)).toEqual([]);
  });
});
