import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  fileId,
  type GantryConfig,
  type GantryPaths,
  type Group,
  indexRepo,
  isIndexable,
  isQueryFile,
  loadConfig,
  loadRecipe,
  mergedGroups,
  openStore,
  openTeamCache,
  parseFile,
  pathsForRepo,
  readTeamRepo,
  repoOfPath,
  type Store,
  type TeamCache,
} from "@gantry/core";
import { crossingFindings } from "./boundaries.js";
import {
  type CrossingFinding,
  changedSymbols,
  diskCheck,
  duplicateFindings,
  type Finding,
  formatCapped,
  importFindings,
} from "./findings.js";
import { git } from "./staged.js";

/** Spec section 14: the per-edit hook and the end-of-batch check each finish inside this budget or print nothing. */
export const POST_TOOL_BUDGET_MS = 1500;
const MAX_STDIN = 1024 * 1024;
/** Source files re-indexed per committed step when a manifest is in the batch. */
const REINDEX_CHUNK = 8;
/** Batch rows older than this belong to sessions that never reached Stop and are pruned. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Files other than sources whose edit can change a finding (spec section 14): a package.json (name, dependencies,
 * exports), a tsconfig (paths and aliases) and the pnpm workspace list.
 */
export const MANIFEST_RE = /(^|\/)(package\.json|tsconfig[^/]*\.json|pnpm-workspace\.yaml)$/;

export interface PostToolInput {
  toolName: string;
  filePath: string;
  cwd?: string;
  /** Claude Code's session id, the key of the batch. Without it the edit is a batch of one, checked at once. */
  sessionId?: string;
}

export interface StopInput {
  sessionId: string;
  cwd?: string;
}

/** Parses the hook's stdin JSON; undefined when it is not the shape Claude Code sends for an edit tool. */
export function parsePostToolInput(text: string | undefined): PostToolInput | undefined {
  if (!text || text.length > MAX_STDIN) return undefined;
  try {
    const j = JSON.parse(text) as {
      tool_name?: unknown;
      tool_input?: { file_path?: unknown };
      cwd?: unknown;
      session_id?: unknown;
    };
    const filePath = j.tool_input?.file_path;
    if (typeof filePath !== "string" || filePath === "") return undefined;
    const out: PostToolInput = { toolName: typeof j.tool_name === "string" ? j.tool_name : "", filePath };
    if (typeof j.cwd === "string" && path.isAbsolute(j.cwd)) out.cwd = j.cwd;
    if (typeof j.session_id === "string" && j.session_id !== "") out.sessionId = j.session_id;
    return out;
  } catch {
    return undefined;
  }
}

/** Parses the Stop hook's stdin JSON; undefined without a session id (there is no batch to settle). */
export function parseStopInput(text: string | undefined): StopInput | undefined {
  if (!text || text.length > MAX_STDIN) return undefined;
  try {
    const j = JSON.parse(text) as { session_id?: unknown; cwd?: unknown };
    if (typeof j.session_id !== "string" || j.session_id === "") return undefined;
    const out: StopInput = { sessionId: j.session_id };
    if (typeof j.cwd === "string" && path.isAbsolute(j.cwd)) out.cwd = j.cwd;
    return out;
  } catch {
    return undefined;
  }
}

function repoRelative(root: string, abs: string): string | undefined {
  try {
    const realRoot = fs.realpathSync(root);
    const full = path.isAbsolute(abs) ? abs : path.join(root, abs);
    const real = fs.realpathSync(full);
    const rel = path.relative(realRoot, real);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join("/");
  } catch {
    return undefined;
  }
}

/**
 * PostToolUse for Write/Edit/MultiEdit (spec section 14): the trigger. Records the edited file in the session's
 * batch, with the hashes its functions had before the batch first touched it, and re-indexes a source file into the
 * working layer. With a session id it prints nothing: the checks run once the batch settles, at Stop
 * (`settleBatch`). Without one the edit is a batch of one, under a key of its own, and is settled at once.
 * Never calls a model.
 */
export async function postToolUse(
  workspacePaths: GantryPaths,
  input: PostToolInput,
  opts: SettleOptions = {},
): Promise<string | undefined> {
  if (!fs.existsSync(workspacePaths.dbPath)) return undefined;
  // The edited file's repo is found from its path; only that repo's working layer is refreshed.
  const paths = repoOfPath(workspacePaths, input.filePath);
  if (paths === undefined) return undefined;
  const rel = repoRelative(paths.root, input.filePath);
  if (rel === undefined) return undefined;
  const config = loadConfig(paths);
  const source = isIndexable(rel, config);
  // A query file of the recipe has no syntax tree, but the edges of the Go files that run it come from it.
  const query = !source && isQueryFile(loadRecipe(paths.root, { layer: "working" }).recipe, rel);
  if (!source && !query && !MANIFEST_RE.test(rel)) return undefined;

  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  try {
    const session = input.sessionId ?? `once:${randomUUID()}`;
    const recorded = recordEdit(store, session, rel, source, !source && !query);
    if (source || query) {
      await indexRepo(paths, { layer: "working", files: [rel], store });
      // Only now is the file indexed: a trigger cut off before this line leaves reindexed = 0, and Stop indexes it.
      store.db
        .prepare(
          "UPDATE pending_files SET reindexed = 1 WHERE session_id = ? AND repo = ? AND path = ? AND created_at = ?",
        )
        .run(session, paths.repo, rel, recorded);
    }
    if (input.sessionId !== undefined) return undefined;
    const r = await settle(paths, store, session, config, opts);
    // A batch of one that could not finish is not left behind under its throwaway key.
    store.db.prepare("DELETE FROM pending_files WHERE session_id = ?").run(session);
    const text = formatCapped([...r.findings, ...r.teamFindings], 600);
    if (text === "") return undefined;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
  } finally {
    store.close();
  }
}

/**
 * Stop (spec section 14): the turn's batch of edits has settled. Re-indexes the batch when it touched a manifest,
 * checks the changed functions for duplicates and the added imports for undeclared packages, double-checks each
 * finding against disk, removes each file from the batch once it is checked and returns the Stop hook's stdout JSON,
 * or undefined when there is nothing to say. Files it had no time for stay in the batch for the next Stop.
 */
export async function settleBatch(
  paths: GantryPaths,
  input: StopInput,
  opts: SettleOptions = {},
): Promise<string | undefined> {
  if (!fs.existsSync(paths.dbPath)) return undefined;
  const open = (p: GantryPaths) => openStore(p.dbPath, { overlayPath: p.overlayPath, repo: p.repo });
  // A batch can hold edits of several repos of the workspace; each repo's files are settled against that repo.
  const first = open(paths);
  let repos: string[];
  try {
    repos = (
      first.db
        .prepare("SELECT DISTINCT repo FROM pending_files WHERE session_id = ? ORDER BY repo")
        .all(input.sessionId) as { repo: string }[]
    )
      .map((r) => r.repo)
      .filter((r) => paths.workspace.repos.some((m) => m.name === r));
  } finally {
    first.close();
  }
  const findings: Finding[] = [];
  const teamFindings: Finding[] = [];
  let settled = 0;
  for (const repo of repos) {
    const p = pathsForRepo(paths, repo);
    const store = open(p);
    try {
      const r = await settle(p, store, input.sessionId, loadConfig(p), {
        ...opts,
        maxFiles: (opts.maxFiles ?? Number.POSITIVE_INFINITY) - settled,
      });
      findings.push(...r.findings);
      teamFindings.push(...r.teamFindings);
      settled += r.settled;
    } finally {
      store.close();
    }
  }
  // Team lines come after every other finding, so the cap drops them first.
  const text = formatCapped([...findings, ...teamFindings], 600);
  if (text === "") return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } });
}

/**
 * Adds `rel` to the session's batch and returns the row's `created_at`. The first baseline wins; a later edit of the
 * same file moves `created_at` (so a settle that read the row before that edit does not delete it) and sets
 * `reindexed` back to 0 until that edit's own index finishes.
 */
export function recordEdit(
  store: Store,
  session: string,
  rel: string,
  source: boolean,
  manifest: boolean = !source,
): string {
  const baseline = source
    ? Object.fromEntries(
        store.effectiveSymbols({ fileId: fileId(store.repo(), rel) }).map((s) => [s.id, s.exactHash]),
      )
    : {};
  const at = stamp();
  store.db
    .prepare(
      `INSERT INTO pending_files(session_id, repo, path, baseline, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, repo, path) DO UPDATE SET created_at = excluded.created_at, reindexed = 0`,
    )
    .run(session, store.repo(), rel, JSON.stringify(baseline), at);
  // A manifest edit changes how every file of the batch resolves: all of them are re-indexed again at Stop.
  if (manifest) {
    store.db
      .prepare("UPDATE pending_files SET reindexed = 0 WHERE session_id = ? AND repo = ?")
      .run(session, store.repo());
  }
  return at;
}

/** ISO time with a per-process counter, so two edits in the same millisecond still get different stamps. */
let stampSeq = 0;
function stamp(): string {
  stampSeq = (stampSeq + 1) % 1_000_000;
  return `${new Date().toISOString()}#${process.pid}.${String(stampSeq).padStart(6, "0")}`;
}

export interface SettleOptions {
  /** Epoch ms after which no further file is started (the rest stays in the batch). Default: no deadline. */
  deadline?: number;
  /** How long to wait for the store's write lock before giving up (fail open). Default 200 ms. */
  lockWaitMs?: number;
  /** At most this many source files per settle (the rest stays in the batch). Default: no cap. */
  maxFiles?: number;
  /** Test seam: runs right after the batch rows are read. */
  afterRead?: () => void;
  /** Test seam: the clock compared with `deadline`. Default `Date.now`. */
  now?: () => number;
}

export interface SettleResult {
  findings: Finding[];
  /** Crossings of the team's groups (spec section 14): printed after every other finding. */
  teamFindings: Finding[];
  /** Files checked and removed from the batch. */
  settled: number;
  /** Files left in the batch: out of time, or the write lock was busy. */
  remaining: number;
}

/**
 * The end-of-batch pipeline shared by Stop and a batch of one (spec section 14).
 *
 * 1. Rows older than 24 h are pruned first, before any other work.
 * 2. Every step takes the store's write lock with a short wait (`lockWaitMs`); when another settle or index holds it,
 *    the step is skipped and its files stay in the batch (fail open).
 * 3. If the batch touched a manifest (package.json, tsconfig, pnpm-workspace.yaml), its source files are re-indexed
 *    together, which re-reads the workspaces from disk; otherwise only the source files that are gone from disk are
 *    (PostToolUse already indexed the others).
 * 4. Each source file is checked, then its row is deleted in the same transaction, by the (path, created_at) that was
 *    read, so a file edited again meanwhile stays in the batch. No file is started after `deadline`.
 * Findings are per file in path order: duplicates (lowest in the file first), then imports, then group-boundary crossings.
 * The crossings of team groups (`teamFindings`) are kept apart, so the caller can print them after everything else.
 */
export async function settle(
  paths: GantryPaths,
  store: Store,
  session: string,
  config: GantryConfig,
  opts: SettleOptions = {},
): Promise<SettleResult> {
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const now = opts.now ?? Date.now;
  // A step is started only if the longest step so far would still end before the deadline.
  let longest = 0;
  const late = (): boolean => now() + longest > deadline;
  const step = async (fn: () => Promise<void>): Promise<boolean> => {
    const t0 = Date.now();
    const ok = await locked(store, lockWait, fn);
    longest = Math.max(longest, Date.now() - t0);
    return ok;
  };
  const lockWait = opts.lockWaitMs ?? 200;
  const out: SettleResult = { findings: [], teamFindings: [], settled: 0, remaining: 0 };
  const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  await locked(store, lockWait, async () => {
    store.db.prepare("DELETE FROM pending_files WHERE created_at < ?").run(cutoff);
  });

  const rows = store.db
    .prepare(
      "SELECT path, baseline, created_at, reindexed FROM pending_files WHERE session_id = ? AND repo = ? ORDER BY path",
    )
    .all(session, store.repo()) as {
    path: string;
    baseline: string;
    created_at: string;
    reindexed: number;
  }[];
  if (rows.length === 0) return out;
  opts.afterRead?.();
  const del = store.db.prepare(
    "DELETE FROM pending_files WHERE session_id = ? AND repo = ? AND path = ? AND created_at = ?",
  );
  const sources = rows.filter((r) => isIndexable(r.path, config));
  const recipe = loadRecipe(paths.root, { layer: "working" }).recipe;
  const queries = rows.filter((r) => !isIndexable(r.path, config) && isQueryFile(recipe, r.path));
  const manifests = rows.filter((r) => !isIndexable(r.path, config) && !isQueryFile(recipe, r.path));
  out.remaining = rows.length;

  // Re-index step, in chunks that each commit, so a batch too large for one Stop still makes progress.
  const gone = (r: { path: string }): boolean => !fs.existsSync(path.join(paths.root, r.path));
  // Not indexed since its last edit (a trigger cut off before its index, or a manifest edited since), or gone.
  const todo = [...sources, ...queries].filter((r) => r.reindexed === 0 || gone(r));
  const mark = store.db.prepare(
    "UPDATE pending_files SET reindexed = 1 WHERE session_id = ? AND repo = ? AND path = ? AND created_at = ?",
  );
  for (let i = 0; i < todo.length; i += REINDEX_CHUNK) {
    if (late()) return out;
    const chunk = todo.slice(i, i + REINDEX_CHUNK);
    const ok = await step(async () => {
      await indexRepo(paths, { layer: "working", files: chunk.map((r) => r.path), store });
      for (const r of chunk) mark.run(session, store.repo(), r.path, r.created_at);
    });
    if (!ok) return out;
  }
  if (queries.length > 0) {
    if (late()) return out;
    // A query file has nothing to check once its Go files are re-indexed: its row leaves the batch.
    const ok = await step(async () => {
      for (const q of queries) del.run(session, store.repo(), q.path, q.created_at);
    });
    if (!ok) return out;
    out.settled += queries.length;
    out.remaining -= queries.length;
  }
  if (manifests.length > 0) {
    if (late()) return out;
    const ok = await step(async () => {
      if (todo.length === 0) await indexRepo(paths, { layer: "working", files: [], store }); // workspaces from disk
      for (const m of manifests) del.run(session, store.repo(), m.path, m.created_at);
    });
    if (!ok) return out;
    out.settled += manifests.length;
    out.remaining -= manifests.length;
  }

  const check = diskCheck(paths.root, store, config);
  const groups = boundaryGroups(paths, store);
  for (const r of sources) {
    if (
      late() ||
      out.settled - manifests.length - queries.length >= (opts.maxFiles ?? Number.POSITIVE_INFINITY)
    )
      break;
    const found: Finding[] = [];
    const foundTeam: Finding[] = [];
    const ok = await step(async () => {
      let baseline: Record<string, string>;
      try {
        baseline = JSON.parse(r.baseline) as Record<string, string>;
      } catch {
        baseline = {};
      }
      const current = store.effectiveSymbols({ fileId: fileId(store.repo(), r.path) });
      const changed = changedSymbols(current, new Map(Object.entries(baseline)));
      found.push(...(await duplicateFindings(store, changed, config, check)));
      let text: string | undefined;
      try {
        text = fs.readFileSync(path.join(paths.root, r.path), "utf8");
      } catch {
        text = undefined;
      }
      if (text !== undefined) {
        const head = git(paths.root, ["show", `HEAD:${r.path}`]);
        const before = head.ok ? parseFile(store.repo(), r.path, head.out.toString("utf8")) : undefined;
        found.push(
          ...importFindings(store, r.path, parseFile(store.repo(), r.path, text), before).filter(check),
        );
      }
      // Group boundaries (spec section 14): reads overlay.db, never writes it; same disk double-check.
      found.push(
        ...crossingFindings(store, changed, [r.path], groups.local ? { groups: groups.local } : {}).filter(
          check,
        ),
      );
      // Team groups (spec section 14): from the cache read before the loop, never from a server.
      if (groups.team.length > 0)
        foundTeam.push(
          ...crossingFindings(store, changed, [r.path], { groups: groups.team })
            .map((f): CrossingFinding => ({ ...f, team: true }))
            .filter(check),
        );
      del.run(session, store.repo(), r.path, r.created_at);
    });
    if (!ok) break;
    out.findings.push(...found);
    out.teamFindings.push(...foundTeam);
    out.settled++;
    out.remaining--;
  }
  return out;
}

/**
 * The groups of the team cache that can be boundaries, and, when the team has any group, the local groups that no
 * team group shadows (the local rule then follows the team's id clash rule, spec section 7). Reads the cache file
 * once, read-only and with no network, and closes it. The cache is ignored when it is missing, holds another repo's
 * data or has no groups; then `local` is undefined and the local call reads the overlay as before.
 */
function boundaryGroups(paths: GantryPaths, store: Store): { local?: Group[]; team: Group[] } {
  const none = { team: [] };
  let cache: TeamCache | undefined;
  try {
    cache = openTeamCache(paths, { readonly: true });
  } catch {
    return none;
  }
  if (cache === undefined) return none;
  try {
    if (readTeamRepo(cache) !== store.repo()) return none;
    const merged = mergedGroups(store, cache);
    const team = merged.filter((g) => g.origin === "team");
    if (team.length === 0) return none;
    return {
      local: merged.filter((g) => g.origin === "local" && g.shadowed !== true),
      // The whole list: a group with `mayUse: null` is no boundary, but a call into it is still a crossing.
      team,
    };
  } catch {
    return none;
  } finally {
    cache.close();
  }
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE`, waiting at most `waitMs` for the write lock. False when the lock was busy
 * (nothing ran) or `fn` threw (rolled back). The indexer's own transactions nest inside as savepoints.
 */
async function locked(store: Store, waitMs: number, fn: () => Promise<void>): Promise<boolean> {
  const prev = store.db.pragma("busy_timeout", { simple: true }) as number;
  store.db.pragma(`busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
  try {
    store.db.exec("BEGIN IMMEDIATE");
  } catch {
    store.db.pragma(`busy_timeout = ${prev}`);
    return false;
  }
  store.db.pragma(`busy_timeout = ${prev}`);
  try {
    await fn();
    store.db.exec("COMMIT");
    return true;
  } catch {
    if (store.db.inTransaction) store.db.exec("ROLLBACK");
    return false;
  }
}
