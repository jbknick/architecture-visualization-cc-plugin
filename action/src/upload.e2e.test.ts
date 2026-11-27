// End to end for the upload step: the script (action/src/upload-main.ts, bundled here) runs the real CLI (plugin/bin/gantry)
// against the fake protocol server, on a copy of fixtures/pnpm-turbo, for fake GitHub event files of a push, a pull
// request, a closed and merged pull request and a fork. Bundled from source in beforeAll. No network beyond 127.0.0.1.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, startFakeServer } from "../../packages/protocol/src/testing/index.js";

interface TestBundle {
  home: string;
  cleanup(): void;
}
// The shared helper (scripts/testBundle.ts) is outside this project's file list, so it is loaded by a computed path.
const helperPath = "../../scripts/testBundle.js";
const { bundlePlugin } = (await import(/* @vite-ignore */ helperPath)) as {
  bundlePlugin: (names: string[]) => Promise<TestBundle>;
};

const root = join(import.meta.dirname, "../..");
let home: string;
let script: string;
let bundle: TestBundle | undefined;
const REPO = "fixture/pnpm-turbo";
const TOKEN = "gct_e2e-5d2a9b1f";

interface Fixture {
  dir: string;
  main: string;
  feature: string;
}
let work: string;
let fx: Fixture;
let fake: FakeServer;
let proxy: Server;
let proxyUrl: string;
let requests = 0;
let data: string;

const git = (cwd: string, ...args: string[]): string =>
  spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "E2E",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "E2E",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  }).stdout.trim();

/** A server in front of the fake one that counts the requests it gets. */
function startProxy(target: string): Promise<Server> {
  const t = new URL(target);
  const server = createServer((req, res) => {
    requests++;
    const up = request(
      { host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function run(env: Record<string, string>, cwd = fx.dir): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [script], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(work, "home"),
        CLAUDE_PLUGIN_DATA: data,
        GANTRY_CREDENTIALS_FILE: join(work, "no-credentials.json"),
        GANTRY_HOME: home,
        GITHUB_REPOSITORY: REPO,
        GANTRY_SERVER: proxyUrl,
        GANTRY_ORG: "acme",
        GANTRY_TOKEN: TOKEN,
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** The values action.yml hands the step, taken from a GitHub event file the way its `${{ }}` expressions do. */
function eventEnv(name: string, file: string, ref = "refs/heads/main"): Record<string, string> {
  const e = JSON.parse(readFileSync(file, "utf8")) as {
    action?: string;
    repository?: { default_branch?: string };
    pull_request?: {
      number: number;
      title: string;
      merged?: boolean;
      created_at: string;
      user: { login: string };
      base: { sha: string; ref: string };
      head: { sha: string; ref: string; repo: { full_name: string } };
    };
  };
  const pr = e.pull_request;
  return {
    GANTRY_EVENT: name,
    GANTRY_EVENT_ACTION: e.action ?? "",
    GITHUB_REF: ref,
    GANTRY_REF_NAME: ref.replace(/^refs\/heads\//, ""),
    GANTRY_DEFAULT_BRANCH: e.repository?.default_branch ?? "",
    GANTRY_PR: pr ? String(pr.number) : "",
    GANTRY_PR_BASE_SHA: pr?.base.sha ?? "",
    GANTRY_PR_HEAD_SHA: pr?.head.sha ?? "",
    GANTRY_PR_OWNER: pr?.user.login ?? "",
    GANTRY_PR_TITLE: pr?.title ?? "",
    GANTRY_PR_HEAD_REF: pr?.head.ref ?? "",
    GANTRY_PR_BASE_BRANCH: pr?.base.ref ?? "",
    GANTRY_PR_CREATED_AT: pr?.created_at ?? "",
    GANTRY_PR_MERGED: pr ? String(pr.merged ?? false) : "",
    GANTRY_HEAD_REPO: pr?.head.repo.full_name ?? "",
  };
}

function writeEvent(name: string, body: unknown): string {
  const file = join(work, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

const pullRequest = (action: string, over: { merged?: boolean; headRepo?: string } = {}) => ({
  action,
  repository: { default_branch: "main", full_name: REPO },
  pull_request: {
    number: 1,
    title: "Allow underscores in slugs",
    merged: over.merged ?? false,
    created_at: "2026-01-01T00:00:00Z",
    user: { login: "maya" },
    base: { sha: fx.main, ref: "main" },
    head: { sha: fx.feature, ref: "feat/slug-edit", repo: { full_name: over.headRepo ?? REPO } },
  },
});

beforeAll(async () => {
  bundle = await bundlePlugin(["cli", "upload"]);
  home = bundle.home;
  script = join(home, "dist/upload.js");
  work = mkdtempSync(join(tmpdir(), "gantry-upload-e2e-"));
  mkdirSync(join(work, "home"));
  const dir = join(work, "pnpm-turbo");
  const cp = spawnSync("cp", ["-R", join(root, "fixtures/pnpm-turbo"), dir]);
  if (cp.status !== 0) throw new Error("cannot copy the fixture");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", `https://github.com/${REPO}.git`);
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-q", "-m", "base");
  const main = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feat/slug-edit");
  const slug = join(dir, "packages/utils/src/slug.ts");
  const text = readFileSync(slug, "utf8");
  writeFileSync(
    slug,
    text.replace('dashed.replace(/[^a-z0-9-]/g, "")', 'dashed.replace(/[^a-z0-9_-]/g, "")'),
  );
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-q", "-m", "edit");
  const feature = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  fx = { dir, main, feature };
}, 60_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  bundle?.cleanup();
});

beforeEach(async () => {
  data = mkdtempSync(join(work, "data-"));
  fake = await startFakeServer({ tokens: [TOKEN], repo: REPO });
  proxy = await startProxy(fake.url);
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  requests = 0;
});
afterEach(async () => {
  await new Promise((r) => proxy.close(r));
  await fake.close();
});

const warnings = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("::warning"));

describe("upload step, end to end", () => {
  it("a push to the default branch stores a main snapshot with the counts of `gantry index --dump`", async () => {
    const file = writeEvent("push", { repository: { default_branch: "main" } });
    const r = await run(eventEnv("push", file));
    expect(r.code).toBe(0);
    expect(warnings(r.out)).toEqual([]);
    const stored = fake.state.snapshots.get(REPO);
    expect(stored?.sha).toBe(fx.main);

    const dump = spawnSync("node", [join(home, "dist/cli.js"), "index", "--dump"], {
      cwd: fx.dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: mkdtempSync(join(work, "dump-")), HOME: join(work, "home") },
    });
    expect(dump.status).toBe(0);
    const graph = JSON.parse(dump.stdout) as Record<string, unknown[]>;
    expect(stored?.workspaces).toHaveLength(graph.workspaces?.length ?? -1);
    expect(stored?.files).toHaveLength(graph.files?.length ?? -1);
    expect(stored?.symbols).toHaveLength(graph.symbols?.length ?? -1);
    expect(stored?.edges).toHaveLength(graph.edges?.length ?? -1);
    expect(r.out).not.toContain(TOKEN);
  }, 120_000);

  it("a push to another branch uploads nothing", async () => {
    const file = writeEvent("push-other", { repository: { default_branch: "main" } });
    const r = await run(eventEnv("push", file, "refs/heads/feature"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("upload skipped: push to feature is not the default branch (main)");
    expect(requests).toBe(0);
  });

  it("a pull request event stores one change set for the pull request", async () => {
    const file = writeEvent("pr-opened", pullRequest("opened"));
    const r = await run(eventEnv("pull_request", file, "refs/pull/1/merge"));
    expect(r.code).toBe(0);
    expect(warnings(r.out)).toEqual([]);
    expect([...fake.state.changeSets.keys()]).toEqual([`cs:pr:${REPO}#1`]);
    expect(r.out).not.toContain(TOKEN);
  }, 120_000);

  it("a closed and merged pull request sends the close body with the head sha and merged: true", async () => {
    const opened = writeEvent("pr-opened", pullRequest("opened"));
    expect((await run(eventEnv("pull_request", opened, "refs/pull/1/merge"))).code).toBe(0);
    const closed = writeEvent("pr-closed", pullRequest("closed", { merged: true }));
    const r = await run(eventEnv("pull_request", closed, "refs/pull/1/merge"));
    expect(r.code).toBe(0);
    expect(warnings(r.out)).toEqual([]);
    expect(fake.state.closed).toEqual([
      { id: `cs:pr:${REPO}#1`, repo: REPO, merged: true, head_sha: fx.feature },
    ]);
  }, 120_000);

  it("a closed pull request that was not merged sends merged: false", async () => {
    const opened = writeEvent("pr-opened", pullRequest("opened"));
    expect((await run(eventEnv("pull_request", opened, "refs/pull/1/merge"))).code).toBe(0);
    const closed = writeEvent("pr-closed", pullRequest("closed"));
    expect((await run(eventEnv("pull_request", closed, "refs/pull/1/merge"))).code).toBe(0);
    expect(fake.state.closed[0]).toMatchObject({ merged: false, head_sha: fx.feature });
  }, 120_000);

  it("a pull request from a fork uploads nothing: zero requests", async () => {
    for (const action of ["opened", "closed"]) {
      const file = writeEvent(`fork-${action}`, pullRequest(action, { headRepo: "mallory/pnpm-turbo" }));
      const r = await run(eventEnv("pull_request", file, "refs/pull/1/merge"));
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe("fork: upload skipped");
    }
    expect(requests).toBe(0);
    expect(fake.state.uploads.size).toBe(0);
    expect(fake.state.closed).toEqual([]);
  });

  it("with the server down each event ends with exit 0 and one warning line, and no token", async () => {
    await new Promise((r) => proxy.close(r));
    const events: [string, string, string][] = [
      ["push", writeEvent("down-push", { repository: { default_branch: "main" } }), "refs/heads/main"],
      ["pull_request", writeEvent("down-open", pullRequest("opened")), "refs/pull/1/merge"],
      [
        "pull_request",
        writeEvent("down-close", pullRequest("closed", { merged: true })),
        "refs/pull/1/merge",
      ],
    ];
    for (const [name, file, ref] of events) {
      const r = await run(eventEnv(name, file, ref));
      expect(r.code).toBe(0);
      expect(warnings(r.out)).toHaveLength(1);
      expect(warnings(r.out)[0]).toMatch(/^::warning title=Gantry::upload failed: \S/);
      expect(r.out).not.toContain(TOKEN);
    }
    // the afterEach closes the proxy again; give it something to close
    proxy = createServer().listen(0, "127.0.0.1");
  }, 180_000);
});
