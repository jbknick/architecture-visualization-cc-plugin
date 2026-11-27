import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeSetIdForBranch, changeSetIdForPr, encodeTarget } from "../ids.js";
import { changeSetRecords, decodePart, mainSnapshotRecords, splitIntoParts } from "../parts.js";
import {
  buildPath,
  HEADER_ORG,
  HEADER_PART_COUNT,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_MAX,
  HEADER_TARGET,
  PROTOCOL_VERSION,
  ROUTES,
  type RouteDef,
} from "../routes.js";
import {
  CloseRequestSchema,
  ErrorSchema,
  type MainSnapshot,
  type PartRecord,
  type UploadStart,
} from "../schemas.js";
import { type FakeServer, type FakeServerOptions, startFakeServer } from "./fakeServer.js";
import { changeSet, description, group, REPO, SHA, snapshot, view } from "./samples.js";

const CI = "gct_fake";
const USER = "fake-user";
let server: FakeServer;

async function start(opts?: FakeServerOptions): Promise<void> {
  server = await startFakeServer(opts);
}
beforeEach(() => start());
afterEach(() => server.close());

interface Call {
  token?: string | null;
  org?: string;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: Uint8Array;
  protocol?: string | null;
}
async function call(route: RouteDef, params: Record<string, string | number> = {}, c: Call = {}, query = "") {
  const headers: Record<string, string> = { ...c.headers };
  if (c.token !== null) headers.authorization = `Bearer ${c.token ?? CI}`;
  if (c.protocol !== null) headers[HEADER_PROTOCOL] = c.protocol ?? String(PROTOCOL_VERSION);
  if (c.org !== undefined) headers[HEADER_ORG] = c.org;
  let body: string | Uint8Array | undefined;
  if (c.raw !== undefined) body = c.raw;
  else if (c.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(c.body);
  }
  const res = await fetch(`${server.url}${buildPath(route, params)}${query}`, {
    method: route.method,
    headers,
    body,
  });
  const text = await res.text();
  return { res, status: res.status, json: text === "" ? undefined : (JSON.parse(text) as unknown) };
}
const asUser = (c: Call = {}): Call => ({ ...c, token: USER, org: c.org ?? "acme" });

async function begin(start: UploadStart, target = "main", c: Call = {}) {
  return call(
    ROUTES.beginUpload,
    { repo: REPO },
    { ...c, body: start, headers: { [HEADER_TARGET]: encodeTarget(target) } },
  );
}
async function putPart(uploadId: string, n: number, count: number, body: Uint8Array, c: Call = {}) {
  return call(
    ROUTES.putPart,
    { id: uploadId, n },
    {
      ...c,
      raw: body,
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/x-ndjson",
        [HEADER_PART_COUNT]: String(count),
      },
    },
  );
}
const countsOf = (s: MainSnapshot) => ({
  workspaces: s.workspaces.length,
  files: s.files.length,
  symbols: s.symbols.length,
  edges: s.edges.length,
  adapter_nodes: s.adapter_nodes.length,
});
const LIMITS = { part_max_records: 2000, part_max_bytes: 1_048_576 };

/** Sends a whole main snapshot and returns the upload id. */
async function uploadMain(snap = snapshot(), limits = LIMITS): Promise<string> {
  const started = await begin({ kind: "main", sha: SHA, counts: countsOf(snap) });
  const id = (started.json as { upload_id: string }).upload_id;
  const parts = splitIntoParts(mainSnapshotRecords(snap), limits);
  for (const [i, part] of parts.entries()) {
    expect((await putPart(id, i + 1, parts.length, part)).status).toBe(202);
  }
  return id;
}
const status = async (id: string) =>
  (await call(ROUTES.uploadStatus, { id })).json as {
    status: string;
    error?: string;
    parts: Record<string, number>;
  };

describe("one request per route", () => {
  it("runs the whole flow and every response parses with its schema", async () => {
    const check = (route: RouteDef, json: unknown) =>
      expect(route.response.safeParse(json).success, JSON.stringify(json)).toBe(true);

    // whoami: CI and user
    const ci = await call(ROUTES.whoami);
    expect(ci.status).toBe(200);
    check(ROUTES.whoami, ci.json);
    expect(ci.json).toMatchObject({ kind: "ci", org: "acme", repo: REPO, repo_connected: true, protocol: 1 });
    const user = await call(ROUTES.whoami, {}, asUser(), `?repo=${encodeURIComponent(REPO)}`);
    expect(user.json).toMatchObject({
      kind: "user",
      org: "acme",
      role: "owner",
      repo: REPO,
      repo_connected: true,
    });

    // upload of a main snapshot, in several parts, with gzip bodies
    const snap = snapshot();
    snap.files = Array.from({ length: 5 }, (_, i) => ({
      ...(snap.files[0] as MainSnapshot["files"][number]),
      id: `file:${REPO}:f${i}.ts`,
      path: `f${i}.ts`,
    }));
    const id = await uploadMain(snap, { part_max_records: 3, part_max_bytes: 1_048_576 });
    const done = await call(ROUTES.uploadStatus, { id });
    check(ROUTES.uploadStatus, done.json);
    expect(done.json).toMatchObject({ status: "done", parts: { total: 3, received: 3, done: 3, failed: 0 } });
    expect(server.state.snapshots.get(REPO)).toEqual({
      ...snap,
      files: [...snap.files].sort((a, b) => (a.id < b.id ? -1 : 1)),
    });

    // a change set upload, then pull, then close
    const cs = changeSet(12);
    const csId = cs.id;
    const csStart = await begin(
      { kind: "change_set", counts: { nodes: cs.nodes.length, radius: cs.radius.length } },
      csId,
    );
    expect(csStart.status).toBe(202);
    check(ROUTES.beginUpload, csStart.json);
    const upload = (csStart.json as { upload_id: string }).upload_id;
    const parts = splitIntoParts(changeSetRecords(cs), LIMITS);
    expect((await putPart(upload, 1, parts.length, parts[0] as Uint8Array)).json).toMatchObject({
      part: 1,
      status: "queued",
    });
    expect((await status(upload)).status).toBe("done");
    expect(server.state.changeSets.get(csId)).toEqual(cs);

    const pull = await call(ROUTES.pull, {}, {}, `?repo=${encodeURIComponent(REPO)}`);
    check(ROUTES.pull, pull.json);
    expect((pull.json as { change_sets: unknown[] }).change_sets).toHaveLength(1);
    const etag = pull.res.headers.get("etag") as string;
    const again = await fetch(`${server.url}/v1/pull?repo=${encodeURIComponent(REPO)}`, {
      headers: { authorization: `Bearer ${CI}`, [HEADER_PROTOCOL]: "1", "if-none-match": etag },
    });
    expect(again.status).toBe(304);

    const closed = await call(
      ROUTES.closeChangeSet,
      { repo: REPO, id: csId },
      { body: { merged: true, head_sha: SHA } },
    );
    check(ROUTES.closeChangeSet, closed.json);
    expect(closed.json).toEqual({ closed: true });
    expect(server.state.closed).toEqual([{ id: csId, repo: REPO, merged: true, head_sha: SHA }]);
    const nothing = await call(
      ROUTES.closeChangeSet,
      { repo: REPO, id: `${csId}x` },
      { body: { merged: false } },
    );
    expect(nothing.json).toEqual({ closed: false });

    // descriptions, groups, views
    const posted = await call(
      ROUTES.putDescriptions,
      {},
      asUser({ body: { repo: REPO, descriptions: [description()] } }),
    );
    check(ROUTES.putDescriptions, posted.json);
    expect(posted.json).toEqual({ stored: 1 });
    expect(server.state.descriptions.size).toBe(1);
    for (const [putRoute, delRoute, item, store] of [
      [ROUTES.putGroup, ROUTES.deleteGroup, group, server.state.groups],
      [ROUTES.putView, ROUTES.deleteView, view, server.state.views],
    ] as const) {
      const put = await call(putRoute, { repo: REPO, id: item.id }, asUser({ body: item }));
      check(putRoute, put.json);
      expect(store.get(REPO)?.has(item.id)).toBe(true);
      const del = await call(delRoute, { repo: REPO, id: item.id }, asUser());
      check(delRoute, del.json);
      expect(del.json).toEqual({ deleted: true });
      expect((await call(delRoute, { repo: REPO, id: item.id }, asUser())).json).toEqual({ deleted: false });
    }
  });
});

describe("auth, headers and validation", () => {
  it("answers 401 for a wrong or missing token", async () => {
    for (const token of ["nope", null] as const) {
      const r = await call(ROUTES.whoami, {}, { token });
      expect(r.status).toBe(401);
      expect(ErrorSchema.parse(r.json).error).toBe("unauthorized");
    }
  });

  it("answers 400 protocol_version for a missing, malformed or too high version, and sends the maximum on every response", async () => {
    for (const protocol of [null, "0", "x", "2"]) {
      const r = await call(ROUTES.whoami, {}, { protocol });
      expect(r.status).toBe(400);
      expect(ErrorSchema.parse(r.json).error).toBe("protocol_version");
    }
    await server.close();
    await start({ protocolMax: 3 });
    const ok = await call(ROUTES.whoami, {}, { protocol: "3" });
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get(HEADER_PROTOCOL_MAX)).toBe("3");
    expect(ok.json).toMatchObject({ protocol: 3 });
    expect((await call(ROUTES.whoami, {}, { protocol: "4" })).res.headers.get(HEADER_PROTOCOL_MAX)).toBe("3");
  });

  const concrete: [string, RouteDef, Record<string, string>][] = Object.entries(ROUTES).map(([name, def]) => [
    name,
    def,
    { repo: REPO, id: "5f3a9c1e7b2d4a60918c3e7d", n: "1" },
  ]);

  it("answers 400 to a user token without X-Gantry-Org on every route but whoami", async () => {
    for (const [name, def, params] of concrete) {
      const r = await call(def, params, { token: USER });
      if (name === "whoami") {
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ kind: "user", user: "octo-dev", repo_connected: false, protocol: 1 });
      } else {
        expect(r.status, name).toBe(400);
        expect(ErrorSchema.parse(r.json).error).toBe("invalid");
      }
    }
  });

  it("answers 403 to another organisation, and to a CI token for another repo or on a user route", async () => {
    for (const [name, def, params] of concrete) {
      const r = await call(def, params, { token: USER, org: "other" });
      expect(r.status, name).toBe(403);
    }
    expect(
      (await begin({ kind: "change_set", counts: { nodes: 0, radius: 0 } }, "main", asUser())).status,
    ).toBe(403);
    expect((await call(ROUTES.beginUpload, { repo: "other/repo" }, { body: {} })).status).toBe(403);
    expect((await call(ROUTES.putDescriptions, {}, { body: { repo: REPO, descriptions: [] } })).status).toBe(
      403,
    );
    expect((await call(ROUTES.pull, {}, {}, "?repo=other%2Frepo")).status).toBe(403);
  });

  it("ignores X-Gantry-Org for a CI token", async () => {
    expect((await call(ROUTES.whoami, {}, { org: "anything" })).status).toBe(200);
  });

  it("CloseRequestSchema rejects merged without head_sha and the route answers 400", async () => {
    expect(CloseRequestSchema.safeParse({ merged: false }).success).toBe(true);
    expect(CloseRequestSchema.safeParse({ merged: true }).success).toBe(false);
    const r = await call(
      ROUTES.closeChangeSet,
      { repo: REPO, id: changeSetIdForPr(REPO, 1) },
      { body: { merged: true } },
    );
    expect(r.status).toBe(400);
    expect(ErrorSchema.parse(r.json).error).toBe("invalid");
    const ok = await call(
      ROUTES.closeChangeSet,
      { repo: REPO, id: changeSetIdForPr(REPO, 1) },
      { body: { merged: false } },
    );
    expect(ok.status).toBe(200);
  });

  it("answers 400 when a PUT body id differs from the path id", async () => {
    for (const [route, item] of [
      [ROUTES.putGroup, group],
      [ROUTES.putView, view],
    ] as const) {
      const r = await call(route, { repo: REPO, id: "other" }, asUser({ body: item }));
      expect(r.status).toBe(400);
      expect(ErrorSchema.parse(r.json).error).toBe("invalid");
    }
  });

  it("answers 400 to an invalid body, an extra key and a body that is not JSON", async () => {
    const bad = await call(
      ROUTES.putDescriptions,
      {},
      asUser({ body: { repo: REPO, descriptions: [{ ...description(), behavior: "x".repeat(401) }] } }),
    );
    expect(bad.status).toBe(400);
    const extra = await call(
      ROUTES.putGroup,
      { repo: REPO, id: group.id },
      asUser({ body: { ...group, extra: 1 } }),
    );
    expect(extra.status).toBe(400);
    const notJson = await call(
      ROUTES.putGroup,
      { repo: REPO, id: group.id },
      asUser({ raw: new TextEncoder().encode("{"), headers: { "content-type": "application/json" } }),
    );
    expect(notJson.status).toBe(400);
  });

  it("accepts a gzip JSON body", async () => {
    const r = await call(
      ROUTES.putView,
      { repo: REPO, id: view.id },
      asUser({ raw: gzipSync(JSON.stringify(view)), headers: { "content-encoding": "gzip" } }),
    );
    expect(r.status).toBe(200);
  });

  it("limits groups and views per repo, and a member cannot delete a group", async () => {
    for (let i = 0; i < 100; i++) {
      expect(
        (
          await call(
            ROUTES.putGroup,
            { repo: REPO, id: `g${i}` },
            asUser({ body: { ...group, id: `g${i}` } }),
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (await call(ROUTES.putGroup, { repo: REPO, id: "g100" }, asUser({ body: { ...group, id: "g100" } })))
        .status,
    ).toBe(400);
    expect(
      (await call(ROUTES.putGroup, { repo: REPO, id: "g0" }, asUser({ body: group, ...{} }))).status,
    ).toBe(400);
    await server.close();
    await start({ role: "member" });
    expect((await call(ROUTES.deleteGroup, { repo: REPO, id: "g0" }, asUser())).status).toBe(403);
  });

  it("keeps the first description unless a model one replaces a fallback one", async () => {
    const post = (d: ReturnType<typeof description>) =>
      call(ROUTES.putDescriptions, {}, asUser({ body: { repo: REPO, descriptions: [d] } }));
    const fallback = { ...description(), provenance: "fallback" as const, model: null };
    expect((await post(fallback)).json).toEqual({ stored: 1 });
    expect((await post(fallback)).json).toEqual({ stored: 0 });
    expect((await post(description())).json).toEqual({ stored: 1 });
    expect((await post({ ...description(), behavior: "other" })).json).toEqual({ stored: 0 });
    expect(server.state.descriptions.get(description().content_key)?.provenance).toBe("model");
  });
});

describe("uploads in parts", () => {
  it("accepts gzipped parts, readable from state, and supersedes an older upload of the same target", async () => {
    const first = await begin({ kind: "main", sha: SHA, counts: countsOf(snapshot()) });
    const firstId = (first.json as { upload_id: string }).upload_id;
    expect(first.json).toMatchObject({ part_max_records: 2000, part_max_bytes: 1048576, max_parts: 1000 });
    const secondId = await uploadMain();
    expect((await status(firstId)).status).toBe("superseded");
    const part = splitIntoParts(mainSnapshotRecords(snapshot()), LIMITS)[0] as Uint8Array;
    const late = await putPart(firstId, 1, 1, part);
    expect(late.status).toBe(409);
    expect(ErrorSchema.parse(late.json).error).toBe("conflict");
    expect(await status(secondId)).toMatchObject({ status: "done" });
    const stored = server.state.uploads.get(secondId);
    expect(stored?.parts.get(1)).toEqual(decodePart(part));
  });

  it("answers queued, then loading, before the last part", async () => {
    const snap = snapshot();
    const started = await begin({ kind: "main", sha: SHA, counts: countsOf(snap) });
    const id = (started.json as { upload_id: string }).upload_id;
    expect(await status(id)).toEqual({
      status: "queued",
      parts: { total: 0, received: 0, done: 0, failed: 0 },
    });
    const parts = splitIntoParts(mainSnapshotRecords(snap), {
      part_max_records: 2,
      part_max_bytes: 1_048_576,
    });
    expect(parts.length).toBeGreaterThan(1);
    await putPart(id, 2, parts.length, parts[1] as Uint8Array);
    expect(await status(id)).toMatchObject({
      status: "loading",
      parts: { total: parts.length, received: 1 },
    });
    // a resend of a recorded part changes nothing and answers 200
    expect((await putPart(id, 2, parts.length, parts[1] as Uint8Array)).status).toBe(200);
  });

  it("rejects a part with an unknown key, such as a signature, with 400", async () => {
    const snap = snapshot();
    const started = await begin({ kind: "main", sha: SHA, counts: countsOf(snap) });
    const id = (started.json as { upload_id: string }).upload_id;
    const records = mainSnapshotRecords(snap).map((r) =>
      r.t === "s" ? { ...r, signature: "function slugify(title) {" } : r,
    );
    const [part] = splitIntoParts(records as unknown as PartRecord[], LIMITS);
    const r = await putPart(id, 1, 1, part as Uint8Array);
    expect(r.status).toBe(400);
    expect(ErrorSchema.parse(r.json).error).toBe("invalid");
    expect((await status(id)).parts.received).toBe(0);
    // so does a snapshot that begins with one
    const begun = await call(
      ROUTES.beginUpload,
      { repo: REPO },
      {
        body: { kind: "main", sha: SHA, counts: countsOf(snap), signature: "x" },
        headers: { [HEADER_TARGET]: "main" },
      },
    );
    expect(begun.status).toBe(400);
    expect(ErrorSchema.parse(begun.json).error).toBe("invalid");
  });

  it("rejects a body that is not gzip and a part without Content-Encoding", async () => {
    const started = await begin({ kind: "main", sha: SHA, counts: countsOf(snapshot()) });
    const id = (started.json as { upload_id: string }).upload_id;
    expect((await putPart(id, 1, 1, new TextEncoder().encode("not gzip"))).status).toBe(400);
    const r = await call(
      ROUTES.putPart,
      { id, n: 1 },
      { raw: gzipSync("{}"), headers: { [HEADER_PART_COUNT]: "1" } },
    );
    expect(r.status).toBe(400);
  });

  it("checks X-Gantry-Part-Count and the part number", async () => {
    const snap = snapshot();
    const started = await begin({ kind: "main", sha: SHA, counts: countsOf(snap) });
    const id = (started.json as { upload_id: string }).upload_id;
    const parts = splitIntoParts(mainSnapshotRecords(snap), {
      part_max_records: 2,
      part_max_bytes: 1_048_576,
    });
    const part = parts[0] as Uint8Array;
    expect(
      (await call(ROUTES.putPart, { id, n: 1 }, { raw: part, headers: { "content-encoding": "gzip" } }))
        .status,
    ).toBe(400);
    expect((await putPart(id, 1, 0, part)).status).toBe(400);
    expect((await putPart(id, 1, 1001, part)).status).toBe(400);
    expect((await putPart(id, 3, 2, part)).status).toBe(400);
    expect((await putPart(id, 1, parts.length, part)).status).toBe(202);
    expect((await putPart(id, 2, parts.length + 1, part)).status).toBe(400);
    expect((await call(ROUTES.putPart, { id: "ffffffffffffffffffffffff", n: 1 }, { raw: part })).status).toBe(
      404,
    );
  });

  it("answers 413 for a part over the byte limit", async () => {
    await server.close();
    await start({ limits: { part_max_bytes: 100 } });
    const started = await begin({ kind: "main", sha: SHA, counts: countsOf(snapshot()) });
    const id = (started.json as { upload_id: string }).upload_id;
    const big = new Uint8Array(gzipSync(Buffer.alloc(100_000, "x").toString()));
    const r = await putPart(id, 1, 1, new Uint8Array(Buffer.concat([big, Buffer.alloc(200)])));
    expect(r.status).toBe(413);
    expect(ErrorSchema.parse(r.json).error).toBe("too_large");
  });

  it("fails an upload whose counts differ from what its parts held", async () => {
    const snap = snapshot();
    const started = await begin({ kind: "main", sha: SHA, counts: { ...countsOf(snap), symbols: 5 } });
    const id = (started.json as { upload_id: string }).upload_id;
    const [part] = splitIntoParts(mainSnapshotRecords(snap), LIMITS);
    await putPart(id, 1, 1, part as Uint8Array);
    expect(await status(id)).toMatchObject({ status: "failed", error: "counts differ" });
    expect(server.state.snapshots.size).toBe(0);
    expect((await putPart(id, 1, 1, part as Uint8Array)).status).toBe(409);
  });

  it("answers 409 budget for a main part but not for a change set part", async () => {
    await server.close();
    await start({ budgetExhausted: true });
    const started = await begin({ kind: "main", sha: SHA, counts: countsOf(snapshot()) });
    const id = (started.json as { upload_id: string }).upload_id;
    const [part] = splitIntoParts(mainSnapshotRecords(snapshot()), LIMITS);
    const refused = await putPart(id, 1, 1, part as Uint8Array);
    expect(refused.status).toBe(409);
    expect(ErrorSchema.parse(refused.json).error).toBe("budget");
    const cs = changeSet();
    const csStart = await begin({ kind: "change_set", counts: { nodes: 2, radius: 2 } }, cs.id);
    const csId = (csStart.json as { upload_id: string }).upload_id;
    const [csPart] = splitIntoParts(changeSetRecords(cs), LIMITS);
    expect((await putPart(csId, 1, 1, csPart as Uint8Array)).status).toBe(202);
  });

  it("decodes the target header once and checks the c record against it", async () => {
    const cs = changeSet();
    const branch = changeSetIdForBranch(REPO, "feat/100%41 日本語");
    const branchSet = {
      ...cs,
      id: branch,
      source: "branch" as const,
      ref: "feat/100%41 日本語",
      head_ref: "feat/100%41 日本語",
      pr: undefined,
    };
    const { pr: _pr, ...noPr } = branchSet;
    const started = await begin({ kind: "change_set", counts: { nodes: 2, radius: 2 } }, branch);
    expect(started.status).toBe(202);
    const id = (started.json as { upload_id: string }).upload_id;
    expect(server.state.uploads.get(id)?.target).toBe(branch);
    const [good] = splitIntoParts(changeSetRecords(noPr), LIMITS);
    expect((await putPart(id, 1, 1, good as Uint8Array)).status).toBe(202);
    expect((await status(id)).status).toBe("done");
    expect(server.state.changeSets.get(branch)?.head_ref).toBe("feat/100%41 日本語");

    const other = await begin(
      { kind: "change_set", counts: { nodes: 2, radius: 2 } },
      changeSetIdForPr(REPO, 99),
    );
    const otherId = (other.json as { upload_id: string }).upload_id;
    const [wrong] = splitIntoParts(changeSetRecords(cs), LIMITS);
    const mismatch = await putPart(otherId, 1, 1, wrong as Uint8Array);
    expect(mismatch.status).toBe(400);
    expect((mismatch.json as { message: string }).message).toContain("target mismatch");
  });

  it("checks the target header at begin", async () => {
    const snap = countsOf(snapshot());
    expect(
      (await call(ROUTES.beginUpload, { repo: REPO }, { body: { kind: "main", sha: SHA, counts: snap } }))
        .status,
    ).toBe(400);
    expect((await begin({ kind: "main", sha: SHA, counts: snap }, changeSetIdForPr(REPO, 1))).status).toBe(
      400,
    );
    expect((await begin({ kind: "change_set", counts: { nodes: 0, radius: 0 } }, "main")).status).toBe(400);
    expect(
      (
        await begin(
          { kind: "change_set", counts: { nodes: 0, radius: 0 } },
          changeSetIdForPr("other/repo", 1),
        )
      ).status,
    ).toBe(400);
    const bad = await call(
      ROUTES.beginUpload,
      { repo: REPO },
      { body: { kind: "main", sha: SHA, counts: snap }, headers: { [HEADER_TARGET]: "%E0%A4%A" } },
    );
    expect(bad.status).toBe(400);
  });
});

describe("pull", () => {
  it("pages by pageSize, with views and groups on the first page only", async () => {
    await server.close();
    await start({ pageSize: 2 });
    for (let n = 1; n <= 3; n++) {
      const cs = changeSet(n);
      server.state.changeSets.set(cs.id, { ...cs, updated_at: `2026-11-20T09:4${n}:00.000Z` });
    }
    server.state.views.set(REPO, new Map([[view.id, view]]));
    const q = `?repo=${encodeURIComponent(REPO)}`;
    const first = (await call(ROUTES.pull, {}, {}, q)).json as {
      change_sets: { pr: number }[];
      team_views: unknown[];
      next_cursor?: string;
    };
    expect(first.change_sets.map((c) => c.pr)).toEqual([3, 2]);
    expect(first.team_views).toHaveLength(1);
    expect(first.next_cursor).toBeDefined();
    const second = (await call(ROUTES.pull, {}, {}, `${q}&cursor=${first.next_cursor}`)).json as typeof first;
    expect(second.change_sets.map((c) => c.pr)).toEqual([1]);
    expect(second.team_views).toEqual([]);
    expect(second.next_cursor).toBeUndefined();
    expect((await call(ROUTES.pull)).status).toBe(400);
  });
});

describe("device sign-in", () => {
  it("issues a code, answers pending until approved, then gives a user token that works", async () => {
    const codeRes = await fetch(`${server.url}/api/auth/device/code`, {
      method: "POST",
      body: JSON.stringify({ client_id: "gantry-cli" }),
    });
    const code = (await codeRes.json()) as {
      device_code: string;
      user_code: string;
      expires_in: number;
      interval: number;
    };
    expect(code).toMatchObject({ expires_in: 900, interval: 5 });
    const poll = () =>
      fetch(`${server.url}/api/auth/device/token`, {
        method: "POST",
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.device_code,
          client_id: "gantry-cli",
        }),
      });
    const pending = await poll();
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: "authorization_pending" });
    expect(server.state.approveDevice(code.user_code)).toBe(true);
    expect(server.state.approveDevice("NOPE")).toBe(false);
    const ok = await poll();
    const token = (await ok.json()) as { access_token: string; token_type: string };
    expect(token.token_type).toBe("Bearer");
    expect((await call(ROUTES.whoami, {}, { token: token.access_token })).json).toMatchObject({
      kind: "user",
    });
  });
});

describe("splitIntoParts", () => {
  const records = (n: number): PartRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      t: "n" as const,
      id: `sym:${REPO}:a.ts#f${String(i).padStart(4, "0")}`,
    }));

  it("cuts by records", () => {
    const parts = splitIntoParts(records(7), { part_max_records: 3, part_max_bytes: 1_048_576 });
    expect(parts.map((p) => decodePart(p).length)).toEqual([3, 3, 1]);
    expect(parts.flatMap((p) => decodePart(p))).toEqual(records(7));
  });

  it("cuts by decompressed bytes, counting each line and its newline", () => {
    const line = `${JSON.stringify(records(1)[0])}\n`.length;
    const parts = splitIntoParts(records(7), { part_max_records: 1000, part_max_bytes: line * 2 + 1 });
    expect(parts.map((p) => decodePart(p).length)).toEqual([2, 2, 2, 1]);
  });

  it("halves a part whose gzip is over the limit", () => {
    // random-looking ids do not compress, so a part of 40 of them is over 1,200 bytes gzipped but under 8,000 raw
    const noisy: PartRecord[] = Array.from({ length: 40 }, (_, i) => ({
      t: "n" as const,
      id: `n${i}-${Buffer.from(Array.from({ length: 24 }, (_, j) => (i * 31 + j * 17 + i * j * 7) % 256)).toString("hex")}`,
    }));
    const limits = { part_max_records: 1000, part_max_bytes: 1200 };
    const parts = splitIntoParts(noisy, limits);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(limits.part_max_bytes);
    expect(parts.flatMap((p) => decodePart(p))).toEqual(noisy);
  });

  it("is deterministic, and gives no parts for no records", () => {
    const limits = { part_max_records: 3, part_max_bytes: 1_048_576 };
    const a = splitIntoParts(records(5), limits);
    const b = splitIntoParts(records(5), limits);
    expect(a.map((p) => Buffer.from(p).toString("hex"))).toEqual(
      b.map((p) => Buffer.from(p).toString("hex")),
    );
    expect(splitIntoParts([], limits)).toEqual([]);
  });

  it("throws, naming the record, when one record cannot fit an empty part", () => {
    expect(() => splitIntoParts(records(2), { part_max_records: 10, part_max_bytes: 20 })).toThrow(
      /sym:fixture\/pnpm-turbo:a\.ts#f0000/,
    );
  });

  it("decodePart refuses a record that is not valid and a body over the byte limit", () => {
    expect(() => decodePart(new Uint8Array(gzipSync('{"t":"n","id":"a","extra":1}\n')))).toThrow(/record 1/);
    expect(() => decodePart(new Uint8Array(gzipSync("x".repeat(1000))), 10)).toThrow();
  });

  it("orders main records by section and id", () => {
    const snap = snapshot();
    const second = { ...(snap.files[0] as MainSnapshot["files"][number]), id: `file:${REPO}:a.ts` };
    const out = mainSnapshotRecords({
      ...snap,
      files: [snap.files[0] as MainSnapshot["files"][number], second],
    });
    expect(out.map((r) => r.t).join("")).toBe("wffsea");
    expect((out[1] as { id: string }).id).toBe(second.id);
  });
});
