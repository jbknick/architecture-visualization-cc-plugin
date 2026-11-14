import { closeSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GantryPaths } from "@gantry/core";

// `<dataDir>/explorer.json` says which explorer serves this worktree. Starting one is serialized by
// `<dataDir>/explorer.lock` (created exclusively, holding the pid of the starter), so two starters can never both
// decide that no explorer runs. A file is deleted only when its owner is provably gone or the file is unreadable,
// never because a probe timed out while the owner is alive.

export interface ExplorerState {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export const stateFilePath = (p: GantryPaths): string => path.join(p.dataDir, "explorer.json");
export const lockFilePath = (p: GantryPaths): string => path.join(p.dataDir, "explorer.lock");

/** Another explorer for this worktree won the race to create `explorer.json` and is answering. Holds no token. */
export class ExplorerAlreadyRunning extends Error {
  constructor(
    readonly port: number,
    readonly pid: number,
  ) {
    super(`An explorer is already running for this worktree (pid ${pid}, port ${port})`);
    this.name = "ExplorerAlreadyRunning";
  }
}

/** `explorer.json` names a live process that does not answer. Nothing is deleted; the caller decides. */
export class ExplorerUnresponsive extends Error {
  constructor(readonly pid: number) {
    super(`The explorer (pid ${pid}) is running but does not answer; stop that process and try again`);
    this.name = "ExplorerUnresponsive";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** An unreadable file younger than this may be a writer in the middle of its work, so it is left alone. */
const YOUNG_MS = 1500;
const LOCK_STALE_MS = 10_000;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Identity of a file at one moment: inode, mtime and size, so a reused inode number alone does not match. */
const idOf = (st: { ino: number; mtimeMs: number; size: number }): string =>
  `${st.ino}:${st.mtimeMs}:${st.size}`;

/** Removes `file` (never following a symlink) only if it is still the same file as `id` (from `idOf`). */
function unlinkIfSame(file: string, id: string): void {
  try {
    if (idOf(lstatSync(file)) === id) unlinkSync(file);
  } catch {
    // already gone
  }
}

type Read =
  | { kind: "none" }
  | { kind: "young" }
  | { kind: "stale"; ino: string }
  | { kind: "state"; state: ExplorerState; ino: string };

function readState(file: string): Read {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return { kind: "none" };
  }
  // A symlink (dangling or not) or a non-file is never followed or trusted.
  if (!st.isFile()) return { kind: "stale", ino: idOf(st) };
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as ExplorerState;
    const valid =
      state &&
      Number.isInteger(state.port) &&
      typeof state.token === "string" &&
      Number.isInteger(state.pid) &&
      state.pid > 0;
    if (valid) return { kind: "state", state, ino: idOf(st) };
  } catch {
    // unparseable
  }
  return Date.now() - st.mtimeMs < YOUNG_MS ? { kind: "young" } : { kind: "stale", ino: idOf(st) };
}

/**
 * Reads `explorer.json` and verifies the server really answers with that token. Removes the file when it is
 * unreadable or names a dead process. Throws `ExplorerUnresponsive` (and removes nothing) when the process is alive
 * but does not answer.
 */
export async function findRunningExplorer(paths: GantryPaths): Promise<ExplorerState | undefined> {
  const found = await inspectExplorer(paths);
  return found.kind === "state" ? found.state : undefined;
}

/** Like `findRunningExplorer`, but reports a young unreadable file instead of ignoring it. */
export async function inspectExplorer(
  paths: GantryPaths,
): Promise<{ kind: "none" } | { kind: "young" } | { kind: "state"; state: ExplorerState }> {
  const file = stateFilePath(paths);
  const r = readState(file);
  if (r.kind === "none" || r.kind === "young") return r;
  if (r.kind === "stale") {
    unlinkIfSame(file, r.ino);
    return { kind: "none" };
  }
  const { state } = r;
  if (!processAlive(state.pid)) {
    unlinkIfSame(file, r.ino);
    return { kind: "none" };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/meta`, {
      headers: { "x-gantry-token": state.token },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return { kind: "state", state };
    // 403: some other server owns that port (the token is not ours), so explorer.json is stale.
    if (res.status === 403) {
      unlinkIfSame(file, r.ino);
      return { kind: "none" };
    }
  } catch (err) {
    // ECONNREFUSED proves the explorer is gone (it writes explorer.json after `listen` and removes it before
    // `close`; a stopped process still accepts connections), so a reused pid cannot block starts.
    const code = ((err as { cause?: { code?: string } }).cause ?? {}).code;
    if (code === "ECONNREFUSED") {
      unlinkIfSame(file, r.ino);
      return { kind: "none" };
    }
    // accepted but silent, or timed out: running, unresponsive
  }
  // The file may have been replaced while we waited; judge the current one.
  const now = readState(file);
  if (now.kind === "state" && now.ino !== r.ino) return inspectExplorer(paths);
  throw new ExplorerUnresponsive(state.pid);
}

/** Takes `explorer.lock`; resolves to a function that releases it. A lock whose owner is dead is taken over. */
export async function acquireLock(paths: GantryPaths, timeoutMs = 8000): Promise<() => void> {
  const file = lockFilePath(paths);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      const id = idOf(lstatSync(file));
      return () => unlinkIfSame(file, id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(file);
    } catch {
      continue; // released between the two calls
    }
    let owner = Number.NaN;
    if (st.isFile()) {
      try {
        owner = Number(readFileSync(file, "utf8"));
      } catch {
        // unreadable
      }
    }
    // The lock is held for milliseconds (about 4 s at worst), so one older than LOCK_STALE_MS is abandoned even if
    // its pid has been reused by an unrelated live process.
    const age = Date.now() - st.mtimeMs;
    const dead =
      age > LOCK_STALE_MS || (Number.isInteger(owner) && owner > 0 ? !processAlive(owner) : age > YOUNG_MS);
    if (dead) {
      unlinkIfSame(file, idOf(st));
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Another gantry process (pid ${owner}) is starting the explorer; try again`);
    }
    await sleep(40);
  }
}

/**
 * Creates `explorer.json` exclusively. The content is written to a private temp file first and hard-linked into
 * place, so a reader never sees a partial file; where hard links are unsupported (exFAT) it is created in place.
 * Returns false when the file exists.
 */
export function createStateFile(paths: GantryPaths, state: ExplorerState): boolean {
  const file = stateFilePath(paths);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    unlinkSync(tmp); // a leftover (or a planted symlink) is removed, not followed
  } catch {
    // none
  }
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(state));
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "ENOTSUP" && code !== "EPERM" && code !== "EXDEV" && code !== "ENOSYS") throw err;
  } finally {
    unlinkIfSame(tmp, idOf(lstatSync(tmp)));
  }
  try {
    const out = openSync(file, "wx", 0o600);
    try {
      writeFileSync(out, JSON.stringify(state));
    } finally {
      closeSync(out);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export function removeStateFile(paths: GantryPaths, token: string): void {
  const file = stateFilePath(paths);
  const r = readState(file);
  if (r.kind === "state" && r.state.token === token) unlinkIfSame(file, r.ino);
}
