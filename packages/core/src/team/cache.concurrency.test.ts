import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GantryPaths } from "../paths/index.js";
import { openTeamCache, pullTeamCache, readChangeSets } from "./cache.js";
import { changeSet, configFor, envFor, REPO, tempPaths, USER_TOKEN } from "./cacheTestkit.js";
import { resetTeamProtocolCache } from "./client.js";

let fake: FakeServer;
let tmp: ReturnType<typeof tempPaths>;
let paths: GantryPaths;

beforeEach(async () => {
  resetTeamProtocolCache();
  tmp = tempPaths();
  paths = tmp.paths;
  fake = await startFakeServer({ tokens: [USER_TOKEN], repo: REPO });
});
afterEach(async () => {
  await fake.close();
  tmp.cleanup();
});

const pull = () => pullTeamCache(paths, configFor(fake.url), { env: envFor(tmp.dir) });

/** The change sets and the node and reach rows of one snapshot; they must belong to the same pull. */
function snapshot(db: NonNullable<ReturnType<typeof openTeamCache>>["db"]) {
  const count = (table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    titles: (db.prepare("SELECT title FROM change_sets ORDER BY id").all() as { title: string }[]).map(
      (r) => r.title,
    ),
    nodes: count("change_set_nodes"),
    reach: count("change_set_reach"),
  };
}

describe("a reader during a pull (WAL)", () => {
  it("sees the old data inside its read transaction, then the new data, never a mix", async () => {
    for (const n of [1, 2]) fake.state.changeSets.set(changeSet(n).id, changeSet(n));
    await pull();

    const reader = openTeamCache(paths, { readonly: true });
    if (reader === undefined) throw new Error("no cache");
    reader.db.exec("BEGIN");
    const before = snapshot(reader.db);
    expect(before).toEqual({ titles: ["Change 1", "Change 2"], nodes: 4, reach: 4 });

    // the server's state changes: one change set is retitled and a third appears
    fake.state.changeSets.set(
      changeSet(1).id,
      changeSet(1, { title: "Retitled", updated_at: "2026-11-22T10:00:00.000Z" }),
    );
    fake.state.changeSets.set(changeSet(3).id, changeSet(3));
    expect((await pull()).status).toBe("updated");

    // still inside the transaction that began before the pull: all three tables are old
    expect(snapshot(reader.db)).toEqual(before);
    reader.db.exec("COMMIT");

    // a new read sees all three tables new
    expect(snapshot(reader.db)).toEqual({ titles: ["Retitled", "Change 2", "Change 3"], nodes: 6, reach: 6 });
    expect(readChangeSets(reader).map((c) => c.title)).toEqual(["Retitled", "Change 3", "Change 2"]);
    reader.close();
  });

  it("is not blocked by a reader that has not finished", async () => {
    fake.state.changeSets.set(changeSet(1).id, changeSet(1));
    await pull();
    const reader = openTeamCache(paths, { readonly: true });
    reader?.db.exec("BEGIN");
    reader?.db.prepare("SELECT count(*) FROM change_sets").get();
    fake.state.changeSets.clear();
    const started = Date.now();
    expect(await pull()).toMatchObject({ status: "updated", change_sets: 0 });
    expect(Date.now() - started).toBeLessThan(2000);
    reader?.db.exec("COMMIT");
    reader?.close();
  });
});
