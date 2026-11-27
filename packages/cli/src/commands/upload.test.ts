import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMainSnapshot,
  dumpGraph,
  type GantryPaths,
  indexRepo,
  openStore,
  resetTeamProtocolCache,
  resolvePaths,
  type Store,
  snapshotRecords,
} from "@gantry/core";
import { decodePart } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { build } from "tsup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildUploadParts, runUpload, serialiseBody, type UploadOptions } from "./upload.js";

interface UploadFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/upload-fixture.js";
const { materializeUploadFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeUploadFixture: (
    name: string,
    opts: {
      dirName: string;
      origin?: string;
      branch?: string;
      edit?: { file: string; from: string; to: string };
    },
  ) => Promise<UploadFixture>;
};

const REPO = "fixture/pnpm-turbo";
const CI_TOKEN = "gct_ci-7c1e5b9a";
const USER_TOKEN = "tok-user-4d2f8e";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

let fx: UploadFixture;
let data: string;
let paths: GantryPaths;
let store: Store;
let headSha: string;
let prHeadSha: string;
let fake: FakeServer;
const printed: string[] = [];

beforeAll(async () => {
  fx = await materializeUploadFixture("pnpm-turbo", {
    dirName: "pnpm-turbo",
    origin: "https://github.com/fixture/pnpm-turbo.git",
    branch: "feat/slug-edit",
    edit: {
      file: "packages/utils/src/slug.ts",
      from: 'dashed.replace(/[^a-z0-9-]/g, "")',
      to: 'dashed.replace(/[^a-z0-9_-]/g, "")',
    },
  });
  data = mkdtempSync(join(tmpdir(), "gantry-upload-data-"));
  paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  store = openStore(paths.dbPath);
  headSha = fx.git(["rev-parse", "main"]).trim();
  prHeadSha = fx.git(["rev-parse", "feat/slug-edit"]).trim();
  fx.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
}, 60_000);
afterAll(async () => {
  store.close();
  rmSync(data, { recursive: true, force: true });
  await fx.cleanup();
});

beforeEach(async () => {
  resetTeamProtocolCache();
  printed.length = 0;
  fake = await startFakeServer({ tokens: [CI_TOKEN, USER_TOKEN], repo: REPO });
});
afterEach(async () => {
  await fake.close();
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface Run {
  code: number;
  out: string;
  err: string;
  calls: Call[];
}

type Intercept = (call: Call, clock: { t: number }) => Response | undefined;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-gantry-protocol-max": "1" },
  });
const statusBody = (status: string, error?: string) => ({
  status,
  ...(error === undefined ? {} : { error }),
  parts: { total: 1, received: 1, done: 1, failed: 0 },
});

/** Runs the command in this process against the fake server, with a clock that only `sleep` and the hook move. */
async function upload(
  opts: UploadOptions,
  o: {
    env?: Record<string, string | undefined>;
    intercept?: Intercept;
    statusMs?: number;
    buildMs?: number;
  } = {},
): Promise<Run> {
  const clock = { t: 0 };
  const calls: Call[] = [];
  let out = "";
  let err = "";
  const env: NodeJS.ProcessEnv = {
    GANTRY_CREDENTIALS_FILE: join(data, "no-credentials.json"),
    GANTRY_SERVER: fake.url,
    GANTRY_ORG: "acme",
    GANTRY_TOKEN: CI_TOKEN,
    ...o.env,
  };
  const code = await runUpload(
    {
      paths,
      env,
      out: (t) => {
        // the "Uploading ..." line is printed when the local build is over: this is how long that took
        if (t.startsWith("Uploading")) clock.t += o.buildMs ?? 0;
        out += t;
      },
      err: (t) => {
        err += t;
      },
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      fetch: async (input, init) => {
        const body = init?.body;
        const call: Call = {
          method: init?.method ?? "GET",
          url: String(input),
          headers: { ...(init?.headers as Record<string, string> | undefined) },
          body: typeof body === "string" ? body : undefined,
        };
        calls.push(call);
        if (call.method === "GET" && call.url.includes("/v1/uploads/")) clock.t += o.statusMs ?? 0;
        return o.intercept?.(call, clock) ?? fetch(input, init);
      },
    },
    opts,
  );
  printed.push(out, err);
  return { code, out, err, calls };
}

const PR: UploadOptions = {
  pr: "1",
  base: "main",
  head: "feat/slug-edit",
  owner: "maya",
  headRef: "feat/slug-edit",
  baseBranch: "main",
  title: "Allow underscores in slugs",
};

describe("gantry upload: the main snapshot", () => {
  it("sends the graph of main and prints the UI guide's two lines", async () => {
    const run = await upload({}, { statusMs: 4100 });
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(run.out).toBe(`Uploading main snapshot for ${REPO} (${headSha.slice(0, 7)})...\ndone in 4.1 s\n`);
    const stored = fake.state.snapshots.get(REPO);
    const dump = dumpGraph(store);
    expect(stored?.sha).toBe(headSha);
    expect(stored?.workspaces).toHaveLength(dump.workspaces.length);
    expect(stored?.files).toHaveLength(dump.files.length);
    expect(stored?.symbols).toHaveLength(dump.symbols.length);
    expect(stored?.edges).toHaveLength(dump.edges.length);
  });

  it("does not count the local build in --timeout or in `done in`", async () => {
    const run = await upload({ timeout: "5" }, { statusMs: 1800, buildMs: 1_000_000 });
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(run.out).toMatch(/\ndone in 1\.8 s\n$/);
  });

  it("sends the target percent-encoded, a sorted begin body, and never an organisation with a CI token", async () => {
    const run = await upload({});
    const begin = run.calls.find((c) => c.method === "POST");
    expect(begin?.url).toBe(`${fake.url}/v1/repos/fixture%2Fpnpm-turbo/uploads`);
    expect(begin?.headers["X-Gantry-Target"]).toBe("main");
    expect(begin?.body).toBe(
      serialiseBody("main", {
        kind: "main",
        sha: headSha,
        counts: {
          workspaces: dumpGraph(store).workspaces.length,
          files: dumpGraph(store).files.length,
          symbols: dumpGraph(store).symbols.length,
          edges: dumpGraph(store).edges.length,
          adapter_nodes: buildMainSnapshot(store, paths).adapter_nodes.length,
        },
      }),
    );
    expect(run.calls.every((c) => c.headers["X-Gantry-Org"] === undefined)).toBe(true);
    expect(run.calls.every((c) => c.headers.Authorization === `Bearer ${CI_TOKEN}`)).toBe(true);
    expect(run.calls.filter((c) => c.method === "PUT").length).toBeGreaterThan(0);
  });

  it("sends the organisation with a user token", async () => {
    const run = await upload({}, { env: { GANTRY_TOKEN: USER_TOKEN } });
    // the fake server takes uploads from CI tokens only, so this ends at the first refusal; the header is what counts
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/^team_forbidden: /);
    expect(run.calls.length).toBeGreaterThan(0);
    expect(run.calls.every((c) => c.headers["X-Gantry-Org"] === "acme")).toBe(true);
  });

  it("splits the records into several parts when the server's limits are small", async () => {
    await fake.close();
    fake = await startFakeServer({
      tokens: [CI_TOKEN],
      repo: REPO,
      limits: { part_max_records: 50 },
    });
    const run = await upload({});
    expect(run.code).toBe(0);
    const puts = run.calls.filter((c) => c.method === "PUT");
    expect(puts.length).toBeGreaterThan(3);
    expect(new Set(puts.map((c) => c.headers["X-Gantry-Part-Count"])).size).toBe(1);
    expect(puts.every((c) => c.headers["Content-Encoding"] === "gzip")).toBe(true);
    expect(puts.every((c) => c.headers["Content-Type"] === "application/x-ndjson")).toBe(true);
  });

  it("reports superseded and exits 0", async () => {
    const run = await upload(
      {},
      {
        intercept: (c) =>
          c.method === "GET" && c.url.includes("/v1/uploads/")
            ? json(200, statusBody("superseded"))
            : undefined,
      },
    );
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/^Uploading main snapshot for .*\nsuperseded by a newer upload after 0\.0 s\n$/);
  });

  it("reports the server's error when the upload failed, and exits 1", async () => {
    const run = await upload(
      {},
      {
        intercept: (c) =>
          c.method === "GET" && c.url.includes("/v1/uploads/")
            ? json(200, statusBody("failed", "counts differ"))
            : undefined,
      },
    );
    expect(run.code).toBe(1);
    expect(run.err).toBe("gantry: upload failed: counts differ\n");
  });

  it("polls every 2 s, prints each state change once, and times out with exit 1", async () => {
    const run = await upload(
      { timeout: "5" },
      {
        intercept: (c) =>
          c.method === "GET" && c.url.includes("/v1/uploads/") ? json(200, statusBody("loading")) : undefined,
      },
    );
    expect(run.code).toBe(1);
    expect(run.out).toBe(`Uploading main snapshot for ${REPO} (${headSha.slice(0, 7)})...\nloading\n`);
    expect(run.err).toBe("gantry: timed out after 5 s; the server had not finished the upload.\n");
    expect(run.calls.filter((c) => c.method === "GET" && c.url.includes("/v1/uploads/"))).toHaveLength(4);
  });

  it("answers `Daily upload budget used; try again later.` when the server's capacity is used", async () => {
    await fake.close();
    fake = await startFakeServer({ tokens: [CI_TOKEN], repo: REPO, budgetExhausted: true });
    const run = await upload({});
    expect(run.code).toBe(1);
    expect(run.err).toBe("Daily upload budget used; try again later.\n");
  });

  it("stops at a 409 conflict with the server's error and does not resend the part", async () => {
    const run = await upload(
      {},
      {
        intercept: (c) =>
          c.method === "PUT"
            ? json(409, { error: "conflict", message: "the upload is superseded" })
            : undefined,
      },
    );
    expect(run.code).toBe(1);
    expect(run.err).toBe("team_rejected: the upload is superseded\n");
    expect(run.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("sends a part again after a 5xx or a dropped connection, up to 3 times", async () => {
    let failures = 0;
    const run = await upload(
      {},
      {
        intercept: (c) => {
          if (c.method !== "PUT" || failures >= 3) return undefined;
          failures += 1;
          if (failures === 2) throw new TypeError("fetch failed");
          return json(503, { error: "invalid", message: "try again" });
        },
      },
    );
    expect(run.code).toBe(0);
    expect(failures).toBe(3);
    expect(run.out).toMatch(/done in /);

    resetTeamProtocolCache();
    const never = await upload({}, { intercept: (c) => (c.method === "PUT" ? json(500, {}) : undefined) });
    expect(never.code).toBe(1);
    expect(never.err).toMatch(/^team_rejected: /);
    expect(never.calls.filter((c) => c.method === "PUT")).toHaveLength(4);
  });
});

describe("gantry upload --json on a failed request", () => {
  it("prints one failed object on a budget 409", async () => {
    await fake.close();
    fake = await startFakeServer({ tokens: [CI_TOKEN], repo: REPO, budgetExhausted: true });
    const run = await upload({ json: true });
    expect(run.code).toBe(1);
    expect(run.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(run.out)).toMatchObject({
      kind: "main",
      status: "failed",
      error: "Daily upload budget used; try again later.",
    });
  });

  it("prints one failed object on a network failure, with the token scrubbed", async () => {
    const run = await upload(
      { json: true },
      {
        intercept: (c) => {
          if (c.method === "POST") throw new TypeError(`fetch failed for ${CI_TOKEN}`);
          return undefined;
        },
      },
    );
    expect(run.code).toBe(1);
    const body = JSON.parse(run.out) as { status: string; error: string };
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/^team_unreachable: /);
    expect(run.out).not.toContain(CI_TOKEN);
  });
});

describe("gantry upload: the default branch", () => {
  const clean = (): void => {
    fx.git(["checkout", "-q", "main"]);
    fx.git(["branch", "-q", "-D", "elsewhere"]);
  };

  it("refuses to send another branch as main, and sends nothing", async () => {
    fx.git(["checkout", "-q", "-b", "elsewhere"]);
    try {
      const run = await upload({});
      expect(run).toMatchObject({
        code: 1,
        out: "",
        err: "Not on the default branch. Pass --force-main to upload this checkout as main.\n",
      });
      expect(run.calls).toEqual([]);
      const forced = await upload({ forceMain: true });
      expect(forced.code).toBe(0);
    } finally {
      clean();
    }
  });

  it("refuses when HEAD is detached", async () => {
    fx.git(["checkout", "-q", "--detach"]);
    try {
      const run = await upload({});
      expect(run).toMatchObject({
        code: 1,
        err: "Cannot tell whether this is the default branch. Pass --force-main to upload this checkout as main.\n",
      });
      expect(run.calls).toEqual([]);
      expect((await upload({ forceMain: true })).code).toBe(0);
    } finally {
      fx.git(["checkout", "-q", "main"]);
    }
  });

  it("refuses when the default branch is unknown", async () => {
    fx.git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    try {
      const run = await upload({});
      expect(run.err).toBe(
        "Cannot tell whether this is the default branch. Pass --force-main to upload this checkout as main.\n",
      );
      expect(run.code).toBe(1);
    } finally {
      fx.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    }
  });
});

describe("gantry upload: no team, no token", () => {
  it("sends nothing and exits 0 with no server and organisation", async () => {
    for (const env of [
      { GANTRY_SERVER: "", GANTRY_ORG: "", GANTRY_TOKEN: "" },
      { GANTRY_ORG: "" },
      { GANTRY_SERVER: "" },
    ]) {
      const run = await upload({ forceMain: true }, { env });
      expect(run).toEqual({ code: 0, out: "No team configured; nothing uploaded.\n", err: "", calls: [] });
    }
  });

  it("asks for a token when there is a server and organisation but none", async () => {
    const run = await upload({ forceMain: true }, { env: { GANTRY_TOKEN: "" } });
    expect(run).toEqual({
      code: 1,
      out: "",
      err: "No token. Set GANTRY_TOKEN, or run gantry team login.\n",
      calls: [],
    });
  });
});

describe("gantry upload --pr", () => {
  it("sends the change set of a pull request", async () => {
    const run = await upload(PR, { statusMs: 1800 });
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(run.out).toBe(`Uploading change set for ${REPO}#1...\ndone in 1.8 s\n`);
    const stored = fake.state.changeSets.get(`cs:pr:${REPO}#1`);
    expect(stored).toMatchObject({
      owner: "maya",
      head_ref: "feat/slug-edit",
      base_branch: "main",
      title: "Allow underscores in slugs",
      head_sha: prHeadSha,
      pr: 1,
      ref: "#1",
    });
    expect(stored?.nodes.length).toBeGreaterThan(0);
    const begin = run.calls.find((c) => c.method === "POST");
    expect(begin?.headers["X-Gantry-Target"]).toBe("cs%3Apr%3Afixture%2Fpnpm-turbo%231");
  });

  it("reads the owner, branches, title and creation time from the environment", async () => {
    const { owner: _o, headRef: _h, baseBranch: _b, title: _t, ...bare } = PR;
    const run = await upload(bare, {
      env: {
        GANTRY_PR_OWNER: "env-maya",
        GANTRY_PR_HEAD_REF: "feat/from-env",
        GANTRY_PR_BASE_BRANCH: "develop",
        GANTRY_PR_TITLE: "From the environment",
        GANTRY_PR_CREATED_AT: "2026-02-03T04:05:06.000Z",
      },
    });
    expect(run.code).toBe(0);
    expect(fake.state.changeSets.get(`cs:pr:${REPO}#1`)).toMatchObject({
      owner: "env-maya",
      head_ref: "feat/from-env",
      base_branch: "develop",
      title: "From the environment",
      created_at: "2026-02-03T04:05:06.000Z",
    });
  });

  it("omits the title when none is given", async () => {
    const { title: _t, ...noTitle } = PR;
    expect((await upload(noTitle)).code).toBe(0);
    expect(fake.state.changeSets.get(`cs:pr:${REPO}#1`)?.title).toBeUndefined();
  });

  it("uploads from any checkout, whatever branch or detached head it is on", async () => {
    fx.git(["checkout", "-q", "--detach"]);
    try {
      expect((await upload(PR)).code).toBe(0);
    } finally {
      fx.git(["checkout", "-q", "main"]);
    }
  });
});

describe("gantry upload --close", () => {
  const CLOSED_ID = `cs%3Apr%3Afixture%2Fpnpm-turbo%231`;

  it("closes a merged change set with the exact body and an encoded path", async () => {
    await upload(PR);
    const run = await upload({ pr: "1", head: "feat/slug-edit", close: true, merged: true });
    expect(run).toMatchObject({ code: 0, err: "", out: `Closed ${REPO}#1 (merged).\n` });
    const close = run.calls.find((c) => c.method === "POST" && c.url.endsWith("/close"));
    expect(close?.url).toBe(`${fake.url}/v1/repos/fixture%2Fpnpm-turbo/change-sets/${CLOSED_ID}/close`);
    expect(close?.body).toBe(`{"head_sha":"${prHeadSha}","merged":true}`);
    expect(fake.state.closed.at(-1)).toEqual({
      id: `cs:pr:${REPO}#1`,
      repo: REPO,
      merged: true,
      head_sha: prHeadSha,
    });
  });

  it("closes without --merged as not merged", async () => {
    await upload(PR);
    const run = await upload({ pr: "1", head: prHeadSha, close: true });
    expect(run.out).toBe(`Closed ${REPO}#1 (not merged).\n`);
    expect(run.calls.find((c) => c.url.endsWith("/close"))?.body).toBe(
      `{"head_sha":"${prHeadSha}","merged":false}`,
    );
  });

  it("says so when the server has nothing to close, and still exits 0", async () => {
    const run = await upload({ pr: "7", head: prHeadSha, close: true, merged: true });
    expect(run).toMatchObject({ code: 0, out: `Nothing to close for ${REPO}#7.\n` });
  });

  it("prints one JSON object with --json", async () => {
    await upload(PR);
    const run = await upload({ pr: "1", head: prHeadSha, close: true, json: true });
    expect(JSON.parse(run.out)).toEqual({ kind: "close", status: "closed", seconds: 0 });
    const main = await upload({ json: true }, { statusMs: 4100 });
    const body = JSON.parse(main.out) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: "main", status: "done", seconds: 4.1 });
    expect(body.upload_id).toMatch(/^[0-9a-f]{24}$/);
    expect(main.out.trim().split("\n")).toHaveLength(1);
  });
});

describe("gantry upload: usage errors exit 2 and send nothing", () => {
  const cases: [string, UploadOptions, string][] = [
    [
      "--pr without --head-ref",
      { ...PR, headRef: undefined },
      "--pr needs --base, --head, --owner, --head-ref and --base-branch",
    ],
    [
      "--pr without --base-branch",
      { ...PR, baseBranch: undefined },
      "--pr needs --base, --head, --owner, --head-ref and --base-branch",
    ],
    [
      "--pr without --owner",
      { ...PR, owner: undefined },
      "--pr needs --base, --head, --owner, --head-ref and --base-branch",
    ],
    [
      "--pr with nothing else",
      { pr: "1" },
      "--pr needs --base, --head, --owner, --head-ref and --base-branch",
    ],
    ["--close without --pr", { head: "abc", close: true }, "--close needs --pr and --head"],
    ["--close without --head", { pr: "1", close: true }, "--close needs --pr and --head"],
    ["--merged without --close", { merged: true }, "--merged only applies to --close"],
    ["a bad --pr", { pr: "one" }, "--pr must be a pull request number"],
    ["a bad --timeout", { timeout: "0" }, "--timeout must be a number of seconds above 0"],
  ];
  for (const [name, opts, message] of cases) {
    it(name, async () => {
      const run = await upload(opts);
      expect(run).toEqual({ code: 2, out: "", err: `${message}\n`, calls: [] });
    });
  }

  it("an unknown --head to close is a usage error", async () => {
    const run = await upload({ pr: "1", head: "no-such-ref", close: true });
    expect(run.code).toBe(2);
    expect(run.err).toBe("--head no-such-ref is not a commit here; pass its full 40-character sha\n");
  });
});

describe("the token is never printed", () => {
  it("appears in no output of any path, and a server that echoes it is scrubbed", async () => {
    const echo: Intercept = (c) =>
      c.method === "PUT" ? json(409, { error: "conflict", message: `bad ${CI_TOKEN} here` }) : undefined;
    const runs = [
      await upload({}),
      await upload(PR),
      await upload({}, { intercept: echo }),
      await upload({ pr: "1", head: prHeadSha, close: true }),
      await upload({}, { env: { GANTRY_TOKEN: "gct_wrong" } }),
      await upload({ json: true }),
    ];
    expect(runs[2]?.err).toBe("team_rejected: bad *** here\n");
    for (const text of [...printed, ...runs.map((r) => JSON.stringify(r.calls.map((c) => c.body)))]) {
      expect(text).not.toContain(CI_TOKEN);
    }
    expect(printed.join("\n")).not.toContain("gct_wrong");
  });
});

describe("serialiseBody", () => {
  it("is compact, with the keys sorted at every depth", () => {
    expect(serialiseBody("close", { merged: true, head_sha: prHeadSha })).toBe(
      `{"head_sha":"${prHeadSha}","merged":true}`,
    );
    expect(
      serialiseBody("main", {
        kind: "main",
        sha: headSha,
        counts: { symbols: 3, workspaces: 1, files: 2, edges: 4, adapter_nodes: 0 },
      }),
    ).toBe(
      `{"counts":{"adapter_nodes":0,"edges":4,"files":2,"symbols":3,"workspaces":1},"kind":"main","sha":"${headSha}"}`,
    );
    expect(serialiseBody("change_set", { kind: "change_set", counts: { radius: 2, nodes: 1 } })).toBe(
      `{"counts":{"nodes":1,"radius":2},"kind":"change_set"}`,
    );
  });

  it("refuses what the protocol refuses", () => {
    expect(() => serialiseBody("close", { merged: true })).toThrow();
    expect(() => serialiseBody("close", { merged: false, head_sha: prHeadSha, extra: 1 })).toThrow();
    expect(() => serialiseBody("main", { kind: "change_set", counts: { nodes: 0, radius: 0 } })).toThrow();
    expect(() => serialiseBody("descriptions", { repo: REPO, descriptions: [], extra: 1 })).toThrow();
    expect(serialiseBody("descriptions", { descriptions: [], repo: REPO })).toBe(
      `{"descriptions":[],"repo":"${REPO}"}`,
    );
  });
});

describe("buildUploadParts", () => {
  it("counts the records of the begin request and cuts the parts to the limits it is given", () => {
    const snapshot = buildMainSnapshot(store, paths);
    const records = snapshotRecords(snapshot);
    const { start, parts } = buildUploadParts(
      records,
      { part_max_records: 50, part_max_bytes: 1_048_576 },
      snapshot.sha,
    );
    expect(start).toEqual({
      kind: "main",
      sha: snapshot.sha,
      counts: {
        workspaces: snapshot.workspaces.length,
        files: snapshot.files.length,
        symbols: snapshot.symbols.length,
        edges: snapshot.edges.length,
        adapter_nodes: snapshot.adapter_nodes.length,
      },
    });
    expect(parts).toHaveLength(Math.ceil(records.length / 50));
    expect(parts.flatMap((p) => decodePart(p))).toEqual(records);
    expect(() =>
      buildUploadParts(records, { part_max_records: 5, part_max_bytes: 10 }, snapshot.sha),
    ).toThrow(/record too large/);
    expect(() => buildUploadParts(records, { part_max_records: 5, part_max_bytes: 10 })).toThrow();
  });
});

// The built CLI, as a CI step runs it: environment variables only, no config file.
describe("gantry upload, built, against the fake server", () => {
  let bundleDir: string;
  let cli: string;
  let home: string;
  let pluginData: string;
  let e2e: UploadFixture;
  let e2eFake: FakeServer;

  beforeAll(async () => {
    bundleDir = mkdtempSync(join(tmpdir(), "gantry-upload-bundle-"));
    mkdirSync(join(bundleDir, ".claude-plugin"));
    copyFileSync(
      join(repoRoot, "plugin/.claude-plugin/plugin.json"),
      join(bundleDir, ".claude-plugin/plugin.json"),
    );
    symlinkSync(join(repoRoot, "node_modules"), join(bundleDir, "node_modules"), "dir");
    await build({
      entry: { cli: join(repoRoot, "packages/cli/src/main.ts") },
      outDir: join(bundleDir, "dist"),
      format: ["esm"],
      platform: "node",
      target: "node22",
      external: [
        "better-sqlite3",
        "sqlite-vec",
        "oxc-parser",
        "oxc-resolver",
        "@huggingface/transformers",
        "onnxruntime-node",
      ],
      esbuildOptions(o) {
        o.alias = {
          "@gantry/core": join(repoRoot, "packages/core/src/index.ts"),
          "@gantry/protocol": join(repoRoot, "packages/protocol/src/index.ts"),
        };
      },
      silent: true,
      dts: false,
      config: false,
    });
    cli = join(bundleDir, "dist/cli.js");
    e2e = await materializeUploadFixture("pnpm-turbo", {
      dirName: "pnpm-turbo",
      origin: "https://github.com/fixture/pnpm-turbo.git",
      branch: "feat/slug-edit",
      edit: {
        file: "packages/utils/src/slug.ts",
        from: 'dashed.replace(/[^a-z0-9-]/g, "")',
        to: 'dashed.replace(/[^a-z0-9_-]/g, "")',
      },
    });
    home = mkdtempSync(join(tmpdir(), "gantry-upload-home-"));
    pluginData = mkdtempSync(join(tmpdir(), "gantry-upload-plugin-"));
    e2eFake = await startFakeServer({ tokens: [CI_TOKEN], repo: REPO });
  }, 90_000);
  afterAll(async () => {
    await e2eFake?.close();
    await e2e?.cleanup();
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
  });

  function gantry(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn("node", [cli, ...args], {
        cwd: e2e.dir,
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          CLAUDE_PLUGIN_DATA: pluginData,
          GANTRY_CREDENTIALS_FILE: join(home, "credentials.json"),
          GANTRY_SERVER: "",
          GANTRY_ORG: "",
          GANTRY_TOKEN: "",
          ...env,
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.on("close", (code) => {
        printed.push(out, err);
        resolve({ code, out, err });
      });
    });
  }

  it("does nothing without a team, asks for a token, and rejects a bad command line", async () => {
    expect(await gantry(["upload", "--force-main"])).toMatchObject({
      code: 0,
      out: "No team configured; nothing uploaded.\n",
    });
    const server = "http://127.0.0.1:9";
    expect(
      await gantry(["upload", "--force-main"], { GANTRY_SERVER: server, GANTRY_ORG: "acme" }),
    ).toMatchObject({
      code: 1,
      err: "No token. Set GANTRY_TOKEN, or run gantry team login.\n",
    });
    expect(
      await gantry(["upload", "--pr", "1"], { GANTRY_SERVER: server, GANTRY_ORG: "acme", GANTRY_TOKEN: "x" }),
    ).toMatchObject({
      code: 2,
      err: "--pr needs --base, --head, --owner, --head-ref and --base-branch\n",
    });
    expect((await gantry(["upload", "--no-such-option"])).code).toBe(2);
  }, 60_000);

  it("uploads main, a pull request and its close from three environment variables, and writes no file", async () => {
    const env = { GANTRY_SERVER: e2eFake.url, GANTRY_ORG: "acme", GANTRY_TOKEN: CI_TOKEN };
    const indexed = await gantry(["index", "--dump"], env);
    expect(indexed.code).toBe(0);
    const dump = JSON.parse(indexed.out) as ReturnType<typeof dumpGraph>;

    const main = await gantry(["upload", "--force-main"], env);
    expect(main.code).toBe(0);
    expect(main.out).toMatch(
      /^Uploading main snapshot for fixture\/pnpm-turbo \([0-9a-f]{7}\)\.\.\.\ndone in \d+\.\d s\n$/,
    );
    const stored = e2eFake.state.snapshots.get(REPO);
    expect(stored?.workspaces).toHaveLength(dump.workspaces.length);
    expect(stored?.files).toHaveLength(dump.files.length);
    expect(stored?.symbols).toHaveLength(dump.symbols.length);
    expect(stored?.edges).toHaveLength(dump.edges.length);

    const pr = await gantry(
      [
        "upload",
        "--pr",
        "1",
        "--base",
        "main",
        "--head",
        "feat/slug-edit",
        "--owner",
        "maya",
        "--head-ref",
        "feat/slug-edit",
        "--base-branch",
        "main",
      ],
      env,
    );
    expect(pr.code).toBe(0);
    expect(pr.out).toMatch(/^Uploading change set for fixture\/pnpm-turbo#1\.\.\.\ndone in \d+\.\d s\n$/);
    expect(e2eFake.state.changeSets.get(`cs:pr:${REPO}#1`)?.owner).toBe("maya");

    const sha = e2e.git(["rev-parse", "feat/slug-edit"]).trim();
    const close = await gantry(["upload", "--pr", "1", "--head", sha, "--close", "--merged"], env);
    expect(close).toMatchObject({ code: 0, out: `Closed ${REPO}#1 (merged).\n` });
    expect(e2eFake.state.closed.at(-1)).toMatchObject({ merged: true, head_sha: sha });

    expect(e2e.git(["status", "--short"])).toBe("");
    for (const text of printed) expect(text).not.toContain(CI_TOKEN);
  }, 120_000);
});
