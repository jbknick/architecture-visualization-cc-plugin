import fs from "node:fs";
import path from "node:path";
import {
  type GantryConfig,
  type GantryPaths,
  indexRepo,
  isIndexable,
  loadConfig,
  openStore,
  parseSource,
  type Store,
} from "@gantry/core";
import {
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
 * (`settleBatch`). Without one the edit is a batch of one and is settled at once. Never calls a model.
 */
export async function postToolUse(paths: GantryPaths, input: PostToolInput): Promise<string | undefined> {
  if (!fs.existsSync(paths.dbPath)) return undefined;
  const rel = repoRelative(paths.root, input.filePath);
  if (rel === undefined) return undefined;
  const config = loadConfig(paths);
  const source = isIndexable(rel, config);
  if (!source && !MANIFEST_RE.test(rel)) return undefined;

  const store = openStore(paths.dbPath);
  try {
    const session = input.sessionId ?? "";
    recordEdit(store, session, rel, source);
    if (source) await indexRepo(paths, { layer: "working", files: [rel], store });
    if (input.sessionId !== undefined) return undefined;
    const text = formatCapped(await settle(paths, store, session, config), 600);
    if (text === "") return undefined;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
  } finally {
    store.close();
  }
}

/**
 * Stop (spec section 14): the turn's batch of edits has settled. Re-indexes every file the batch touched, checks
 * the changed functions for duplicates and the added imports for undeclared packages, double-checks each finding
 * against disk, clears the batch and returns the Stop hook's stdout JSON, or undefined when there is nothing to say.
 */
export async function settleBatch(paths: GantryPaths, input: StopInput): Promise<string | undefined> {
  if (!fs.existsSync(paths.dbPath)) return undefined;
  const store = openStore(paths.dbPath);
  try {
    const text = formatCapped(await settle(paths, store, input.sessionId, loadConfig(paths)), 600);
    if (text === "") return undefined;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } });
  } finally {
    store.close();
  }
}

/** Adds `rel` to the session's batch unless it is already in it (the first baseline wins). */
export function recordEdit(store: Store, session: string, rel: string, source: boolean): void {
  const baseline = source
    ? Object.fromEntries(store.effectiveSymbols({ fileId: `file:${rel}` }).map((s) => [s.id, s.exactHash]))
    : {};
  store.db
    .prepare(
      `INSERT INTO pending_files(session_id, path, baseline, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, path) DO NOTHING`,
    )
    .run(session, rel, JSON.stringify(baseline), new Date().toISOString());
}

/**
 * The end-of-batch pipeline shared by Stop and a batch of one: re-index the batch's source files together (the
 * indexer re-reads every workspace's package.json and tsconfig from disk on each run), find, double-check against
 * disk, clear the batch. Findings are per file in path order: duplicates (lowest in the file first), then imports.
 */
export async function settle(
  paths: GantryPaths,
  store: Store,
  session: string,
  config: GantryConfig,
): Promise<Finding[]> {
  const rows = store.db
    .prepare("SELECT path, baseline FROM pending_files WHERE session_id = ? ORDER BY path")
    .all(session) as { path: string; baseline: string }[];
  if (rows.length === 0) return [];
  const sources = rows.filter((r) => isIndexable(r.path, config));
  await indexRepo(paths, { layer: "working", files: sources.map((r) => r.path), store });
  const check = diskCheck(paths.root, store, config);
  const findings: Finding[] = [];
  for (const r of sources) {
    let baseline: Record<string, string>;
    try {
      baseline = JSON.parse(r.baseline) as Record<string, string>;
    } catch {
      baseline = {};
    }
    const current = store.effectiveSymbols({ fileId: `file:${r.path}` });
    findings.push(
      ...(await duplicateFindings(
        store,
        changedSymbols(current, new Map(Object.entries(baseline))),
        config,
        check,
      )),
    );
    let text: string | undefined;
    try {
      text = fs.readFileSync(path.join(paths.root, r.path), "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      const head = git(paths.root, ["show", `HEAD:${r.path}`]);
      const before = head.ok ? parseSource(r.path, head.out.toString("utf8")) : undefined;
      findings.push(...importFindings(store, r.path, parseSource(r.path, text), before).filter(check));
    }
  }
  store.db.prepare("DELETE FROM pending_files WHERE session_id = ?").run(session);
  store.db
    .prepare("DELETE FROM pending_files WHERE created_at < ?")
    .run(new Date(Date.now() - PENDING_TTL_MS).toISOString());
  return findings;
}
