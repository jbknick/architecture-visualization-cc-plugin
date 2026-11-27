import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChangeSetRead } from "@gantry/protocol";
import Database from "better-sqlite3";
import type { GantryConfig } from "../config/index.js";
import { resolveTeamSettings } from "../config/team.js";
import { GantryError } from "../errors.js";
import { type Group, GroupSchema, type SavedView, SavedViewSchema } from "../overlay/types.js";
import type { GantryPaths } from "../paths/index.js";
import { TEAM_CACHE_SCHEMA } from "./cacheSchema.js";
import { type TeamClient, teamClient } from "./client.js";

// `team-cache.db` is the one local copy of team state (spec section 11). Only `pullTeamCache` talks to the server,
// and only the MCP server and `gantry team status --pull` call it. Everything a hook may use is the readers at the
// bottom: synchronous, read-only, and no network. `cache.guard.test.ts` checks that no hook imports the rest.

/** The `user_version` of `team-cache.db`. A file with another version is deleted and recreated (no upgrade path). */
export const TEAM_CACHE_VERSION = 1;

const DEFAULT_PULL_TIMEOUT_MS = 5000;
/** The contract allows 500 change sets, and a page holds at least one, so up to 500 pages. */
const MAX_PAGES = 600;
/** How long a pull waits for another writer's lock (SQLite waits synchronously, so this blocks the event loop). */
const PULL_BUSY_MS = 250;
const MAX_ERROR_CHARS = 500;

export interface TeamCache {
  db: Database.Database;
  path: string;
  close(): void;
}

/** `<dataDir>/team-cache.db`, beside the index and never inside the repo. */
export const teamCachePath = (paths: GantryPaths): string => join(paths.dataDir, "team-cache.db");

function removeFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
}

function userVersion(db: Database.Database): number {
  return Number(db.pragma("user_version", { simple: true }));
}

function tableCount(db: Database.Database): number {
  return (db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n;
}

/** Opens `file` for writing: creates the schema in a new file, and returns undefined for a file of another version. */
function openWritable(file: string, busyMs: number): Database.Database | undefined {
  const db = new Database(file, { timeout: busyMs });
  try {
    db.pragma(`busy_timeout = ${busyMs}`);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    const ok = db
      .transaction((): boolean => {
        const found = userVersion(db);
        if (found === 0 && tableCount(db) === 0) {
          db.exec(TEAM_CACHE_SCHEMA);
          db.pragma(`user_version = ${TEAM_CACHE_VERSION}`);
          return true;
        }
        return found === TEAM_CACHE_VERSION;
      })
      .immediate();
    if (ok) return db;
  } catch (err) {
    // Only a file that is not a database, or is corrupt, is recreated. A lock held by another writer (busy) or any
    // other error leaves the file alone and is thrown to the caller.
    const code = (err as { code?: string }).code;
    if (code !== "SQLITE_NOTADB" && code !== "SQLITE_CORRUPT") {
      db.close();
      throw err;
    }
  }
  db.close();
  return undefined;
}

/**
 * Opens `<dataDir>/team-cache.db`. With `readonly: true` it never creates, migrates or deletes anything, and returns
 * `undefined` when the file is missing, unreadable or of another version (a hook treats that as "no team data").
 * Without it the file is created, and a file of another version is deleted and recreated.
 */
export function openTeamCache(paths: GantryPaths, opts: { readonly: true }): TeamCache | undefined;
export function openTeamCache(paths: GantryPaths, opts?: { readonly?: false; busyMs?: number }): TeamCache;
export function openTeamCache(
  paths: GantryPaths,
  opts: { readonly?: boolean; busyMs?: number } = {},
): TeamCache | undefined {
  const file = teamCachePath(paths);
  if (opts.readonly === true) {
    if (!existsSync(file)) return undefined;
    let db: Database.Database | undefined;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
      if (userVersion(db) === TEAM_CACHE_VERSION) return { db, path: file, close: () => db?.close() };
    } catch {
      // unreadable: no team data
    }
    db?.close();
    return undefined;
  }
  mkdirSync(paths.dataDir, { recursive: true });
  const busyMs = opts.busyMs ?? 5000;
  let db = openWritable(file, busyMs);
  if (db === undefined) {
    removeFiles(file);
    db = openWritable(file, busyMs);
  }
  if (db === undefined) throw new Error(`Cannot create ${file}.`);
  const open = db;
  return { db: open, path: file, close: () => open.close() };
}

function getMeta(db: Database.Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)
    ?.value;
}

function setMeta(db: Database.Database, key: string, value: string | undefined): void {
  if (value === undefined) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  else
    db.prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
}

export interface PullResult {
  status: "updated" | "unchanged" | "skipped" | "failed";
  /** The change sets in the cache after the pull. */
  change_sets: number;
  error?: string;
}

export interface PullTeamCacheOptions {
  fetch?: typeof fetch;
  /** The limit for the whole pull, every page included. Default 5,000 ms. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** The clock, for `meta.pulled_at`. Default `Date.now`. */
  now?: () => number;
}

function countChangeSets(db: Database.Database): number {
  return (db.prepare("SELECT count(*) AS n FROM change_sets").get() as { n: number }).n;
}

/** `fetch` that gives up when `signal` fires, whatever per-request limit the client set. */
function limitedFetch(base: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) =>
    base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

function replaceAll(
  db: Database.Database,
  data: {
    changeSets: ChangeSetRead[];
    views: unknown[];
    groups: unknown[];
    settings: Record<string, unknown>;
  },
  meta: { etag: string | undefined; pulledAt: string; identity: Record<string, string> },
): void {
  const insertSet = db.prepare(
    `INSERT OR REPLACE INTO change_sets(id, repo, source, state, estimated, confidence, owner, title, pr, ref, head_ref,
       base_branch, head_sha, links, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertNode = db.prepare(
    "INSERT OR IGNORE INTO change_set_nodes(change_set_id, node_id) VALUES (?, ?)",
  );
  const insertReach = db.prepare(
    "INSERT OR REPLACE INTO change_set_reach(change_set_id, node_id, hop, tier, via_hub) VALUES (?, ?, ?, ?, ?)",
  );
  const insertItem = (table: "team_views" | "team_groups") =>
    db.prepare(`INSERT OR REPLACE INTO ${table}(id, name, spec) VALUES (?, ?, ?)`);
  db.transaction(() => {
    for (const table of [
      "change_sets",
      "change_set_nodes",
      "change_set_reach",
      "team_views",
      "team_groups",
      "settings",
    ])
      db.exec(`DELETE FROM ${table}`);
    for (const cs of data.changeSets) {
      insertSet.run(
        cs.id,
        cs.repo,
        cs.source,
        cs.state,
        cs.estimated ? 1 : 0,
        cs.confidence ?? null,
        cs.owner,
        cs.title ?? null,
        cs.pr ?? null,
        cs.ref,
        cs.head_ref,
        cs.base_branch,
        cs.head_sha,
        JSON.stringify(cs.links),
        cs.created_at,
        cs.updated_at,
      );
      for (const node of cs.nodes) insertNode.run(cs.id, node);
      for (const r of cs.radius) insertReach.run(cs.id, r.id, r.hop, r.tier, r.via_hub ? 1 : 0);
    }
    for (const [table, items] of [
      ["team_views", data.views],
      ["team_groups", data.groups],
    ] as const) {
      const insert = insertItem(table);
      for (const item of items as { id: string; name: string }[])
        insert.run(item.id, item.name, JSON.stringify(item));
    }
    for (const [key, value] of Object.entries(data.settings)) {
      if (value === undefined) continue;
      db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").run(
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    }
    db.exec("DELETE FROM inflight WHERE change_set_id NOT IN (SELECT id FROM change_sets)");
    for (const [key, value] of Object.entries(meta.identity)) setMeta(db, key, value);
    setMeta(db, "etag", meta.etag);
    setMeta(db, "pulled_at", meta.pulledAt);
    setMeta(db, "last_error", undefined);
  }).immediate();
}

/** Every page of a pull, as `{ changeSets, ... }`; or `undefined` when the server answers 304 to `etag`. */
async function fetchAll(client: TeamClient, repo: string, etag: string | undefined) {
  const changeSets = new Map<string, ChangeSetRead>();
  let views: unknown[] = [];
  let groups: unknown[] = [];
  let settings: Record<string, unknown> = {};
  let newEtag: string | undefined;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await client.pullPage(
      cursor === undefined ? { repo } : { repo, cursor },
      cursor === undefined ? etag : undefined,
    );
    if (answer.notModified) return undefined;
    if (page === 0) {
      newEtag = answer.etag;
      views = answer.page.team_views;
      groups = answer.page.groups;
      settings = answer.page.settings;
    }
    for (const cs of answer.page.change_sets) changeSets.set(cs.id, cs);
    cursor = answer.page.next_cursor;
    if (cursor === undefined)
      return { changeSets: [...changeSets.values()], views, groups, settings, etag: newEtag };
  }
  throw new GantryError("team_rejected", "The server's pull has too many pages.");
}

/** The cache is for one server, organisation and repo; a different one means the file is another team's. */
function identityDiffers(db: Database.Database, identity: Record<string, string>): boolean {
  return Object.entries(identity).some(([key, value]) => {
    const stored = getMeta(db, key);
    return stored !== undefined && stored !== value;
  });
}

/**
 * Pulls team state into `team-cache.db` (spec section 11). `skipped` when no server or no token is configured. A 304
 * only moves `meta.pulled_at`; a 200 replaces every table in one transaction, so a reader never sees half a pull. Any
 * failure keeps the old rows and sets `meta.last_error`. This function reaches the network; hooks must never call it.
 */
export async function pullTeamCache(
  paths: GantryPaths,
  config: GantryConfig,
  opts: PullTeamCacheOptions = {},
): Promise<PullResult> {
  const env = opts.env ?? process.env;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_PULL_TIMEOUT_MS);
  let client: TeamClient;
  let ciToken: boolean;
  try {
    const settings = resolveTeamSettings(config, env);
    if (settings.server === undefined) return { status: "skipped", change_sets: 0 };
    ciToken = (settings.token ?? "").startsWith("gct_");
    client = teamClient(paths, config, {
      env,
      fetch: limitedFetch(opts.fetch ?? fetch, signal),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
  } catch (err) {
    return { status: "failed", change_sets: 0, error: errorText(err) };
  }
  // A signed-in user's request needs an organisation; a CI token's needs none.
  if (!client.hasToken || (client.org === undefined && !ciToken))
    return { status: "skipped", change_sets: 0 };

  const identity = { server: client.server, org: client.org ?? "", repo: paths.repo };
  let cache: TeamCache;
  try {
    cache = openTeamCache(paths, { busyMs: PULL_BUSY_MS });
    if (identityDiffers(cache.db, identity)) {
      cache.close();
      removeFiles(cache.path);
      cache = openTeamCache(paths, { busyMs: PULL_BUSY_MS });
    }
  } catch (err) {
    return { status: "failed", change_sets: 0, error: errorText(err) };
  }
  const { db } = cache;
  try {
    const now = new Date((opts.now ?? Date.now)()).toISOString();
    try {
      const data = await fetchAll(client, paths.repo, getMeta(db, "etag"));
      if (data === undefined) {
        db.transaction(() => {
          for (const [key, value] of Object.entries(identity)) setMeta(db, key, value);
          setMeta(db, "pulled_at", now);
          setMeta(db, "last_error", undefined);
        }).immediate();
        return { status: "unchanged", change_sets: countChangeSets(db) };
      }
      replaceAll(db, data, { etag: data.etag, pulledAt: now, identity });
      return { status: "updated", change_sets: countChangeSets(db) };
    } catch (err) {
      const error = errorText(err);
      let count = 0;
      try {
        count = countChangeSets(db);
      } catch {
        // unreadable: report none
      }
      try {
        db.transaction(() => {
          for (const [key, value] of Object.entries(identity)) setMeta(db, key, value);
          setMeta(db, "last_error", error);
        }).immediate();
      } catch {
        // another writer holds the lock: the old rows stay and the error is only returned
      }
      return { status: "failed", change_sets: count, error };
    }
  } finally {
    cache.close();
  }
}

function errorText(err: unknown): string {
  const text =
    err instanceof GantryError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) : text;
}

// ---- readers: synchronous, read-only, empty when there is no cache

/** A change set as the cache holds it, without `nodes` and `radius`; text from the server is untrusted data. */
export interface TeamChangeSet {
  id: string;
  repo: string;
  source: "pr" | "branch";
  state: "proposed" | "in_progress" | "in_review" | "merged";
  estimated: boolean;
  confidence?: number;
  owner: string;
  title?: string;
  pr?: number;
  ref: string;
  head_ref: string;
  base_branch: string;
  head_sha: string;
  links: string[];
  created_at: string;
  updated_at: string;
}

/** A change set that touches a node: it changes it, or reaches it at `hop` (and `tier`). */
export interface TouchingChangeSet extends TeamChangeSet {
  touch: { kind: "changed" } | { kind: "reach"; hop: number; tier: string; via_hub: boolean };
}

interface ChangeSetRow {
  id: string;
  repo: string;
  source: TeamChangeSet["source"];
  state: TeamChangeSet["state"];
  estimated: number;
  confidence: number | null;
  owner: string;
  title: string | null;
  pr: number | null;
  ref: string;
  head_ref: string;
  base_branch: string;
  head_sha: string;
  links: string;
  created_at: string;
  updated_at: string;
}

function parseLinks(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toChangeSet(r: ChangeSetRow): TeamChangeSet {
  return {
    id: r.id,
    repo: r.repo,
    source: r.source,
    state: r.state,
    estimated: r.estimated === 1,
    ...(r.confidence === null ? {} : { confidence: r.confidence }),
    owner: r.owner,
    ...(r.title === null ? {} : { title: r.title }),
    ...(r.pr === null ? {} : { pr: r.pr }),
    ref: r.ref,
    head_ref: r.head_ref,
    base_branch: r.base_branch,
    head_sha: r.head_sha,
    links: parseLinks(r.links),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const COLUMNS =
  "cs.id, cs.repo, cs.source, cs.state, cs.estimated, cs.confidence, cs.owner, cs.title, cs.pr, cs.ref, cs.head_ref, cs.base_branch, cs.head_sha, cs.links, cs.created_at, cs.updated_at";

/** Runs a read and answers `empty` when the cache is missing or the read fails. */
function read<T>(cache: TeamCache | undefined, empty: T, body: (db: Database.Database) => T): T {
  if (cache === undefined) return empty;
  try {
    return body(cache.db);
  } catch {
    return empty;
  }
}

/** Every change set in the cache, most recently updated first. */
export function readChangeSets(cache: TeamCache | undefined): TeamChangeSet[] {
  return read(cache, [], (db) =>
    (
      db
        .prepare(`SELECT ${COLUMNS} FROM change_sets cs ORDER BY cs.updated_at DESC, cs.id`)
        .all() as ChangeSetRow[]
    ).map(toChangeSet),
  );
}

/** The change sets that change `nodeId` or reach it, most recently updated first; a change set that does both is `changed`. */
export function readChangeSetsTouching(cache: TeamCache | undefined, nodeId: string): TouchingChangeSet[] {
  return read(cache, [], (db) => {
    const changed = db
      .prepare(
        `SELECT ${COLUMNS} FROM change_sets cs JOIN change_set_nodes n ON n.change_set_id = cs.id WHERE n.node_id = ?`,
      )
      .all(nodeId) as ChangeSetRow[];
    const reached = db
      .prepare(
        `SELECT ${COLUMNS}, r.hop AS hop, r.tier AS tier, r.via_hub AS via_hub FROM change_sets cs
           JOIN change_set_reach r ON r.change_set_id = cs.id WHERE r.node_id = ?`,
      )
      .all(nodeId) as (ChangeSetRow & { hop: number; tier: string; via_hub: number })[];
    const found = new Map<string, TouchingChangeSet>();
    for (const r of changed) found.set(r.id, { ...toChangeSet(r), touch: { kind: "changed" } });
    for (const r of reached) {
      if (found.has(r.id)) continue;
      found.set(r.id, {
        ...toChangeSet(r),
        touch: { kind: "reach", hop: r.hop, tier: r.tier, via_hub: r.via_hub === 1 },
      });
    }
    return [...found.values()].sort((a, b) =>
      a.updated_at === b.updated_at ? (a.id < b.id ? -1 : 1) : a.updated_at < b.updated_at ? 1 : -1,
    );
  });
}

function readSpecs<T>(
  cache: TeamCache | undefined,
  table: "team_groups" | "team_views",
  parse: (value: unknown) => T | undefined,
): T[] {
  return read(cache, [], (db) => {
    const out: T[] = [];
    for (const row of db.prepare(`SELECT spec FROM ${table} ORDER BY id`).all() as { spec: string }[]) {
      try {
        const parsed = parse(JSON.parse(row.spec));
        if (parsed !== undefined) out.push(parsed);
      } catch {
        // a row that does not parse is skipped
      }
    }
    return out;
  });
}

/** The team's groups; a row that does not parse with `GroupSchema` is skipped. */
export function readTeamGroups(cache: TeamCache | undefined): Group[] {
  return readSpecs(cache, "team_groups", (v) => {
    const parsed = GroupSchema.safeParse(v);
    return parsed.success ? parsed.data : undefined;
  });
}

/** The team's saved views; a row that does not parse with `SavedViewSchema` is skipped. */
export function readTeamViews(cache: TeamCache | undefined): SavedView[] {
  return readSpecs(cache, "team_views", (v) => {
    const parsed = SavedViewSchema.safeParse(v);
    return parsed.success ? parsed.data : undefined;
  });
}

/** Seconds since the last successful pull (a 304 counts), or `undefined` when there has been none. */
export function cacheAgeSeconds(cache: TeamCache | undefined, now: number = Date.now()): number | undefined {
  return read<number | undefined>(cache, undefined, (db) => {
    const at = getMeta(db, "pulled_at");
    const ms = at === undefined ? Number.NaN : Date.parse(at);
    return Number.isNaN(ms) ? undefined : Math.max(0, Math.round((now - ms) / 1000));
  });
}

/** What `gantry team status` shows: how many change sets, when they were pulled, and the last pull's error. */
export interface TeamCacheSummary {
  change_sets: number;
  pulled_at: string | null;
  age_s: number | null;
  last_error: string | null;
}

export function readCacheSummary(cache: TeamCache | undefined, now: number = Date.now()): TeamCacheSummary {
  const empty: TeamCacheSummary = { change_sets: 0, pulled_at: null, age_s: null, last_error: null };
  return read(cache, empty, (db) => ({
    change_sets: countChangeSets(db),
    pulled_at: getMeta(db, "pulled_at") ?? null,
    age_s: cacheAgeSeconds(cache, now) ?? null,
    last_error: getMeta(db, "last_error") ?? null,
  }));
}
