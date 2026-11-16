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
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GantryPaths, openStore, resolvePaths, type Store } from "@gantry/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExplorerAlreadyRunning,
  ExplorerUnresponsive,
  ensureExplorer,
  findRunningExplorer,
  startExplorerServer,
  startOrReuseExplorer,
  stateFilePath,
} from "./index.js";
import { acquireLock, LOCK_STALE_MS, lockFilePath } from "./state.js";

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

describe("reused pids", () => {
  it("a live pid whose port refuses connections is treated as gone", async () => {
    const port = await silentPort();
    sinks.pop()?.close(); // now nothing listens there
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(
      stateFilePath(paths),
      JSON.stringify({ port, token: "x", pid: process.pid, startedAt: "" }),
    );
    const r = await start();
    if (r.server) open.push(r.server);
    expect(r.reused).toBe(false);
    expect(JSON.parse(readFileSync(stateFilePath(paths), "utf8")).token).toBe(r.token);
  });

  it("a live pid whose port is another server answering 403 is treated as gone", async () => {
    const other = createHttpServer((_req, res) => {
      res.statusCode = 403;
      res.end("{}");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    sinks.push(other as unknown as Server);
    const port = (other.address() as { port: number }).port;
    writeFileSync(
      stateFilePath(paths),
      JSON.stringify({ port, token: "x", pid: process.pid, startedAt: "" }),
    );
    const r = await start();
    if (r.server) open.push(r.server);
    expect(r.reused).toBe(false);
  });

  it("a lock older than 10 s is abandoned even when its pid is alive", async () => {
    writeFileSync(lockFilePath(paths), String(process.pid));
    const old = new Date(Date.now() - 11_000);
    utimesSync(lockFilePath(paths), old, old);
    const r = await start();
    if (r.server) open.push(r.server);
    expect(r.reused).toBe(false);
    expect(existsSync(lockFilePath(paths))).toBe(false);
  });
});

describe("hard bound and lock wait (#123)", () => {
  it("ensureExplorer returns within its timeout when the explorer accepts connections but never answers", async () => {
    const port = await silentPort();
    writeFileSync(
      stateFilePath(paths),
      JSON.stringify({ port, token: "x", pid: process.pid, startedAt: "" }),
    );
    const t0 = Date.now();
    const r = await ensureExplorer({ paths, cli: undefined, env: {}, timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(1500); // the probe alone would take 2 s
    expect(r.ok).toBe(false);
    expect(existsSync(stateFilePath(paths))).toBe(true); // nothing deleted
  });

  it("waits out a lock that is about to turn stale instead of failing early", async () => {
    writeFileSync(lockFilePath(paths), String(process.pid));
    const aged = new Date(Date.now() - (LOCK_STALE_MS - 600));
    utimesSync(lockFilePath(paths), aged, aged);
    const release = await acquireLock(paths); // default wait must exceed the staleness age
    release();
    expect(existsSync(lockFilePath(paths))).toBe(false);
  });

  it("names the lock's age when it gives up", async () => {
    writeFileSync(lockFilePath(paths), String(process.pid));
    await expect(acquireLock(paths, 50)).rejects.toThrow(/held the explorer start lock for \d+ s/);
  });
});

describe("idle timeout (#123)", () => {
  it("closes an idle explorer, removes explorer.json and calls onIdle", async () => {
    let idle = 0;
    const s = await startExplorerServer({
      paths,
      store,
      idleTimeoutMs: 150,
      onIdle: () => {
        idle++;
      },
    });
    open.push(s);
    expect(existsSync(stateFilePath(paths))).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(idle).toBe(1);
    expect(existsSync(stateFilePath(paths))).toBe(false);
  });

  it("stays up while requests keep arriving", async () => {
    let idle = 0;
    const s = await startExplorerServer({ paths, store, idleTimeoutMs: 300, onIdle: () => void idle++ });
    open.push(s);
    for (let i = 0; i < 10; i++) {
      await fetch(`http://127.0.0.1:${s.port}/api/meta`, { headers: { "x-gantry-token": s.token } });
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(idle).toBe(0);
    expect(existsSync(stateFilePath(paths))).toBe(true);
  });
});
