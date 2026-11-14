import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  backlogPriority,
  buildFactSheet,
  contentKey,
  describeWithRetry,
  type FactSheet,
  FUNCTION_LIKE_KINDS,
  type GantryPaths,
  indexRepo,
  isIndexable,
  isSensitive,
  loadConfig,
  openStore,
  pathOfFileId,
  type Store,
  type SymbolRecord,
  syncBacklog,
} from "@gantry/core";

const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export function git(root: string, args: string[]): { ok: boolean; out: Buffer } {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) };
}

function stagedPaths(root: string): string[] {
  const r = git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
  return r.ok
    ? r.out
        .toString("utf8")
        .split("\0")
        .filter((p) => p !== "")
    : [];
}

interface StagedContext {
  real: Store;
  sources: Map<string, string>;
  staged: SymbolRecord[];
  scratch: Store;
}

/**
 * Parses the staged blobs in memory on a scratch copy of the store (the real store is never given the staged
 * rows) and hands both stores to `fn`. Returns undefined when there is nothing to do.
 */
async function withStaged<T>(
  paths: GantryPaths,
  fn: (c: StagedContext) => Promise<T>,
): Promise<T | undefined> {
  const config = loadConfig(paths);
  const files = stagedPaths(paths.root).filter((p) => isIndexable(p, config));
  if (files.length === 0 || !fs.existsSync(paths.dbPath)) return undefined;

  const sources = new Map<string, string>();
  for (const p of files) {
    const r = git(paths.root, ["show", `:${p}`]);
    if (r.ok) sources.set(p, r.out.toString("utf8"));
  }
  if (sources.size === 0) return undefined;

  const scratchPath = path.join(paths.dataDir, `precommit-${process.pid}.db`);
  const real = openStore(paths.dbPath);
  let scratch: Store | undefined;
  try {
    real.db.exec(`VACUUM INTO '${scratchPath.replace(/'/g, "''")}'`);
    scratch = openStore(scratchPath);
    await indexRepo(paths, { layer: "working", files: [...sources.keys()], sources, store: scratch });
    const s = scratch;
    const staged = [...sources.keys()].flatMap((p) => s.effectiveSymbols({ fileId: `file:${p}` }));
    return await fn({ real, scratch: s, sources, staged });
  } finally {
    scratch?.close();
    real.close();
    for (const ext of ["", "-wal", "-shm"]) fs.rmSync(scratchPath + ext, { force: true });
  }
}

/** Pre-commit with `precommit.mode` off: index the staged blobs on a scratch copy of the store and enqueue undescribed functions. */
export async function preCommit(paths: GantryPaths): Promise<number> {
  const r = await withStaged(paths, async ({ real, sources, staged }) =>
    syncBacklog(real, { root: paths.root, sources, symbols: staged }),
  );
  return r?.enqueued ?? 0;
}

export interface StagedDescribeResult {
  enqueued: number;
  /** Staged functions that had no description after templating. */
  undescribed: number;
  described: number;
  /** Staged functions still without a description afterwards (pending or failed in the backlog). */
  queued: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export interface StagedDescribeOptions {
  env?: NodeJS.ProcessEnv;
  /** When the surrounding command started; the `timeboxed` budget counts from here. Default: now. */
  startedAt?: number;
}

/**
 * `gantry describe --staged` (spec sections 10 and 11): enqueue what the commit adds, then describe the staged
 * undescribed functions (priority order, at most `precommit.maxFunctions`) with the headless worker.
 * `timeboxed` kills the worker when `precommit.budgetMs` is used up (counted from `startedAt`); `strict` has no
 * deadline. Whatever is not described stays in the backlog. Returns undefined when nothing is staged.
 */
export async function describeStaged(
  paths: GantryPaths,
  opts: StagedDescribeOptions = {},
): Promise<StagedDescribeResult | undefined> {
  const env = opts.env ?? process.env;
  const startedAt = opts.startedAt ?? Date.now();
  if (env.GANTRY_WORKER === "1") return undefined; // a describer's own commit: never recurse
  const config = loadConfig(paths);
  return withStaged(paths, async ({ real, scratch, sources, staged }) => {
    const sync = syncBacklog(real, { root: paths.root, sources, symbols: staged });

    const isDescribed = real.db.prepare("SELECT 1 FROM descriptions WHERE content_key = ?");
    const byKey = new Map<string, { sym: SymbolRecord; priority: number }>();
    for (const sym of [...staged].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (!FUNCTION_LIKE_KINDS.includes(sym.kind) || sym.exactHash === "") continue;
      const p = pathOfFileId(sym.fileId);
      if (isSensitive(p)) continue;
      const key = contentKey(sym.exactHash);
      if (isDescribed.get(key)) continue;
      const priority = backlogPriority(sym.kind, sym.exported, p);
      const prev = byKey.get(key);
      if (!prev || priority < prev.priority) byKey.set(key, { sym, priority });
    }
    const ordered = [...byKey].sort(
      (a, b) => a[1].priority - b[1].priority || (a[1].sym.id < b[1].sym.id ? -1 : 1),
    );
    const chosen = ordered.slice(0, config.precommit.maxFunctions);

    const sheets: FactSheet[] = [];
    for (const [, { sym }] of chosen) {
      const source = sources.get(pathOfFileId(sym.fileId));
      if (source === undefined) continue;
      try {
        sheets.push(buildFactSheet(scratch, sym.id, source));
      } catch {
        // sensitive or vanished symbol: stays in the backlog untouched
      }
    }

    const result: StagedDescribeResult = {
      enqueued: sync.enqueued,
      undescribed: ordered.length,
      described: 0,
      queued: ordered.length,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: 0,
    };
    if (sheets.length === 0) return result;

    const deadlineMs =
      config.precommit.mode === "strict"
        ? Number.POSITIVE_INFINITY
        : Math.max(0, config.precommit.budgetMs - (Date.now() - startedAt));
    const r = await describeWithRetry(real, sheets, { task: "describe.precommit", deadlineMs, config, env });
    result.described = r.described;
    result.failed = r.failed;
    result.queued = Math.max(0, ordered.length - r.described);
    result.inputTokens = r.inputTokens;
    result.outputTokens = r.outputTokens;
    result.ms = r.ms;
    return result;
  });
}
