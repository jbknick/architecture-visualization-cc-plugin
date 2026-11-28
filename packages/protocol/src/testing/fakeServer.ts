import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { decodeTarget, parseChangeSetId } from "../ids.js";
import { DEFAULT_PART_LIMITS, decodePart, type PartLimits } from "../parts.js";
import {
  HEADER_ORG,
  HEADER_PART_COUNT,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_MAX,
  HEADER_TARGET,
  HEADER_TRUNCATED,
  PROTOCOL_VERSION,
  ROUTES,
  type RouteDef,
} from "../routes.js";
import {
  type ChangeSet,
  ChangeSetSchema,
  type Description,
  type ErrorCode,
  type Group,
  LIMITS,
  type MainSnapshot,
  MainSnapshotSchema,
  type PartRecord,
  type SavedView,
  type UploadStart,
} from "../schemas.js";

/**
 * An in-memory server that implements every route of the protocol, for client tests with no network beyond
 * 127.0.0.1. It validates requests with the request schemas, so a client that sends a wrong body fails here as it
 * would against a real server.
 *
 * Differences from a real server: a part is read when it arrives, and one that is not valid (not gzip, a record
 * with an unknown key, a wrong header record) is refused at once with 400 `invalid` and not recorded. An upload
 * becomes `done` on the first status read after every part has arrived, or `failed` when its counts differ.
 */

export interface FakeServerOptions {
  /** Accepted bearer tokens. A token that starts with `gct_` is a CI token, any other is a user token. */
  tokens?: string[];
  /** The organisation slug (default `acme`). A user token must send it as `X-Gantry-Org`. */
  org?: string;
  /** The repo a CI token is for (default `fixture/pnpm-turbo`). */
  repo?: string;
  /** The role of the signed-in user (default `owner`). */
  role?: "owner" | "admin" | "member";
  /** The value of `X-Gantry-Protocol-Max` (default `PROTOCOL_VERSION`). */
  protocolMax?: number;
  /** Answer 409 `budget` for a `main` part. */
  budgetExhausted?: boolean;
  /** The limits the begin response gives (defaults: 2,000 records, 1 MiB, 1,000 parts). */
  limits?: Partial<PartLimits & { max_parts: number }>;
  /** Change sets per pull page (default: all on one page). */
  pageSize?: number;
  /** Wait this long before answering `GET /v1/pull` (default 0), to stand in for a server that hangs. */
  pullDelayMs?: number;
  /** Wait this long before answering `POST /v1/descriptions/lookup` (default 0), to stand in for a server that hangs. */
  lookupDelayMs?: number;
}

export interface FakeUpload {
  id: string;
  repo: string;
  /** `main` or a change set id (decoded). */
  target: string;
  start: UploadStart;
  status: "queued" | "loading" | "done" | "failed" | "superseded";
  error?: string;
  partCount?: number;
  /** The records of each part that arrived and was read. */
  parts: Map<number, PartRecord[]>;
  bytes: number;
}

export interface FakeState {
  uploads: Map<string, FakeUpload>;
  /** The latest finished main snapshot per repo. */
  snapshots: Map<string, MainSnapshot>;
  changeSets: Map<string, ChangeSet>;
  /** By content key. */
  descriptions: Map<string, Description>;
  /** By repo, then id. */
  views: Map<string, Map<string, SavedView>>;
  groups: Map<string, Map<string, Group>>;
  closed: { id: string; repo: string; merged: boolean; head_sha?: string }[];
  /** Approves a pending device sign-in by its user code; false when there is none. */
  approveDevice(userCode: string): boolean;
}

export interface FakeServer {
  url: string;
  close(): Promise<void>;
  state: FakeState;
}

const FINAL = new Set(["done", "failed", "superseded"]);
const MAIN_TAGS = { w: "workspaces", f: "files", s: "symbols", e: "edges", a: "adapter_nodes" } as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const sortBy = <T>(items: T[], key: (item: T) => string): T[] =>
  [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

export async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const tokens = new Set(opts.tokens ?? ["gct_fake", "fake-user"]);
  const org = opts.org ?? "acme";
  const ciRepo = opts.repo ?? "fixture/pnpm-turbo";
  const role = opts.role ?? "owner";
  const protocolMax = opts.protocolMax ?? PROTOCOL_VERSION;
  const limits = {
    part_max_records: opts.limits?.part_max_records ?? DEFAULT_PART_LIMITS.part_max_records,
    part_max_bytes: opts.limits?.part_max_bytes ?? DEFAULT_PART_LIMITS.part_max_bytes,
    max_parts: opts.limits?.max_parts ?? 1000,
  };
  const devices = new Map<string, { userCode: string; approved: boolean }>();
  const state: FakeState = {
    uploads: new Map(),
    snapshots: new Map(),
    changeSets: new Map(),
    descriptions: new Map(),
    views: new Map(),
    groups: new Map(),
    closed: [],
    approveDevice(userCode) {
      for (const d of devices.values()) {
        if (d.userCode === userCode) {
          d.approved = true;
          return true;
        }
      }
      return false;
    },
  };

  const send = (
    res: ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ): void => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(text);
  };

  /** Makes a finished upload visible; returns why it failed, or undefined. */
  function loadUpload(upload: FakeUpload): string | undefined {
    const records = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, r]) => r);
    if (upload.start.kind === "main") {
      const counts = { workspaces: 0, files: 0, symbols: 0, edges: 0, adapter_nodes: 0 };
      const snapshot: Record<string, unknown[]> = {
        workspaces: [],
        files: [],
        symbols: [],
        edges: [],
        adapter_nodes: [],
      };
      for (const record of records) {
        const section = MAIN_TAGS[record.t as keyof typeof MAIN_TAGS];
        if (section === undefined) return `record ${record.t} does not belong in a main upload`;
        const { t: _t, ...rest } = record;
        snapshot[section]?.push(rest);
        counts[section] += 1;
      }
      const expected = upload.start.counts;
      if ((Object.keys(counts) as (keyof typeof counts)[]).some((k) => counts[k] !== expected[k]))
        return "counts differ";
      const parsed = MainSnapshotSchema.safeParse({ repo: upload.repo, sha: upload.start.sha, ...snapshot });
      if (!parsed.success) return `invalid: ${parsed.error.issues[0]?.message ?? "snapshot"}`;
      state.snapshots.set(upload.repo, parsed.data);
    } else {
      const headers = records.filter((r) => r.t === "c");
      if (headers.length === 0) return "change set header missing";
      if (headers.length > 1) return "change set header repeated";
      const nodes = records.flatMap((r) => (r.t === "n" ? [r.id] : []));
      const radius = records.flatMap((r) => {
        if (r.t !== "r") return [];
        const { t: _t, ...rest } = r;
        return [rest];
      });
      if (nodes.length !== upload.start.counts.nodes || radius.length !== upload.start.counts.radius) {
        return "counts differ";
      }
      const header = headers[0];
      if (header?.t !== "c") return "change set header missing";
      const { t: _t, ...rest } = header;
      const parsed = ChangeSetSchema.safeParse({ ...rest, repo: upload.repo, nodes, radius });
      if (!parsed.success) return `invalid: ${parsed.error.issues[0]?.message ?? "change set"}`;
      state.changeSets.set(parsed.data.id, parsed.data);
    }
    return undefined;
  }

  function finalise(upload: FakeUpload): void {
    const error = loadUpload(upload);
    if (error === undefined) upload.status = "done";
    else {
      upload.status = "failed";
      upload.error = error.slice(0, LIMITS.message);
    }
  }

  /** Reads a part when it arrives. A part that is not valid is refused with 400 and not recorded. */
  function readPart(upload: FakeUpload, n: number, body: Buffer): void {
    const refuse = (message: string): never => {
      throw new HttpError(400, "invalid", `part ${n}: ${message}`.slice(0, LIMITS.message));
    };
    let records: PartRecord[] = [];
    try {
      records = decodePart(body, limits.part_max_bytes, upload.start.kind);
    } catch (err) {
      refuse(err instanceof Error ? err.message : "invalid");
    }
    if (records.length > limits.part_max_records) refuse("too many records");
    records.forEach((record, i) => {
      if (record.t === "c") {
        if (upload.start.kind === "main") refuse("a change set header in a main upload");
        if (n !== 1 || i !== 0) refuse("the change set header must be the first line of part 1");
        if (record.id !== upload.target) refuse("target mismatch");
      } else if (i === 0 && n === 1 && upload.start.kind === "change_set") {
        refuse("part 1 of a change set must start with its header");
      }
    });
    upload.parts.set(n, records);
  }

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  function matchRoute(method: string, segments: string[]) {
    for (const [key, route] of Object.entries(ROUTES) as [keyof typeof ROUTES, RouteDef][]) {
      if (route.method !== method) continue;
      const template = route.path.split("/").slice(1);
      if (template.length !== segments.length) continue;
      const params: Record<string, string> = {};
      const ok = template.every((part, i) => {
        const segment = segments[i] as string;
        if (part.startsWith(":")) {
          params[part.slice(1)] = segment;
          return true;
        }
        return part === segment;
      });
      if (ok) return { key, route, params };
    }
    return undefined;
  }

  function jsonBody(route: RouteDef, req: IncomingMessage, raw: Buffer): unknown {
    if (route.request === null) return undefined;
    let text: string;
    try {
      text = (req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
    } catch {
      throw new HttpError(400, "invalid", "the body is not valid gzip");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new HttpError(400, "invalid", "the body is not JSON");
    }
    const parsed = route.request.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(
        400,
        "invalid",
        `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`.slice(0, 500),
      );
    }
    return parsed.data;
  }

  const collection = <T>(map: Map<string, Map<string, T>>, repo: string): Map<string, T> => {
    let inner = map.get(repo);
    if (inner === undefined) {
      inner = new Map();
      map.set(repo, inner);
    }
    return inner;
  };

  function saveItem<T extends { id: string }>(
    map: Map<string, Map<string, T>>,
    repo: string,
    id: string,
    item: T,
    limit: number,
    noun: string,
  ): void {
    if (item.id !== id) throw new HttpError(400, "invalid", "the body id differs from the path id");
    const items = collection(map, repo);
    if (!items.has(id) && items.size >= limit)
      throw new HttpError(400, "invalid", `the repo already has ${limit} ${noun}`);
    if (Buffer.byteLength(JSON.stringify(item)) > LIMITS.item_bytes)
      throw new HttpError(400, "invalid", `the ${noun} is too large`);
    items.set(id, item);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const raw = await readBody(req);
    let segments: string[];
    try {
      segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, "invalid", "a path parameter is not valid percent-encoding");
    }

    if (url.pathname === "/api/auth/device/code" && req.method === "POST") {
      const deviceCode = randomBytes(16).toString("hex");
      const userCode = randomBytes(4).toString("hex").toUpperCase();
      devices.set(deviceCode, { userCode, approved: false });
      const verification = `http://127.0.0.1/device`;
      return send(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verification,
        verification_uri_complete: `${verification}?user_code=${userCode}`,
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.pathname === "/api/auth/device/token" && req.method === "POST") {
      let body: { device_code?: unknown } = {};
      try {
        body = JSON.parse(raw.toString("utf8")) as typeof body;
      } catch {
        // an empty or invalid body falls through to invalid_grant
      }
      const device = typeof body.device_code === "string" ? devices.get(body.device_code) : undefined;
      if (device === undefined) return send(res, 400, { error: "invalid_grant" });
      if (!device.approved) return send(res, 400, { error: "authorization_pending" });
      let token = [...tokens].find((t) => !t.startsWith("gct_"));
      if (token === undefined) {
        token = `fake-user-${randomBytes(8).toString("hex")}`;
        tokens.add(token);
      }
      return send(res, 200, { access_token: token, token_type: "Bearer", expires_in: 604_800 });
    }

    const matched = matchRoute(req.method ?? "GET", segments);
    if (matched === undefined) throw new HttpError(404, "not_found", "no such route");
    const { key, route: def, params } = matched;

    const version = Number(req.headers[HEADER_PROTOCOL.toLowerCase()]);
    if (!Number.isInteger(version) || version < 1 || version > protocolMax) {
      throw new HttpError(
        400,
        "protocol_version",
        `${HEADER_PROTOCOL} must be an integer from 1 to ${protocolMax}`,
      );
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (bearer === undefined || !tokens.has(bearer))
      throw new HttpError(401, "unauthorized", "unknown token");
    const kind = bearer.startsWith("gct_") ? "ci" : "user";
    const orgHeader = req.headers[HEADER_ORG.toLowerCase()];
    if (kind === "user" && key !== "whoami") {
      if (typeof orgHeader !== "string") throw new HttpError(400, "invalid", `${HEADER_ORG} is required`);
    }
    if (kind === "user" && typeof orgHeader === "string" && orgHeader !== org) {
      throw new HttpError(403, "forbidden", "not a member of that organisation");
    }
    if (!(def.auth as readonly string[]).includes(kind))
      throw new HttpError(403, "forbidden", "this token cannot use this route");
    if (kind === "ci" && params.repo !== undefined && params.repo !== ciRepo) {
      throw new HttpError(403, "forbidden", "a CI token is for one repo");
    }

    let q: { repo?: string; cursor?: string } = {};
    if (def.query !== null) {
      const parsedQuery = def.query.safeParse(Object.fromEntries(url.searchParams));
      if (!parsedQuery.success) throw new HttpError(400, "invalid", "bad query");
      q = parsedQuery.data as typeof q;
    }
    const body = jsonBody(def, req, raw) as never;
    const upload = (): FakeUpload => {
      const found = state.uploads.get(params.id ?? "");
      if (found === undefined || found.repo !== ciRepo)
        throw new HttpError(404, "not_found", "no such upload");
      return found;
    };
    const repo = params.repo ?? "";

    switch (key) {
      case "whoami": {
        if (kind === "ci") {
          return send(res, 200, {
            kind: "ci",
            org,
            repo: ciRepo,
            repo_connected: true,
            protocol: protocolMax,
          });
        }
        if (typeof orgHeader !== "string") {
          return send(res, 200, {
            kind: "user",
            user: "octo-dev",
            repo_connected: false,
            protocol: protocolMax,
          });
        }
        return send(res, 200, {
          kind: "user",
          user: "octo-dev",
          org,
          role,
          ...(q.repo === undefined ? {} : { repo: q.repo }),
          repo_connected: q.repo === ciRepo,
          protocol: protocolMax,
        });
      }
      case "beginUpload": {
        const start = body as UploadStart;
        const header = req.headers[HEADER_TARGET.toLowerCase()];
        if (typeof header !== "string") throw new HttpError(400, "invalid", `${HEADER_TARGET} is required`);
        let target: string;
        try {
          target = decodeTarget(header);
        } catch {
          throw new HttpError(400, "invalid", `${HEADER_TARGET} is not valid percent-encoding`);
        }
        if (start.kind === "main" && target !== "main")
          throw new HttpError(400, "invalid", "a main upload targets main");
        if (start.kind === "change_set" && parseChangeSetId(target)?.repo !== repo) {
          throw new HttpError(400, "invalid", "the target is not a change set id of this repo");
        }
        for (const older of state.uploads.values()) {
          if (older.repo === repo && older.target === target && !FINAL.has(older.status))
            older.status = "superseded";
        }
        const id = randomBytes(12).toString("hex");
        state.uploads.set(id, {
          id,
          repo,
          target,
          start,
          status: "queued",
          parts: new Map(),
          bytes: 0,
        });
        return send(res, 202, { upload_id: id, ...limits });
      }
      case "putPart": {
        const found = upload();
        const n = Number(params.n);
        const count = Number(req.headers[HEADER_PART_COUNT.toLowerCase()]);
        if (!Number.isInteger(count) || count < 1 || count > limits.max_parts) {
          throw new HttpError(
            400,
            "invalid",
            `${HEADER_PART_COUNT} must be an integer from 1 to ${limits.max_parts}`,
          );
        }
        if (found.partCount !== undefined && found.partCount !== count) {
          throw new HttpError(400, "invalid", `${HEADER_PART_COUNT} differs from the first part's`);
        }
        if (!Number.isInteger(n) || n < 1 || n > count)
          throw new HttpError(400, "invalid", "the part number is out of range");
        if (req.headers["content-encoding"] !== "gzip")
          throw new HttpError(400, "invalid", "Content-Encoding must be gzip");
        if (FINAL.has(found.status)) throw new HttpError(409, "conflict", `the upload is ${found.status}`);
        if (opts.budgetExhausted === true && found.start.kind === "main") {
          throw new HttpError(409, "budget", "the daily upload capacity is used; try later");
        }
        if (found.parts.has(n)) return send(res, 200, { upload_id: found.id, part: n, status: "done" });
        if (raw.length > limits.part_max_bytes || found.bytes + raw.length > LIMITS.upload_gzip_bytes) {
          throw new HttpError(413, "too_large", "the part is over a size limit");
        }
        readPart(found, n, raw);
        found.partCount = count;
        found.bytes += raw.length;
        found.status = "loading";
        return send(res, 202, { upload_id: found.id, part: n, status: "queued" });
      }
      case "uploadStatus": {
        const found = upload();
        if (
          (found.status === "queued" || found.status === "loading") &&
          found.partCount !== undefined &&
          found.parts.size === found.partCount
        ) {
          finalise(found);
        }
        return send(res, 200, {
          status: found.status,
          ...(found.error === undefined ? {} : { error: found.error }),
          parts: {
            total: found.partCount ?? 0,
            received: found.parts.size,
            done: found.parts.size,
            failed: 0,
          },
        });
      }
      case "closeChangeSet": {
        const close = body as { merged: boolean; head_sha?: string };
        const existing = state.changeSets.get(params.id ?? "");
        if (existing === undefined || existing.repo !== repo) return send(res, 200, { closed: false });
        state.closed.push({
          id: existing.id,
          repo,
          merged: close.merged,
          ...(close.head_sha === undefined ? {} : { head_sha: close.head_sha }),
        });
        if (close.merged) state.changeSets.set(existing.id, { ...existing, state: "merged" });
        else state.changeSets.delete(existing.id);
        return send(res, 200, { closed: true });
      }
      case "pull": {
        if (q.repo === undefined) throw new HttpError(400, "invalid", "repo is required");
        if (kind === "ci" && q.repo !== ciRepo)
          throw new HttpError(403, "forbidden", "a CI token is for one repo");
        if (opts.pullDelayMs !== undefined && opts.pullDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, opts.pullDelayMs));
        }
        const open = sortBy(
          [...state.changeSets.values()].filter((c) => c.repo === q.repo && c.state !== "merged"),
          (c) => c.id,
        ).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
        const cut = open.length > LIMITS.pull_change_sets;
        const all = open.slice(0, LIMITS.pull_change_sets);
        const views = [...(state.views.get(q.repo)?.values() ?? [])];
        const groups = [...(state.groups.get(q.repo)?.values() ?? [])];
        // The ETag hashes the ordered (id, updated_at) of every change set the whole pull returns, plus the views,
        // groups and settings, so every page carries the same one and `pulled_at` is not part of it.
        const etag = `"${createHash("sha256")
          .update(JSON.stringify([all.map((c) => [c.id, c.updated_at]), views, groups, {}]))
          .digest("hex")}"`;
        if (q.cursor === undefined && req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag });
          return void res.end();
        }
        // A cursor is `<offset>.<list>`, where `<list>` identifies the change set list of page 1. A later page whose
        // list differs from the one the cursor was made for answers 409 `conflict`.
        const list = createHash("sha256")
          .update(JSON.stringify(all.map((c) => [c.id, c.updated_at])))
          .digest("hex")
          .slice(0, 16);
        const [offsetText, cursorList] = (q.cursor ?? "0.").split(".");
        const offset = Number(offsetText);
        if (!Number.isInteger(offset) || offset < 0 || cursorList === undefined)
          throw new HttpError(400, "invalid", "bad cursor");
        if (q.cursor !== undefined && cursorList !== list)
          throw new HttpError(409, "conflict", "the change set list changed since page 1");
        const size = opts.pageSize ?? Math.max(all.length, 1);
        const page = all.slice(offset, offset + size);
        const next = offset + size < all.length ? `${offset + size}.${list}` : undefined;
        return send(
          res,
          200,
          {
            change_sets: page,
            team_views: offset === 0 ? views : [],
            groups: offset === 0 ? groups : [],
            settings: {},
            ...(next === undefined ? {} : { next_cursor: next }),
            pulled_at: new Date().toISOString(),
          },
          { etag, ...(cut && next === undefined ? { [HEADER_TRUNCATED]: "true" } : {}) },
        );
      }
      case "putDescriptions": {
        let stored = 0;
        for (const d of (body as { descriptions: Description[] }).descriptions) {
          const existing = state.descriptions.get(d.content_key);
          if (existing === undefined || (existing.provenance === "fallback" && d.provenance === "model")) {
            state.descriptions.set(d.content_key, d);
            stored += 1;
          }
        }
        return send(res, 200, { stored });
      }
      case "lookupDescriptions": {
        // A server below version 2 does not have this route.
        if (protocolMax < 2) throw new HttpError(404, "not_found", "no such route");
        if (opts.lookupDelayMs !== undefined && opts.lookupDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, opts.lookupDelayMs));
        }
        const found: Description[] = [];
        for (const k of (body as { content_keys: string[] }).content_keys) {
          const d = state.descriptions.get(k);
          if (d !== undefined) found.push(d);
        }
        return send(res, 200, { descriptions: found });
      }
      case "putGroup":
        saveItem(state.groups, repo, params.id ?? "", body as Group, LIMITS.groups_per_repo, "groups");
        return send(res, 200, { saved: true });
      case "putView":
        saveItem(state.views, repo, params.id ?? "", body as SavedView, LIMITS.views_per_repo, "views");
        return send(res, 200, { saved: true });
      case "deleteGroup": {
        if (role === "member")
          throw new HttpError(403, "forbidden", "only an owner or admin may delete a group");
        return send(res, 200, { deleted: collection(state.groups, repo).delete(params.id ?? "") });
      }
      case "deleteView":
        return send(res, 200, { deleted: collection(state.views, repo).delete(params.id ?? "") });
    }
  }

  const server = createServer((req, res) => {
    res.setHeader(HEADER_PROTOCOL_MAX, String(protocolMax));
    route(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message });
      return send(res, 500, { error: "invalid", message: err instanceof Error ? err.message : "error" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      }),
  };
}
