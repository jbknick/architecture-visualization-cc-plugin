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
import { type TeamContext, teamSyncDescriptions } from "./team.js";

interface Fixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/upload-fixture.js";
const { materializeUploadFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeUploadFixture: (name: string, opts: { dirName: string; origin?: string }) => Promise<Fixture>;
};

const USER_TOKEN = "tok-user-sync-cli";
const CI_TOKEN = "gct_ci-sync-cli";

let fx: Fixture;
let data: string;
let paths: GantryPaths;
let keys: string[];
let fake: FakeServer;

beforeAll(async () => {
  fx = await materializeUploadFixture("pnpm-turbo", {
    dirName: "pnpm-turbo",
    origin: "https://github.com/fixture/pnpm-turbo.git",
  });
  data = mkdtempSync(join(tmpdir(), "gantry-sync-cli-"));
  mkdirSync(join(data, "home"), { recursive: true });
  paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
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
  rmSync(data, { recursive: true, force: true });
  await fx.cleanup();
});

beforeEach(async () => {
  resetTeamProtocolCache();
  fake = await startFakeServer({ tokens: [CI_TOKEN, USER_TOKEN] });
  const wire = (key: string): Description => ({
    content_key: key,
    behavior: "Converts text into a lowercase URL slug by trimming and replacing whitespace with dashes.",
    search_terms: ["slug", "url slug"],
    name_fits: true,
    provenance: "model",
    model: "haiku",
    prompt_version: "p1",
    created_at: "2026-01-02T03:04:05.000Z",
  });
  for (const key of keys.slice(0, 2)) fake.state.descriptions.set(key, wire(key));
});
afterEach(async () => {
  await fake.close();
  const store = openStore(paths.dbPath);
  try {
    store.db.prepare("DELETE FROM descriptions").run();
  } finally {
    store.close();
  }
});

async function run(env: Record<string, string>, json = false) {
  let out = "";
  let err = "";
  const ctx: TeamContext = {
    paths,
    env: { GANTRY_CREDENTIALS_FILE: join(data, "none.json"), ...env },
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
  };
  const code = await teamSyncDescriptions(ctx, json ? { json: true } : {});
  return { code, out, err };
}
const linked = (token = USER_TOKEN) => ({ GANTRY_SERVER: fake.url, GANTRY_ORG: "acme", GANTRY_TOKEN: token });

describe("gantry team sync-descriptions", () => {
  it("prints how many of the functions without a description it filled, then none the second time", async () => {
    const first = await run(linked());
    expect(first).toEqual({
      code: 0,
      out: `filled 2 of ${keys.length} functions without a description\n`,
      err: "",
    });
    const second = await run(linked());
    expect(second).toEqual({
      code: 0,
      out: `filled 0 of ${keys.length - 2} functions without a description\n`,
      err: "",
    });
  });

  it("--json prints the same two numbers", async () => {
    const r = await run(linked(), true);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ asked: keys.length, filled: 2 });
  });

  it("says not linked to a team and exits 1 when there is no server, organisation or token", async () => {
    expect(await run({})).toEqual({ code: 1, out: "", err: "not linked to a team\n" });
    expect((await run({ GANTRY_SERVER: fake.url, GANTRY_ORG: "acme" })).err).toBe("not linked to a team\n");
  });

  it("exits 1 with the sign-in message when the server answers 403 (a CI token)", async () => {
    const r = await run(linked(CI_TOKEN));
    expect(r).toEqual({
      code: 1,
      out: "",
      err: "Descriptions need a signed-in user. Run gantry team login.\n",
    });
    // A request the server itself answers 403 (here another organisation) gets the same message.
    const other = await run({ ...linked(), GANTRY_ORG: "other" });
    expect(other).toEqual({
      code: 1,
      out: "",
      err: "Descriptions need a signed-in user. Run gantry team login.\n",
    });
  });
});
