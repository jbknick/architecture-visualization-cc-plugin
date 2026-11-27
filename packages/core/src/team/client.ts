import {
  buildPath,
  DeviceCodeResponseSchema,
  DeviceTokenResponseSchema,
  ErrorSchema,
  encodeTarget,
  HEADER_ORG,
  HEADER_PART_COUNT,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_MAX,
  HEADER_TARGET,
  HEADER_TRUNCATED,
  PROTOCOL_VERSION,
  ROUTES,
} from "@gantry/protocol";
import type { z } from "zod";
import type { GantryConfig } from "../config/index.js";
import { normalizeServer, resolveTeamSettings } from "../config/team.js";
import { GantryError } from "../errors.js";
import type { GantryPaths } from "../paths/index.js";
import { readCredential } from "./credentials.js";

// This module is the only place that calls `fetch` for a team server. Nothing under `packages/cli/src/hooks/`
// imports it (a test checks), so no hook ever waits on the network.

const DEFAULT_TIMEOUT_MS = 5000;
const CLIENT_ID = "gantry-cli";

/** The highest protocol version any server answer has named in this process; one cache for every client. */
let learned: number | undefined;
let learning: Promise<void> | undefined;

/** Forgets what the process learned about the server's protocol version. For tests. */
export function resetTeamProtocolCache(): void {
  learned = undefined;
  learning = undefined;
}

export interface TeamClientOptions {
  fetch?: typeof fetch;
  /** Default 5,000 ms. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Use this server instead of `GANTRY_SERVER` or `team.server` (the `--server` option). */
  server?: string;
  /** Use this organisation; `null` sends no `X-Gantry-Org` header at all (a user token before any link exists). */
  org?: string | null;
  /** Use this bearer token; `null` sends none (the server then answers 401, which proves it is reachable). */
  token?: string | null;
}

type RouteKey = keyof typeof ROUTES;
type Answer<K extends RouteKey> = z.output<(typeof ROUTES)[K]["response"]>;

interface CallOptions {
  params?: Record<string, string | number>;
  query?: Record<string, unknown>;
  /** The request object, or a JSON string that is already serialised (it is checked, then sent byte for byte). */
  body?: unknown;
  /** A body that is already bytes (an upload part). */
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  /** `ready()` itself and `whoami` do not wait for the version to be known. */
  skipReady?: boolean;
  /** Called with the status and headers of every answer, before the status is checked. */
  onResponse?: (status: number, headers: Headers) => void;
  /** Answer `undefined` (instead of throwing) for a 304 with no body. */
  allowNotModified?: boolean;
}

export type DeviceTokenAnswer =
  | { status: "approved"; accessToken: string; expiresIn: number }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" };

export type PullPage =
  | { notModified: true }
  | {
      notModified: false;
      page: z.output<typeof ROUTES.pull.response>;
      etag: string | undefined;
      truncated: boolean;
    };

export type DeviceCode = z.output<typeof DeviceCodeResponseSchema>;

/** The single `fetch` wrapper: a failure to connect, or a timeout, is `team_unreachable`. */
async function exchange(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; headers: Headers; text: string }> {
  try {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch {
    throw new GantryError("team_unreachable", `Cannot reach ${new URL(url).origin}.`);
  }
}

function learnFrom(headers: Headers): void {
  const max = Number(headers.get(HEADER_PROTOCOL_MAX));
  if (Number.isInteger(max) && max >= 1) learned = max;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Maps a non-2xx answer to a `GantryError` (spec section 20, "Errors"). */
function failure(status: number, text: string): GantryError {
  const body = ErrorSchema.safeParse(parseJson(text));
  const message = body.success ? body.data.message : `The server answered ${status}.`;
  const answer = { status, ...(body.success ? { error: body.data.error } : {}) };
  if (status === 401) return new GantryError("team_unauthorized", message, answer);
  if (status === 403) return new GantryError("team_forbidden", message, answer);
  if (status === 400 && body.success && body.data.error === "protocol_version") {
    return new GantryError("team_protocol", message, answer);
  }
  return new GantryError("team_rejected", message, answer);
}

/**
 * A typed client for a team server, built from `ROUTES` in `@gantry/protocol`. Settings come from the config's
 * `team` block, overridden by `GANTRY_SERVER`, `GANTRY_ORG` and `GANTRY_TOKEN` (and by `opts`). A user's token comes
 * from the credentials file, unless `GANTRY_TOKEN` is set, in which case the file is not read.
 */
export function teamClient(paths: GantryPaths, config: GantryConfig, opts: TeamClientOptions = {}) {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settings = resolveTeamSettings(config, env);
  const server = opts.server === undefined ? settings.server : normalizeServer(opts.server);
  if (server === undefined) {
    throw new GantryError("team_config", "No server. Pass --server or run gantry team link first.");
  }
  const org = opts.org === null ? undefined : (opts.org ?? settings.org);
  const token =
    opts.token === null ? undefined : (opts.token ?? settings.token ?? readCredential(server, env)?.token);

  const serverProtocol = (): number => learned ?? 1;

  async function call<K extends RouteKey>(key: K, o: CallOptions = {}): Promise<Answer<K>> {
    if (o.skipReady !== true && key !== "whoami") await ready();
    const route = ROUTES[key];
    let url = `${server}${buildPath(route, o.params)}`;
    if (route.query !== null) {
      const query = route.query.parse(o.query ?? {}) as Record<string, unknown>;
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) search.set(k, String(v));
      const qs = search.toString();
      if (qs !== "") url += `?${qs}`;
    }
    const headers: Record<string, string> = {
      [HEADER_PROTOCOL]: String(Math.min(PROTOCOL_VERSION, serverProtocol())),
      ...o.headers,
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (org !== undefined && !(token ?? "").startsWith("gct_")) headers[HEADER_ORG] = org;
    let body: string | Uint8Array | undefined;
    if (o.rawBody !== undefined) {
      body = o.rawBody;
    } else if (route.request !== null) {
      if (typeof o.body === "string") {
        route.request.parse(JSON.parse(o.body));
        body = o.body;
      } else {
        body = JSON.stringify(route.request.parse(o.body));
      }
      headers["Content-Type"] = "application/json";
    }
    const res = await exchange(
      doFetch,
      url,
      { method: route.method, headers, ...(body === undefined ? {} : { body: body as RequestInit["body"] }) },
      timeoutMs,
    );
    learnFrom(res.headers);
    o.onResponse?.(res.status, res.headers);
    if (res.status === 304 && o.allowNotModified === true) return undefined as Answer<K>;
    if (res.status < 200 || res.status >= 300) throw failure(res.status, res.text);
    const parsed = route.response.safeParse(parseJson(res.text));
    if (!parsed.success) {
      throw new GantryError("team_rejected", "The server's answer does not match the protocol.");
    }
    return parsed.data as Answer<K>;
  }

  /**
   * Makes sure the server's protocol version is known: the first call in the process, when no response has been
   * read yet, calls `GET /v1/whoami` once; every later call returns at once. Every typed method awaits it first.
   */
  async function ready(): Promise<void> {
    if (learned !== undefined) return;
    learning ??= call("whoami", { skipReady: true })
      .then((who) => {
        learned = who.protocol;
      })
      .finally(() => {
        learning = undefined;
      });
    await learning;
  }

  async function device(path: string, body: Record<string, string>) {
    return exchange(
      doFetch,
      `${server}${path}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      timeoutMs,
    );
  }

  return {
    server,
    org,
    /** Whether a bearer token is available (from `GANTRY_TOKEN`, the credentials file or `opts`). */
    hasToken: token !== undefined,
    /** The repo name the paths carry (the one used in ids). */
    repo: paths.repo,
    ready,
    /** The server's highest protocol version learned so far, or 1 when nothing has been learned yet. */
    serverProtocol,

    whoami: (query: { repo?: string } = {}) => call("whoami", { query, skipReady: true }),
    beginUpload: (repo: string, body: unknown, target: string) =>
      call("beginUpload", { params: { repo }, body, headers: { [HEADER_TARGET]: encodeTarget(target) } }),
    putPart: (id: string, n: number, gzipped: Uint8Array, partCount: number) =>
      call("putPart", {
        params: { id, n },
        rawBody: gzipped,
        headers: {
          "Content-Encoding": "gzip",
          "Content-Type": "application/x-ndjson",
          [HEADER_PART_COUNT]: String(partCount),
        },
      }),
    uploadStatus: (id: string) => call("uploadStatus", { params: { id } }),
    closeChangeSet: (repo: string, id: string, body: unknown) =>
      call("closeChangeSet", { params: { repo, id }, body }),
    pull: (query: { repo: string; cursor?: string }) => call("pull", { query }),
    /**
     * One page of a pull with its `ETag` and `X-Gantry-Truncated` headers. With `etag` the request is conditional
     * (`If-None-Match`, first page only): a 304 answers `{ notModified: true }`.
     */
    async pullPage(query: { repo: string; cursor?: string }, etag?: string): Promise<PullPage> {
      let headers: Headers | undefined;
      const page = await call("pull", {
        query,
        allowNotModified: true,
        ...(etag === undefined ? {} : { headers: { "If-None-Match": etag } }),
        onResponse: (_status, h) => {
          headers = h;
        },
      });
      if (page === undefined) return { notModified: true };
      return {
        notModified: false,
        page,
        etag: headers?.get("etag") ?? undefined,
        truncated: headers?.get(HEADER_TRUNCATED) === "true",
      };
    },
    putDescriptions: (body: unknown) => call("putDescriptions", { body }),
    putGroup: (repo: string, id: string, body: unknown) => call("putGroup", { params: { repo, id }, body }),
    deleteGroup: (repo: string, id: string) => call("deleteGroup", { params: { repo, id } }),
    putView: (repo: string, id: string, body: unknown) => call("putView", { params: { repo, id }, body }),
    deleteView: (repo: string, id: string) => call("deleteView", { params: { repo, id } }),

    /** Starts a device sign-in (`POST /api/auth/device/code`, client id `gantry-cli`, no scope). */
    async deviceCode(): Promise<DeviceCode> {
      const res = await device("/api/auth/device/code", { client_id: CLIENT_ID });
      const parsed = DeviceCodeResponseSchema.safeParse(res.status === 200 ? parseJson(res.text) : undefined);
      if (!parsed.success)
        throw new GantryError("team_rejected", `The server did not start a sign-in (${res.status}).`);
      return parsed.data;
    },
    /** One poll of `POST /api/auth/device/token`. */
    async deviceToken(deviceCode: string): Promise<DeviceTokenAnswer> {
      const res = await device("/api/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLIENT_ID,
      });
      if (res.status === 200) {
        const parsed = DeviceTokenResponseSchema.safeParse(parseJson(res.text));
        if (!parsed.success)
          throw new GantryError("team_rejected", "The server's token answer is not valid.");
        return {
          status: "approved",
          accessToken: parsed.data.access_token,
          expiresIn: parsed.data.expires_in,
        };
      }
      const error = (parseJson(res.text) as { error?: unknown } | undefined)?.error;
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") return { status: "slow_down" };
      if (error === "access_denied") return { status: "denied" };
      if (error === "expired_token") return { status: "expired" };
      throw new GantryError("team_rejected", `The server refused the sign-in (${res.status}).`);
    },
  };
}

export type TeamClient = ReturnType<typeof teamClient>;
