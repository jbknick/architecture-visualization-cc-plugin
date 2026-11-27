import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheAgeSeconds,
  openTeamCache,
  pullTeamCache,
  readCacheSummary,
  readChangeSets,
  readChangeSetsTouching,
  readTeamGroups,
  readTeamViews,
} from "./cache.js";
import { changeSet, configFor, envFor, REPO, tempPaths, USER_TOKEN } from "./cacheTestkit.js";
import { resetTeamProtocolCache } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, "..", "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

const rel = (file: string): string => relative(packagesDir, file);
const all = sources(packagesDir);

/** The code a hook runs: the hook entry points and the commands that start them. */
const hookFiles = all.filter(
  (f) =>
    rel(f).startsWith(join("cli", "src", "hooks")) ||
    ["hook.ts", "hooks.ts"].includes(f.split("/").at(-1) ?? "") ||
    rel(f).startsWith(join("cli", "src", "commands", "hook")),
);

describe("no hook reaches the network through the team cache", () => {
  it("finds the hook sources", () => {
    expect(hookFiles.length).toBeGreaterThan(5);
    expect(hookFiles.map(rel)).toContain(join("cli", "src", "hooks", "sessionStart.ts"));
  });

  for (const file of hookFiles) {
    it(`${rel(file)} does not import pullTeamCache, the team client or the MCP server`, () => {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/\bpullTeamCache\b/);
      expect(text).not.toMatch(/team\/client/);
      expect(text).not.toMatch(/\bteamClient\b/);
      expect(text).not.toMatch(/@gantry\/mcp|mcp\/src/);
    });

    it(`${rel(file)} opens the team cache read-only, if at all`, () => {
      const text = readFileSync(file, "utf8");
      for (const call of text.matchAll(/openTeamCache\(([^)]*)\)/g)) {
        expect(call[1]).toMatch(/readonly:\s*true/);
      }
    });
  }

  it("only the cache itself, the MCP server and gantry team call pullTeamCache", () => {
    const callers = all
      .filter((f) => /\bpullTeamCache\b/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(callers).toEqual([
      join("cli", "src", "commands", "team.ts"),
      join("core", "src", "team", "cache.ts"),
      join("mcp", "src", "team-pull.ts"),
    ]);
  });

  it("only cache.ts (and the barrel) import the team client by path", () => {
    const importers = all
      .filter((f) => /from "\.\/client\.js"|team\/client/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(importers).toEqual([
      join("core", "src", "team", "cache.ts"),
      join("core", "src", "team", "index.ts"),
    ]);
  });
});

describe("the readers never call fetch", () => {
  let fake: FakeServer;
  let tmp: ReturnType<typeof tempPaths>;

  beforeEach(async () => {
    resetTeamProtocolCache();
    tmp = tempPaths();
    fake = await startFakeServer({ tokens: [USER_TOKEN], repo: REPO });
    fake.state.changeSets.set(changeSet(1).id, changeSet(1));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fake.close();
    tmp.cleanup();
  });

  it("opens, reads and closes the cache with fetch and the sockets stubbed out", async () => {
    await pullTeamCache(tmp.paths, configFor(fake.url), { env: envFor(tmp.dir) });
    const forbidden = vi.fn(() => {
      throw new Error("a reader reached the network");
    });
    vi.stubGlobal("fetch", forbidden);
    const cache = openTeamCache(tmp.paths, { readonly: true });
    expect(readChangeSets(cache)).toHaveLength(1);
    expect(readChangeSetsTouching(cache, `file:${REPO}:src/a1.ts`)).toHaveLength(1);
    expect(readTeamGroups(cache)).toEqual([]);
    expect(readTeamViews(cache)).toEqual([]);
    expect(cacheAgeSeconds(cache)).toBeTypeOf("number");
    expect(readCacheSummary(cache).change_sets).toBe(1);
    cache?.close();
    expect(forbidden).not.toHaveBeenCalled();
  });
});
