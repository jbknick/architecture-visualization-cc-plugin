import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GantryPaths, openStore, resolvePaths, type Store } from "@gantry/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExplorerAlreadyRunning,
  ExplorerUnresponsive,
  findRunningExplorer,
  startExplorerServer,
  startOrReuseExplorer,
  stateFilePath,
} from "./index.js";
import { lockFilePath } from "./state.js";

let tmp: string;
let paths: GantryPaths;
let store: Store;
const open: { close(): Promise<void> }[] = [];
const sinks: Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gantry-state-"));
  const repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", repo]);
  paths = resolvePaths(repo, { HOME: join(tmp, "home"), CLAUDE_PLUGIN_DATA: join(tmp, "data") });
  mkdirSync(paths.dataDir, { recursive: true });
  store = openStore(paths.dbPath);
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  for (const s of sinks.splice(0)) s.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const start = () => startOrReuseExplorer({ paths, store });
const old = (file: string) => utimesSync(file, new Date(0), new Date(0));

/** A port that accepts connections and never answers. */
function silentPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(() => {});
    sinks.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

describe("concurrent starts", () => {
  it("six parallel starts leave exactly one server and everyone gets its address", async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, start));
    for (const r of runs) if (r.server) open.push(r.server);
    const winners = runs.filter((r) => !r.reused);
    expect(winners).toHaveLength(1);
    const state = JSON.parse(readFileSync(stateFilePath(paths), "utf8"));
    expect(state.token).toBe(winners[0]?.token);
    for (const r of runs) {
      expect(r.port).toBe(winners[0]?.port);
      expect(r.token).toBe(winners[0]?.token);
    }
    expect(existsSync(lockFilePath(paths))).toBe(false);
  });

  it("a live process that does not answer is never replaced: every start fails naming its pid", async () => {
    const port = await silentPort();
    const body = JSON.stringify({ port, token: "x", pid: process.pid, startedAt: "" });
    writeFileSync(stateFilePath(paths), body);
    const results = await Promise.allSettled(Array.from({ length: 5 }, start));
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ExplorerUnresponsive);
      expect(String((r as PromiseRejectedResult).reason.message)).toContain(String(process.pid));
    }
    expect(readFileSync(stateFilePath(paths), "utf8")).toBe(body);
    expect(existsSync(lockFilePath(paths))).toBe(false);
  }, 20000);

  it("a losing start throws an error that holds no token", async () => {
    const first = await startExplorerServer({ paths, store });
    open.push(first);
    const err = await startExplorerServer({ paths, store }).catch((e) => e);
    expect(err).toBeInstanceOf(ExplorerAlreadyRunning);
    expect(err.port).toBe(first.port);
    expect(JSON.stringify(err)).not.toContain(first.token);
    expect(Object.values(err).join(" ")).not.toContain(first.token);
  });

  it("takes over a lock whose owner is dead", async () => {
    writeFileSync(lockFilePath(paths), "999999999");
    const r = await start();
    if (r.server) open.push(r.server);
    expect(r.reused).toBe(false);
    expect(existsSync(lockFilePath(paths))).toBe(false);
  });
});

describe("unusable explorer.json", () => {
  it("replaces an unparseable file", async () => {
    writeFileSync(stateFilePath(paths), "{not json");
    old(stateFilePath(paths));
    const r = await start();
    if (r.server) open.push(r.server);
    expect(r.reused).toBe(false);
    expect(JSON.parse(readFileSync(stateFilePath(paths), "utf8")).token).toBe(r.token);
  });

  it("replaces a dangling symlink without following it", async () => {
    const target = join(tmp, "elsewhere.json");
    symlinkSync(target, stateFilePath(paths));
    const r = await start();
    if (r.server) open.push(r.server);
    expect(r.reused).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(JSON.parse(readFileSync(stateFilePath(paths), "utf8")).token).toBe(r.token);
  });

  it("does not follow a symlink planted at the temp path", async () => {
    const target = join(tmp, "victim.txt");
    writeFileSync(target, "keep");
    symlinkSync(target, `${stateFilePath(paths)}.${process.pid}.tmp`);
    const r = await start();
    if (r.server) open.push(r.server);
    expect(readFileSync(target, "utf8")).toBe("keep");
    await expect(findRunningExplorer(paths)).resolves.toMatchObject({ token: r.token });
  });
});
