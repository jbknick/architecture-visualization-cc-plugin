import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GantryPaths,
  heal,
  openTeamCache,
  readCacheSummary,
  readChangeSets,
  resetTeamProtocolCache,
  resolvePaths,
} from "@gantry/core";
import type { ChangeSet } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Connected, call, connect, silentLog } from "./testkit.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const REPO = "acme/pnpm-turbo";
const USER_TOKEN = "tok-user-9f3a";
const HOUR = 3_600_000;

function changeSet(n: number): ChangeSet {
  return {
    id: `cs:pr:${REPO}#${n}`,
    repo: REPO,
    source: "pr",
    state: "in_review",
    ref: `#${n}`,
    head_ref: `feat/change-${n}`,
    base_branch: "main",
    nodes: [`file:${REPO}:packages/ui/src/button.tsx`],
    radius: [{ id: `file:${REPO}:apps/web/src/main.tsx`, hop: 1, tier: "direct", via_hub: false }],
    estimated: false,
    owner: "octo-dev",
    title: `Change ${n}`,
    pr: n,
    head_sha: "7e3d9a1c5b8f20466d1ae9c3b7f45082d6c1e9ab",
    created_at: "2026-11-20T09:15:00.000Z",
    updated_at: `2026-11-20T09:4${n}:12.000Z`,
    links: [],
  };
}

let fx: MaterializedFixture;
let data: string;
let paths: GantryPaths;
let env: NodeJS.ProcessEnv;
let fake: FakeServer | undefined;
let conn: Connected | undefined;
let clock: number;
let pullRequests: string[];

/** A fetch that remembers the pull requests it makes. */
const counting: typeof fetch = async (input, init) => {
  if (String(input).includes("/v1/pull")) pullRequests.push(String(input));
  return fetch(input, init);
};

beforeEach(async () => {
  resetTeamProtocolCache();
  silentLog.errors.length = 0;
  pullRequests = [];
  clock = Date.now();
  fx = await materializeFixture("pnpm-turbo");
  fx.git(["remote", "add", "origin", `https://github.com/${REPO}.git`]);
  data = mkdtempSync(join(tmpdir(), "gantry-mcp-teampull-"));
  const base = { ...process.env, HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  paths = resolvePaths(fx.dir, base);
  await heal(paths);
  fake = await startFakeServer({ tokens: [USER_TOKEN], repo: REPO });
  for (const n of [1, 2]) fake.state.changeSets.set(changeSet(n).id, changeSet(n));
  env = { ...base, GANTRY_SERVER: fake.url, GANTRY_ORG: "acme", GANTRY_TOKEN: USER_TOKEN };
});
afterEach(async () => {
  await conn?.close();
  conn = undefined;
  await fake?.close();
  fake = undefined;
  await fx.cleanup();
  rmSync(data, { recursive: true, force: true });
});

const start = async (): Promise<Connected> => {
  conn = await connect({ dir: fx.dir, env, paths } as never, {
    env,
    teamPull: { fetch: counting, now: () => clock },
  });
  return conn;
};
const browse = (c: Connected) => call(c.client, "gantry_browse", { target: "." });
const summary = () => {
  const cache = openTeamCache(paths, { readonly: true });
  try {
    return readCacheSummary(cache);
  } finally {
    cache?.close();
  }
};
async function until(done: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done()).toBe(true);
}

describe("the MCP server's team pull", () => {
  it("pulls once at start: team-cache.db holds the two change sets", async () => {
    await start();
    await until(() => summary().change_sets === 2);
    const cache = openTeamCache(paths, { readonly: true });
    expect(readChangeSets(cache).map((c) => c.id)).toEqual([changeSet(2).id, changeSet(1).id]);
    cache?.close();
    expect(pullRequests).toHaveLength(1);
    expect(summary().last_error).toBeNull();
  });

  it("pulls again before a call only when the cache is older than 60 s: two calls 10 s apart make one request", async () => {
    const c = await start();
    await until(() => summary().change_sets === 2);
    expect(pullRequests).toHaveLength(1);

    clock += 10_000;
    expect((await browse(c)).isError).toBe(false);
    clock += 10_000;
    expect((await browse(c)).isError).toBe(false);
    expect(pullRequests).toHaveLength(1); // the cache is 20 s old

    clock += 50_000; // 70 s since the start-up pull
    await browse(c);
    expect(pullRequests).toHaveLength(2);
    expect(pullRequests[1]).toContain("/v1/pull");
    clock += 10_000;
    await browse(c);
    expect(pullRequests).toHaveLength(2); // 10 s after the second
  });

  it("sends If-None-Match on the later pull, which the fake answers with 304", async () => {
    const c = await start();
    await until(() => summary().change_sets === 2);
    const first = summary().pulled_at;
    clock += 2 * 60_000;
    await browse(c);
    expect(summary().change_sets).toBe(2);
    expect(summary().pulled_at).not.toBe(first);
  });

  it("is not delayed past 1,600 ms by a server that hangs for 5 s", async () => {
    await fake?.close();
    fake = await startFakeServer({ tokens: [USER_TOKEN], repo: REPO, pullDelayMs: 5000 });
    env = { ...env, GANTRY_SERVER: fake.url };
    const c = await start();

    const elapsed = async (): Promise<number> => {
      const started = Date.now();
      expect((await browse(c)).isError).toBe(false);
      return Date.now() - started;
    };
    const waited = await elapsed(); // joins the pull that started with the server, for at most 1,500 ms
    expect(waited).toBeGreaterThanOrEqual(1400);

    await new Promise((resolve) => setTimeout(resolve, 1700)); // the start-up pull gives up at 3 s
    clock += 10_000; // inside the 60 s rule: no pull, so this is what a call costs by itself
    const baseline = await elapsed();
    expect(waited).toBeLessThan(1600 + baseline);

    clock += HOUR; // the cache is stale: this call starts its own pull and waits at most 1,500 ms
    const again = await elapsed();
    expect(again).toBeGreaterThanOrEqual(1400);
    expect(again).toBeLessThan(1600 + baseline);
    expect(summary().change_sets).toBe(0);
  });

  it("keeps the numbers, sets last_error and never puts the error in a tool result when the server stops", async () => {
    const c = await start();
    await until(() => summary().change_sets === 2);
    const before = summary();
    await fake?.close();
    fake = undefined;

    clock += 2 * 60_000;
    const result = await browse(c);
    expect(result.isError).toBe(false);
    expect(result.text).not.toMatch(/team_unreachable|Cannot reach|last_error/);
    const after = summary();
    expect(after.change_sets).toBe(2);
    expect(after.pulled_at).toBe(before.pulled_at);
    expect(after.last_error).toContain("team_unreachable");
    expect(silentLog.errors.some((m) => m.startsWith("team pull failed"))).toBe(true);
  });

  it("does nothing when no server is configured", async () => {
    env = { ...env, GANTRY_SERVER: "", GANTRY_ORG: "", GANTRY_TOKEN: "" };
    const c = await start();
    await browse(c);
    expect(pullRequests).toHaveLength(0);
    expect(summary()).toEqual({ change_sets: 0, pulled_at: null, age_s: null, last_error: null });
  });
});
