import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentKey,
  FUNCTION_LIKE_KINDS,
  type GantryPaths,
  indexRepo,
  openStore,
  resetTeamProtocolCache,
  resolvePaths,
} from "@gantry/core";
import type { Description } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initRepo } from "./init.js";

interface Fixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/upload-fixture.js";
const { materializeUploadFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeUploadFixture: (name: string, opts: { dirName: string; origin?: string }) => Promise<Fixture>;
};

const USER_TOKEN = "tok-user-init-sync";

let fx: Fixture;
let base: string;
let keys: string[];
let fake: FakeServer;
let runs = 0;

const pathsFor = (name: string): GantryPaths => {
  const data = join(base, name);
  mkdirSync(join(data, "home"), { recursive: true });
  return resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
};

beforeAll(async () => {
  fx = await materializeUploadFixture("pnpm-turbo", {
    dirName: "pnpm-turbo",
    origin: "https://github.com/fixture/pnpm-turbo.git",
  });
  base = mkdtempSync(join(tmpdir(), "gantry-init-sync-"));
  const probe = pathsFor("probe");
  await indexRepo(probe, { layer: "main" });
  const store = openStore(probe.dbPath);
  try {
    keys = [
      ...new Set(
        store
          .effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] })
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .filter((s) => s.exactHash !== "")
          .map((s) => contentKey(s.exactHash)),
      ),
    ];
  } finally {
    store.close();
  }
}, 60_000);
afterAll(async () => {
  rmSync(base, { recursive: true, force: true });
  await fx.cleanup();
});

beforeEach(async () => {
  resetTeamProtocolCache();
  fake = await startFakeServer({ tokens: [USER_TOKEN] });
});
afterEach(async () => {
  await fake.close();
});

const wire = (key: string): Description => ({
  content_key: key,
  behavior: "Turns a title into a url-safe string.",
  search_terms: ["slug", "title"],
  name_fits: true,
  provenance: "model",
  model: "haiku",
  prompt_version: "p1",
  created_at: "2026-01-02T03:04:05.000Z",
});

const env = (server: string): NodeJS.ProcessEnv => ({
  GANTRY_SERVER: server,
  GANTRY_ORG: "acme",
  GANTRY_TOKEN: USER_TOKEN,
  GANTRY_CREDENTIALS_FILE: join(base, "none.json"),
});

function rows(paths: GantryPaths, sql: string): string[] {
  const store = openStore(paths.dbPath);
  try {
    return (store.db.prepare(sql).all() as { content_key: string }[]).map((r) => r.content_key);
  } finally {
    store.close();
  }
}

describe("gantry init and the team's descriptions", () => {
  it("stores what the team has before the backlog is built, so those keys are not in it", async () => {
    const synced = keys.slice(0, 2);
    for (const k of synced) fake.state.descriptions.set(k, wire(k));
    const paths = pathsFor(`init-${runs++}`);
    await initRepo(paths, {}, env(fake.url));
    expect(rows(paths, "SELECT content_key FROM descriptions WHERE provenance = 'model'").sort()).toEqual(
      [...synced].sort(),
    );
    const backlog = rows(paths, "SELECT content_key FROM backlog");
    for (const k of synced) expect(backlog).not.toContain(k);
    expect(backlog.length).toBeGreaterThan(0);
  }, 60_000);

  it("carries on with the full backlog when the server is not there", async () => {
    const url = fake.url;
    await fake.close();
    fake = await startFakeServer({ tokens: [USER_TOKEN] });
    const paths = pathsFor(`init-${runs++}`);
    await initRepo(paths, {}, env(url));
    expect(rows(paths, "SELECT content_key FROM descriptions WHERE provenance = 'model'")).toEqual([]);
    expect(rows(paths, "SELECT content_key FROM backlog").length).toBeGreaterThan(0);
  }, 60_000);

  it("changes nothing without a team", async () => {
    const paths = pathsFor(`init-${runs++}`);
    await initRepo(paths, {}, {});
    expect(rows(paths, "SELECT content_key FROM descriptions WHERE provenance = 'model'")).toEqual([]);
  }, 60_000);
});
