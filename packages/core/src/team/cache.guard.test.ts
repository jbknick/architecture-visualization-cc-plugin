import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      join("cli", "src", "commands", "team-publish.ts"),
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

/** The names a hook may take from `cache.ts`: the readers and their types. */
const READERS = new Set([
  "openTeamCache",
  "readChangeSets",
  "readChangeSetsTouching",
  "readTeamGroups",
  "readTeamViews",
  "readTeamSetting",
  "readTeamRepo",
  "cacheAgeSeconds",
  "readCacheSummary",
  "teamCachePath",
  "TEAM_CACHE_VERSION",
  "TeamCache",
  "TeamChangeSet",
  "TouchingChangeSet",
  "TeamCacheSummary",
]);

/** The four calls that reach a server from `views.ts`; no hook may import them (spec section 14). */
const WRITERS = new Set(["publishView", "publishGroup", "unpublishView", "unpublishGroup"]);

const strip = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (file: string): string => strip(readFileSync(file, "utf8"));
const CLIENT = join(packagesDir, "core", "src", "team", "client.ts");
const CACHE = join(packagesDir, "core", "src", "team", "cache.ts");
/** The two files only `gantry upload` may reach: the settings resolver and the command that sends. */
const RESOLVE = join(packagesDir, "core", "src", "team", "resolve.ts");
const UPLOAD = join(packagesDir, "cli", "src", "commands", "upload.ts");
const SENDERS = new Set([RESOLVE, UPLOAD]);
const SENDER_NAMES = /\b(teamClient|pullTeamCache|resolveTeamTarget|runUpload|registerUpload)\b/;

/** `./x.js` or a workspace package to a source file; undefined for anything outside this repo's sources. */
function resolveSpec(from: string, spec: string): string | undefined {
  if (spec.startsWith(".")) {
    const target = join(dirname(from), spec.replace(/\.js$/, ""));
    for (const candidate of [`${target}.ts`, join(target, "index.ts")])
      if (existsSync(candidate)) return candidate;
    return undefined;
  }
  const m = /^@gantry\/(core|cli|mcp|explorer)$/.exec(spec);
  return m ? join(packagesDir, m[1] as string, "src", "index.ts") : undefined;
}

interface Edge {
  spec: string;
  /** Imported names; undefined for a namespace, side-effect or dynamic import. */
  names: string[] | undefined;
}

/** Static imports, dynamic imports and re-exports of one file. */
function edgesOf(text: string): Edge[] {
  const out: Edge[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\s+(type\s+)?(\{[^}]*\}|[\w$*][\w$\s*,{}]*?)\s+from\s+["']([^"']+)["']/g,
  )) {
    const clause = m[2] as string;
    const braces = /\{([^}]*)\}/.exec(clause);
    const names = braces
      ? (braces[1] as string)
          .split(",")
          .map((n) => (n.trim().split(/\s+as\s+/)[0] ?? "").replace(/^type\s+/, "").trim())
          .filter((n) => n !== "")
      : undefined;
    out.push({ spec: m[3] as string, names: clause.includes("*") ? undefined : names });
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g))
    out.push({ spec: m[1] as string, names: undefined });
  for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm))
    out.push({ spec: m[1] as string, names: undefined });
  return out;
}

function defines(text: string, name: string): boolean {
  return new RegExp(
    `export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${name}\\b`,
  ).test(text);
}

/** The file that defines `name` as exported by `file`, following `export * from` and `export { name } from`. */
function definer(file: string, name: string, seen = new Set<string>()): string | undefined {
  if (seen.has(file)) return undefined;
  seen.add(file);
  const text = read(file);
  if (defines(text, name)) return file;
  for (const edge of edgesOf(text)) {
    if (!/\bexport\b/.test(text) || edge.names?.includes(name) === false) continue;
    const target = resolveSpec(file, edge.spec);
    const found = target === undefined ? undefined : definer(target, name, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Walks the import graph from the hook sources (static and dynamic imports, following barrels name by name) and
 * returns every way it reaches the team client or the pull: a name defined in `client.ts`, a name of `cache.ts` that
 * is not a reader, or a namespace import of either file.
 */
function violations(roots: string[]): string[] {
  const bad: string[] = [];
  const visited = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = read(file);
    if (file !== CLIENT && file !== CACHE && !SENDERS.has(file) && SENDER_NAMES.test(text)) {
      bad.push(`${rel(file)} uses the team client or the pull`);
    }
    for (const edge of edgesOf(text)) {
      const target = resolveSpec(file, edge.spec);
      if (target === undefined) continue;
      if (edge.names === undefined) {
        if (target === CLIENT || target === CACHE || SENDERS.has(target))
          bad.push(`${rel(file)} imports all of ${rel(target)}`);
        if (!SENDERS.has(target)) queue.push(target);
        continue;
      }
      for (const name of edge.names) {
        if (WRITERS.has(name)) bad.push(`${rel(file)} imports ${name}, which calls the team server`);
        const where = definer(target, name) ?? target;
        if (where === CLIENT) bad.push(`${rel(file)} imports ${name} from the team client`);
        else if (SENDERS.has(where))
          bad.push(`${rel(file)} imports ${name} from ${rel(where)}, the upload command's`);
        else if (where === CACHE && !READERS.has(name))
          bad.push(`${rel(file)} imports ${name} from cache.ts, which is not a reader`);
        else if (where !== CACHE) queue.push(where);
      }
    }
  }
  return bad;
}

describe("the hooks' import graph", () => {
  it("reaches neither teamClient nor pullTeamCache, through barrels and helpers", () => {
    expect(violations(hookFiles)).toEqual([]);
  });

  it("finds a helper that wraps the client and a hook that calls it (the walker works)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-guard-"));
    try {
      const helper = join(dir, "helper.ts");
      writeFileSync(
        helper,
        `import { teamClient } from "@gantry/core";\nexport const viaHelper = () => teamClient;\n`,
      );
      const hook = join(dir, "hook.ts");
      writeFileSync(hook, `import { viaHelper } from "./helper.js";\nviaHelper();\n`);
      expect(violations([hook])).toEqual([
        `${rel(helper)} uses the team client or the pull`,
        `${rel(helper)} imports teamClient from the team client`,
      ]);
      const direct = join(dir, "direct.ts");
      writeFileSync(direct, `import { pullTeamCache, readChangeSets } from "@gantry/core";\n`);
      expect(violations([direct])).toEqual([
        `${rel(direct)} uses the team client or the pull`,
        `${rel(direct)} imports pullTeamCache from cache.ts, which is not a reader`,
      ]);
      const writer = join(dir, "writer.ts");
      writeFileSync(writer, `import { publishView } from "@gantry/core";\n`);
      expect(violations([writer])).toEqual([
        `${rel(writer)} imports publishView, which calls the team server`,
      ]);
      const ok = join(dir, "ok.ts");
      writeFileSync(ok, `import { openTeamCache, readChangeSets } from "@gantry/core";\n`);
      expect(violations([ok])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the end-of-turn note reads team boundaries through the readers and mergedGroups only", () => {
    const file = hookFiles.find((f) => rel(f) === join("cli", "src", "hooks", "postToolUse.ts")) as string;
    const names = edgesOf(read(file))
      .filter((e) => e.spec === "@gantry/core")
      .flatMap((e) => e.names ?? []);
    expect(names).toEqual(expect.arrayContaining(["openTeamCache", "readTeamRepo", "mergedGroups"]));
    for (const name of names) expect(WRITERS.has(name)).toBe(false);
    expect(violations([file])).toEqual([]);
  });

  it("only the allow-listed files mention teamClient", () => {
    const callers = all
      .filter((f) => /\bteamClient\b/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(callers).toEqual([
      join("cli", "src", "commands", "team-publish.ts"),
      join("cli", "src", "commands", "team.ts"),
      join("cli", "src", "commands", "upload.ts"),
      join("core", "src", "team", "cache.ts"),
      join("core", "src", "team", "client.ts"),
    ]);
  });

  it("only resolve.ts and gantry upload mention resolveTeamTarget, and only main.ts registers the command", () => {
    const mentions = (name: RegExp): string[] =>
      all
        .filter((f) => name.test(readFileSync(f, "utf8")))
        .map(rel)
        .sort();
    expect(mentions(/\bresolveTeamTarget\b/)).toEqual([
      join("cli", "src", "commands", "upload.ts"),
      join("core", "src", "team", "resolve.ts"),
    ]);
    expect(mentions(/\bregisterUpload\b/)).toEqual([
      join("cli", "src", "commands", "upload.ts"),
      join("cli", "src", "main.ts"),
    ]);
    expect(mentions(/commands\/upload\.js/)).toEqual([join("cli", "src", "main.ts")]);
  });

  it("reaches neither resolveTeamTarget nor the upload command from a hook, however it is imported", () => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-guard-"));
    try {
      const viaName = join(dir, "name.ts");
      writeFileSync(viaName, `import { resolveTeamTarget } from "@gantry/core";\nresolveTeamTarget;\n`);
      expect(violations([viaName])).toEqual([
        `${rel(viaName)} uses the team client or the pull`,
        `${rel(viaName)} imports resolveTeamTarget from ${rel(RESOLVE)}, the upload command's`,
      ]);
      const viaPath = join(dir, "path.ts");
      writeFileSync(
        viaPath,
        `import * as upload from "${relative(dir, UPLOAD).replace(/\.ts$/, ".js")}";\nupload;\n`,
      );
      expect(violations([viaPath])).toEqual([`${rel(viaPath)} imports all of ${rel(UPLOAD)}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
