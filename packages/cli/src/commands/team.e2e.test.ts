import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "@gantry/core";
import { PROTOCOL_VERSION } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { build } from "tsup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
const USER_TOKEN = "tok-user-7c1e5b";
let bundleDir: string;
let cli: string;

// The same bundle the other command tests run: the real CLI entry, built from source.
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "gantry-team-bundle-"));
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
}, 60_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

interface Seen {
  method: string;
  path: string;
  org: string | undefined;
  authorization: string | undefined;
}

/** Forwards to the fake server and remembers what each request carried (headers are not otherwise visible). */
async function recordingProxy(
  target: string,
): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const h = req.headers;
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        org: h["x-gantry-org"] as string | undefined,
        authorization: h.authorization,
      });
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`${target}${req.url}`, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(h).filter(([k]) => k !== "host" && typeof h[k] === "string"),
        ) as Record<string, string>,
        ...(body.length === 0 ? {} : { body }),
      });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

let fx: MaterializedFixture;
let home: string;
let pluginData: string;
let credentials: string;
let fake: FakeServer;
let proxy: Awaited<ReturnType<typeof recordingProxy>>;
let repoName: string;
const outputs: string[] = [];

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: home,
    CLAUDE_PLUGIN_DATA: pluginData,
    GANTRY_CREDENTIALS_FILE: credentials,
    GANTRY_DEVICE_POLL_MS: "30",
    GANTRY_SERVER: "",
    GANTRY_ORG: "",
    GANTRY_TOKEN: "",
    ...extra,
  };
}

/** Runs the built CLI in the fixture repo. `onOut` sees stdout as it arrives (login prints its code, then waits). */
function gantry(
  args: string[],
  extraEnv: Record<string, string> = {},
  onOut?: (text: string) => void,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("node", [cli, ...args], { cwd: fx.dir, env: baseEnv(extraEnv) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      onOut?.(out);
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      outputs.push(out, err);
      resolve({ code, out, err });
    });
  });
}

/** `login`, approving the code as soon as it is printed. */
function login(extraArgs: string[] = [], extraEnv: Record<string, string> = {}): Promise<Run> {
  let approved = false;
  return gantry(["team", "login", ...extraArgs], extraEnv, (text) => {
    const m = /([0-9A-F]{4})-([0-9A-F]{4})/.exec(text);
    if (m && !approved) {
      approved = fake.state.approveDevice(`${m[1]}${m[2]}`);
    }
  });
}

const mode = (p: string): number => statSync(p).mode & 0o777;

beforeEach(async () => {
  fx = await materializeFixture("single-pkg");
  home = mkdtempSync(join(tmpdir(), "gantry-team-home-"));
  pluginData = mkdtempSync(join(tmpdir(), "gantry-team-data-"));
  credentials = join(home, "dot-gantry", "credentials.json");
  repoName = resolvePaths(fx.dir, { HOME: home, CLAUDE_PLUGIN_DATA: pluginData }).repo;
  fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN], repo: repoName });
  proxy = await recordingProxy(fake.url);
  outputs.length = 0;
});
afterEach(async () => {
  await proxy.close();
  await fake.close();
  await fx.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(pluginData, { recursive: true, force: true });
});

describe("gantry team, built, against the fake server", () => {
  it("links, signs in, reports the connection and signs out", async () => {
    const server = proxy.url;
    const configFile = resolvePaths(fx.dir, { HOME: home, CLAUDE_PLUGIN_DATA: pluginData }).configPath;

    const linked = await gantry(["team", "link", "--server", server, "--org", "acme"]);
    expect(linked.code).toBe(0);
    expect(linked.out).toBe(`Linked ${repoName} to acme on ${server}. Run gantry team login.\n`);
    expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ team: { server, org: "acme" } });
    expect(existsSync(credentials)).toBe(false);

    const signedIn = await login();
    expect(signedIn.code).toBe(0);
    expect(signedIn.out).toMatch(
      /^Open http:\/\/127\.0\.0\.1\/device\?user_code=[0-9A-F]{8} and check that the page shows this code:\n\n {4}[0-9A-F]{4}-[0-9A-F]{4}\n/,
    );
    expect(signedIn.out).toContain(`Signed in as octo-dev on ${server}.\n`);
    expect(mode(credentials)).toBe(0o600);
    expect(mode(dirname(credentials))).toBe(0o700);
    expect(JSON.parse(readFileSync(credentials, "utf8")).servers[server]).toMatchObject({
      token: USER_TOKEN,
      user: "octo-dev",
    });

    const status = await gantry(["team", "status", "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toEqual({
      server,
      org: "acme",
      user: "octo-dev",
      repo: repoName,
      reachable: true,
      protocol: PROTOCOL_VERSION,
      cache: { change_sets: 0, pulled_at: null, age_s: null, last_error: null },
    });
    expect(proxy.seen.filter((s) => s.path.startsWith("/v1/whoami?")).map((s) => s.org)).toContain("acme");

    const linkedAgain = await gantry(["team", "link", "--server", server, "--org", "acme"]);
    expect(linkedAgain.out).toBe(`Linked ${repoName} to acme on ${server}.\n`);

    const out = await gantry(["team", "logout"]);
    expect(out.code).toBe(0);
    expect(readFileSync(credentials, "utf8")).not.toContain(USER_TOKEN);
    expect(mode(credentials)).toBe(0o600);
    const after = await gantry(["team", "status", "--json"]);
    expect(after.code).toBe(1);
    expect(JSON.parse(after.out)).toMatchObject({ user: null, reachable: true });

    // The token is in the credentials file while signed in and in no output, ever.
    expect(outputs.join("\n")).not.toContain(USER_TOKEN);
    expect(readFileSync(configFile, "utf8")).not.toContain(USER_TOKEN);
  });

  it("signs in before any link: no organization is sent and the user is stored", async () => {
    const signedIn = await login(["--server", proxy.url]);
    expect(signedIn.code).toBe(0);
    const whoami = proxy.seen.filter((s) => s.path.startsWith("/v1/whoami"));
    expect(whoami).toHaveLength(1);
    expect(whoami[0]?.org).toBeUndefined();
    expect(whoami[0]?.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(JSON.parse(readFileSync(credentials, "utf8")).servers[proxy.url].user).toBe("octo-dev");
    expect(outputs.join("\n")).not.toContain(USER_TOKEN);
  });

  it("works from three environment variables alone and writes nothing", async () => {
    const env = { GANTRY_SERVER: proxy.url, GANTRY_ORG: "acme", GANTRY_TOKEN: USER_TOKEN };
    const status = await gantry(["team", "status", "--json"], env);
    expect(status.code).toBe(0);
    expect(status.out).toBe(
      `${JSON.stringify({ server: proxy.url, org: "acme", user: "octo-dev", repo: repoName, reachable: true, protocol: PROTOCOL_VERSION, cache: { change_sets: 0, pulled_at: null, age_s: null, last_error: null } })}\n`,
    );
    expect(existsSync(credentials)).toBe(false);
    expect(readdirSync(pluginData)).toEqual([]);
    expect(fx.git(["status", "--short"])).toBe("");
    expect(outputs.join("\n")).not.toContain(USER_TOKEN);
  });
  it("pulls into team-cache.db, reads it without the network, and keeps it when the server is gone", async () => {
    // an origin remote gives the repo an owner/name, which the pull's change sets must carry
    fx.git(["remote", "add", "origin", "https://github.com/acme/storefront.git"]);
    const repo = "acme/storefront";
    await fake.close();
    fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN], repo }); // for this repo name
    for (const n of [1, 2]) {
      const id = `cs:pr:${repo}#${n}`;
      fake.state.changeSets.set(id, {
        id,
        repo,
        source: "pr",
        state: "in_review",
        ref: `#${n}`,
        head_ref: `feat/${n}`,
        base_branch: "main",
        nodes: [`file:${repo}:src/a${n}.ts`],
        radius: [],
        estimated: false,
        owner: "octo-dev",
        title: `Change ${n}`,
        pr: n,
        head_sha: "7e3d9a1c5b8f20466d1ae9c3b7f45082d6c1e9ab",
        created_at: "2026-11-20T09:15:00.000Z",
        updated_at: `2026-11-20T09:4${n}:12.000Z`,
        links: [],
      });
    }
    const env = { GANTRY_SERVER: fake.url, GANTRY_ORG: "acme", GANTRY_TOKEN: USER_TOKEN };

    const before = await gantry(["team", "status", "--json"], env);
    expect(JSON.parse(before.out).cache).toEqual({
      change_sets: 0,
      pulled_at: null,
      age_s: null,
      last_error: null,
    });

    const pulled = await gantry(["team", "status", "--pull"], env);
    expect(pulled.code).toBe(0);
    expect(pulled.out).toMatch(/\ncache: {5}2 open changes, pulled \d+ s ago\n$/);

    // without --pull, status reads the file and asks the server nothing about team state
    const read = await gantry(["team", "status", "--json"], env);
    expect(JSON.parse(read.out).cache).toMatchObject({ change_sets: 2, last_error: null });
    const pulledAt = JSON.parse(read.out).cache.pulled_at as string;

    const url = fake.url;
    await fake.close();
    const down = await gantry(["team", "status", "--pull", "--json"], { ...env, GANTRY_SERVER: url });
    expect(down.code).toBe(1);
    const cache = JSON.parse(down.out).cache as {
      change_sets: number;
      pulled_at: string;
      last_error: string;
    };
    expect(cache.change_sets).toBe(2);
    expect(cache.pulled_at).toBe(pulledAt);
    expect(cache.last_error).toContain("team_unreachable");
    expect(down.err).toBe("");
    fake = await startFakeServer();
  }, 30_000);
});
