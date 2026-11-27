import fs from "node:fs";
import { ContentKeySchema, type Description, LIMITS, RepoSchema, supports } from "@gantry/protocol";
import type { GantryConfig } from "../config/index.js";
import { readFileSource } from "../describe/backlog.js";
import { buildFactSheet, contentKey, FUNCTION_LIKE_KINDS, PROMPT_MAJOR } from "../describe/factsheet.js";
import { type AcceptedDescription, storeDescriptions } from "../describe/store.js";
import { validateDescription } from "../describe/validate.js";
import { isSensitive } from "../discover/index.js";
import { pathOfFileId } from "../ids.js";
import type { GantryPaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import { resetStaleStore } from "../store/stale.js";
import type { SymbolRecord } from "../types.js";
import { teamClient } from "./client.js";
import { resolveTeamTarget } from "./resolve.js";

/**
 * Fills in the descriptions this machine lacks from the ones the team already has (spec section 11): a function whose
 * content key has no local description is looked up by key, and what comes back is checked like any description a
 * model wrote here before it is stored. This is a download only; what is uploaded is governed by
 * `team.upload.descriptions`. The text is untrusted wherever it goes: it is stored as text and shown only through the
 * `untrusted_description` fields, and nothing here executes or renders it. The request carries the repo name and
 * content keys, never source or signatures. No hook imports this file: hooks never contact a server.
 */

/** The route key `FIELD_SINCE` knows the lookup by. */
export const LOOKUP_KEY = "POST /v1/descriptions/lookup";
export const LOOKUP_UNSUPPORTED = "server does not support description lookup";

/** The part of the team client this module needs. */
export interface DescriptionLookupClient {
  ready(): Promise<void>;
  serverProtocol(): number;
  lookupDescriptions(body: unknown): Promise<{ descriptions: Description[] }>;
}

export interface DescriptionSyncOptions {
  /** Ask about at most this many functions (default: all of them). */
  limit?: number;
  /** Stop after this long and reject; what was filled before stays (default: no limit beyond the client's own). */
  timeoutMs?: number;
  /** Receives one line for a condition that is not an error, such as a server without the route. */
  log?: (line: string) => void;
}

export interface DescriptionSyncResult {
  /** Functions without a local description that were asked about, one per content key. */
  asked: number;
  /** Functions that now have a description from the team. */
  filled: number;
}

/** The function-like symbols with no description row, one per content key, in symbol id order. */
function undescribed(store: Store): Map<string, SymbolRecord> {
  const have = new Set(
    (store.db.prepare("SELECT content_key FROM descriptions").all() as { content_key: string }[]).map(
      (r) => r.content_key,
    ),
  );
  const out = new Map<string, SymbolRecord>();
  const symbols = store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] });
  for (const sym of [...symbols].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (sym.exactHash === "" || isSensitive(pathOfFileId(sym.fileId))) continue;
    const key = contentKey(sym.exactHash);
    // A key the wire format would refuse is not asked about: one odd hash must not fail the whole request.
    if (!have.has(key) && !out.has(key) && ContentKeySchema.safeParse(key).success) out.set(key, sym);
  }
  return out;
}

function timer(ms: number | undefined): { expired: Promise<never>; cancel(): void } {
  if (ms === undefined) return { expired: new Promise<never>(() => {}), cancel() {} };
  let handle: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`description sync timed out after ${ms} ms`)), ms);
  });
  expired.catch(() => {});
  return { expired, cancel: () => clearTimeout(handle) };
}

/** Looks up one record's function and accepts the record only when it passes the local validation. */
function accept(
  store: Store,
  record: Description,
  sym: SymbolRecord,
  files: Map<string, string | undefined>,
): AcceptedDescription | undefined {
  if (record.prompt_version !== PROMPT_MAJOR || record.content_key !== contentKey(sym.exactHash))
    return undefined;
  if (!files.has(sym.fileId)) files.set(sym.fileId, readFileSource(store, sym.fileId, {}));
  const source = files.get(sym.fileId);
  if (source === undefined) return undefined;
  let sheet: ReturnType<typeof buildFactSheet>;
  try {
    sheet = buildFactSheet(store, sym.id, source);
  } catch {
    return undefined;
  }
  const checked = validateDescription(
    {
      behavior: record.behavior,
      searchTerms: record.search_terms,
      nameFits: record.name_fits,
      ...(record.suggested_name === undefined ? {} : { suggestedName: record.suggested_name }),
    },
    sheet,
  );
  if (!checked.ok) return undefined;
  return {
    contentKey: record.content_key,
    description: checked.value,
    model: record.model,
    provenance: record.provenance,
    createdAt: record.created_at,
  };
}

/**
 * Asks the team for the descriptions of the functions that have none here, in batches of 500 keys, and stores the
 * ones that pass `validateDescription` and carry this prompt version. A local description is never overwritten.
 * A server below protocol 2, or one that answers 404 or 405 for the route, gives `filled: 0` and a log line, and a
 * server error rejects with the store as it was after the batches before it.
 */
export async function syncDescriptions(
  store: Store,
  client: DescriptionLookupClient,
  repo: string,
  opts: DescriptionSyncOptions = {},
): Promise<DescriptionSyncResult> {
  const wanted = undescribed(store);
  const keys = [...wanted.keys()].slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
  const asked = keys.length;
  if (asked === 0) return { asked, filled: 0 };
  const clock = timer(opts.timeoutMs);
  const unsupported = (): DescriptionSyncResult => {
    opts.log?.(LOOKUP_UNSUPPORTED);
    return { asked, filled: 0 };
  };
  try {
    await Promise.race([client.ready(), clock.expired]);
    if (!supports(client.serverProtocol(), LOOKUP_KEY)) return unsupported();
    const files = new Map<string, string | undefined>();
    let filled = 0;
    for (let i = 0; i < keys.length; i += LIMITS.descriptions) {
      const batch = keys.slice(i, i + LIMITS.descriptions);
      let answer: { descriptions: Description[] };
      try {
        answer = await Promise.race([
          client.lookupDescriptions({ repo, content_keys: batch }),
          clock.expired,
        ]);
      } catch (err) {
        const status = (err as { answer?: { status?: number } }).answer?.status;
        if (status === 404 || status === 405) return unsupported();
        throw err;
      }
      const asking = new Set(batch);
      const accepted: AcceptedDescription[] = [];
      const seen = new Set<string>();
      for (const record of answer.descriptions) {
        // The server is not trusted: a record for a key that was not asked, or a repeat, is ignored.
        if (!asking.has(record.content_key) || seen.has(record.content_key)) continue;
        seen.add(record.content_key);
        const sym = wanted.get(record.content_key);
        const ok = sym === undefined ? undefined : accept(store, record, sym, files);
        if (ok !== undefined) accepted.push(ok);
      }
      filled += storeDescriptions(store, accepted);
    }
    return { asked, filled };
  } finally {
    clock.cancel();
  }
}

export interface TeamSyncOptions {
  env: NodeJS.ProcessEnv;
  /** For tests: the fetch the client uses. */
  fetch?: typeof fetch;
  limit?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * What a run of the sync did. `not_linked`: no server, organisation or token, or a repo with no `owner/name` name (nothing was sent). `ci_token`: the token
 * is a CI token, which cannot read descriptions (nothing was sent). `done`: the counts of `syncDescriptions`; with no
 * local index yet there is nothing to ask about and no request is made.
 */
export type TeamSyncOutcome =
  | { status: "not_linked" }
  | { status: "ci_token" }
  | ({ status: "done" } & DescriptionSyncResult);

/**
 * The sync for this checkout: resolves the team from the config and the environment, opens the local index and runs
 * `syncDescriptions`. It is what `gantry team sync-descriptions` and the MCP server's start-up call, and the one
 * place that joins the team settings, the client and the store for it. Errors from the server reject.
 */
export async function syncTeamDescriptions(
  paths: GantryPaths,
  config: GantryConfig,
  o: TeamSyncOptions,
): Promise<TeamSyncOutcome> {
  const target = resolveTeamTarget(paths, config, o.env);
  if (target === null || target.token === null) return { status: "not_linked" };
  if (target.token.startsWith("gct_")) return { status: "ci_token" };
  // A repo with no `owner/name` (no GitHub remote) is not one the server can know.
  if (!RepoSchema.safeParse(paths.repo).success) return { status: "not_linked" };
  if (!fs.existsSync(paths.dbPath)) return { status: "done", asked: 0, filled: 0 };
  const client = teamClient(paths, target.config, {
    env: o.env,
    server: target.server,
    org: target.org,
    token: target.token,
    timeoutMs: o.timeoutMs ?? 60_000,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  resetStaleStore(paths);
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  try {
    const result = await syncDescriptions(store, client, paths.repo, {
      ...(o.limit === undefined ? {} : { limit: o.limit }),
      ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
      ...(o.log === undefined ? {} : { log: o.log }),
    });
    return { status: "done", ...result };
  } finally {
    store.close();
  }
}
