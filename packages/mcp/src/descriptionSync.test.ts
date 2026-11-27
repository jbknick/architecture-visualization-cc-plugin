import { contentKey, resetTeamProtocolCache } from "@gantry/core";
import type { Description } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type Connected, call, connect, indexAndSync, makeRepo, type Repo, silentLog } from "./testkit.js";
import { UNTRUSTED_FIELD } from "./untrusted.js";

const USER_TOKEN = "tok-user-sync-mcp";
const MARKER = "pelican nests";
const SYNCED = `Turns a title into a url-safe string for ${MARKER}`;
const SLUGIFY = "sym:acme/repo:src/lib/slug.ts#slugify";

let repo: Repo | undefined;
let fake: FakeServer | undefined;
let conn: Connected | undefined;
afterEach(async () => {
  await conn?.close();
  conn = undefined;
  await fake?.close();
  fake = undefined;
  repo?.cleanup();
  repo = undefined;
  silentLog.errors.length = 0;
});

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done()).toBe(true);
}

/** An indexed repo with no descriptions and a team server that holds one for `slugify`. */
async function setup(delayMs = 0) {
  resetTeamProtocolCache();
  repo = makeRepo({}, { origin: "https://github.com/acme/repo.git" });
  await indexAndSync(repo);
  const key = repo.withStore((s) => contentKey(s.getSymbol(SLUGIFY)?.exactHash as string));
  fake = await startFakeServer({ tokens: [USER_TOKEN], repo: "acme/repo", lookupDelayMs: delayMs });
  const wire: Description = {
    content_key: key,
    behavior: SYNCED,
    search_terms: ["slug", "title"],
    name_fits: true,
    provenance: "model",
    model: "haiku",
    prompt_version: "p1",
    created_at: "2026-01-02T03:04:05.000Z",
  };
  fake.state.descriptions.set(key, wire);
  const env = {
    ...repo.env,
    GANTRY_SERVER: fake.url,
    GANTRY_ORG: "acme",
    GANTRY_TOKEN: USER_TOKEN,
    GANTRY_CREDENTIALS_FILE: `${repo.dir}/../no-credentials.json`,
  };
  return { key, env };
}
const stored = (key: string): boolean =>
  (repo as Repo).withStore(
    (s) => s.db.prepare("SELECT 1 FROM descriptions WHERE content_key = ?").get(key) !== undefined,
  );

describe("the start-up description sync", () => {
  it("fills the description the team has, and gantry_node returns it only as untrusted_description", async () => {
    const { key, env } = await setup();
    conn = await connect(repo as Repo, { env });
    await until(() => stored(key), 4000);
    const row = (repo as Repo).withStore(
      (s) =>
        s.db.prepare("SELECT * FROM descriptions WHERE content_key = ?").get(key) as Record<string, unknown>,
    );
    expect(row).toMatchObject({ behavior: SYNCED, model: "haiku", created_at: "2026-01-02T03:04:05.000Z" });

    const r = await call(conn.client, "gantry_node", { target: SLUGIFY });
    expect(r.isError).toBe(false);
    expect(r.json[UNTRUSTED_FIELD]).toBe(SYNCED);
    // The text appears only as the value of untrusted_description.
    const rest = { ...r.json, [UNTRUSTED_FIELD]: null };
    expect(JSON.stringify(rest)).not.toContain(MARKER);
    expect(r.text.split(MARKER)).toHaveLength(2);
    expect(silentLog.errors).toEqual([]);
  });

  it("with a server that delays 10 s, start-up completes within 6 s and the timeout is logged", async () => {
    const { key, env } = await setup(10_000);
    const began = Date.now();
    conn = await connect(repo as Repo, { env });
    const ready = await call(conn.client, "gantry_browse", { target: "." });
    expect(Date.now() - began).toBeLessThan(6000);
    expect(ready.isError).toBe(false);
    await until(() => silentLog.errors.some((m) => /description sync failed: .*timed out/.test(m)), 8000);
    expect(stored(key)).toBe(false);
    // The timeout went to the log and never into a tool result.
    expect(ready.text).not.toMatch(/timed out/);
  }, 20_000);

  it("does nothing without a team: no request and no log line", async () => {
    resetTeamProtocolCache();
    repo = makeRepo();
    await indexAndSync(repo);
    conn = await connect(repo, { env: repo.env });
    await call(conn.client, "gantry_browse", { target: "." });
    expect(silentLog.errors).toEqual([]);
  });
});
