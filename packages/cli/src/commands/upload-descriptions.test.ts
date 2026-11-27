import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GantryPaths,
  openStore,
  resetTeamProtocolCache,
  resolvePaths,
  storeDescriptions,
} from "@gantry/core";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { build } from "tsup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runUpload, type UploadOptions } from "./upload.js";

interface UploadFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/upload-fixture.js";
const { materializeUploadFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeUploadFixture: (
    name: string,
    opts: { dirName: string; origin?: string },
  ) => Promise<UploadFixture>;
};

const REPO = "fixture/pnpm-turbo";
const CI_TOKEN = "gct_ci-52c1e5b9a";
const USER_TOKEN = "tok-user-52d2f8e";
const KEYS = [`${"a".repeat(32)}:p1`, `${"b".repeat(32)}:p1`] as const;
const BEHAVIOR_A = "Turns a title into a lower-case slug.";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

let fx: UploadFixture;
let data: string;
let home: string;
let paths: GantryPaths;
let fake: FakeServer;

function seedDescriptions(p: GantryPaths): void {
  const store = openStore(p.dbPath);
  try {
    storeDescriptions(store, [
      {
        contentKey: KEYS[0],
        model: "haiku",
        description: {
          behavior: BEHAVIOR_A,
          searchTerms: ["slug", "title"],
          nameFits: true,
        },
      },
      {
        contentKey: KEYS[1],
        model: "haiku",
        description: {
          behavior: "Joins path parts with a slash.",
          searchTerms: ["join", "path"],
          nameFits: false,
          suggestedName: "joinPath",
        },
      },
    ]);
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  fx = await materializeUploadFixture("pnpm-turbo", {
    dirName: "pnpm-turbo",
    origin: "https://github.com/fixture/pnpm-turbo.git",
  });
  data = mkdtempSync(join(tmpdir(), "gantry-desc-data-"));
  home = join(data, "home");
  paths = resolvePaths(fx.dir, { HOME: home, CLAUDE_PLUGIN_DATA: data });
  seedDescriptions(paths);
}, 60_000);
afterAll(async () => {
  rmSync(data, { recursive: true, force: true });
  await fx.cleanup();
});

beforeEach(async () => {
  resetTeamProtocolCache();
  fake = await startFakeServer({ tokens: [CI_TOKEN, USER_TOKEN], repo: REPO });
});
afterEach(async () => {
  await fake.close();
  rmSync(paths.configPath, { force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
  requests: string[];
}

async function upload(
  opts: UploadOptions,
  env: Record<string, string | undefined> = {},
  intercept?: (url: string) => Response | undefined,
): Promise<Run> {
  const requests: string[] = [];
  let out = "";
  let err = "";
  const code = await runUpload(
    {
      paths,
      env: {
        GANTRY_CREDENTIALS_FILE: join(data, "no-credentials.json"),
        GANTRY_SERVER: fake.url,
        GANTRY_ORG: "acme",
        GANTRY_TOKEN: USER_TOKEN,
        ...env,
      },
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      fetch: async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        return intercept?.(url) ?? fetch(input, init);
      },
    },
    opts,
  );
  return { code, out, err, requests };
}

const writeConfig = (descriptions: boolean): void => {
  mkdirSync(dirname(paths.configPath), { recursive: true });
  writeFileSync(
    paths.configPath,
    JSON.stringify({ team: { server: fake.url, org: "acme", upload: { descriptions } } }),
  );
};

const descriptionRequests = (run: Run): string[] =>
  run.requests.filter((r) => r.includes("/v1/descriptions"));

describe("gantry upload --descriptions", () => {
  it("sends the model-written descriptions, prints the two lines, and stores all nine fields", async () => {
    const run = await upload({ descriptions: true });
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(run.out).toBe(`Uploading 2 descriptions for ${REPO}...\nstored 2 new\n`);
    expect(descriptionRequests(run)).toHaveLength(1);
    expect(fake.state.descriptions.size).toBe(2);
    const joined = fake.state.descriptions.get(KEYS[1]);
    expect(Object.keys(joined ?? {}).sort()).toEqual(
      [
        "behavior",
        "content_key",
        "created_at",
        "model",
        "name_fits",
        "prompt_version",
        "provenance",
        "search_terms",
        "suggested_name",
      ].sort(),
    );
    expect(joined).toMatchObject({
      behavior: "Joins path parts with a slash.",
      search_terms: ["join", "path"],
      name_fits: false,
      suggested_name: "joinPath",
      provenance: "model",
      model: "haiku",
    });
    const local = openStore(paths.dbPath);
    const row = local.db
      .prepare("SELECT created_at FROM descriptions WHERE content_key = ?")
      .get(KEYS[1]) as {
      created_at: string;
    };
    local.close();
    expect(joined?.created_at).toBe(row.created_at);
  });

  it("prints {sent, stored} under --json, and stores nothing new the second time", async () => {
    const first = await upload({ descriptions: true, json: true });
    expect(first).toMatchObject({ code: 0, out: '{"sent":2,"stored":2}\n', err: "" });
    const second = await upload({ descriptions: true, json: true });
    expect(second).toMatchObject({ code: 0, out: '{"sent":2,"stored":0}\n', err: "" });
  });

  it("is switched off by team.upload.descriptions: one line, exit 0, no request", async () => {
    writeConfig(false);
    const run = await upload({ descriptions: true }, { GANTRY_TOKEN: undefined });
    expect(run).toMatchObject({
      code: 0,
      out: "Description upload is switched off (team.upload.descriptions).\n",
      err: "",
      requests: [],
    });
    expect(fake.state.descriptions.size).toBe(0);
    const json = await upload({ descriptions: true, json: true });
    expect(json).toMatchObject({ code: 0, out: '{"sent":0,"stored":0}\n', requests: [] });
  });

  it("with no team configured sends nothing and exits 0", async () => {
    const run = await upload({ descriptions: true }, { GANTRY_SERVER: "", GANTRY_ORG: "" });
    expect(run).toMatchObject({ code: 0, out: "No team configured; nothing uploaded.\n", requests: [] });
    const json = await upload({ descriptions: true, json: true }, { GANTRY_SERVER: "", GANTRY_ORG: "" });
    expect(json).toMatchObject({ code: 0, out: '{"sent":0,"stored":0}\n', requests: [] });
  });

  it("refuses a CI token with exit 1, before any request, and prints no description text or token", async () => {
    const run = await upload({ descriptions: true }, { GANTRY_TOKEN: CI_TOKEN });
    expect(run).toMatchObject({
      code: 1,
      out: "",
      err: "Descriptions need a signed-in user. Run gantry team login.\n",
      requests: [],
    });
    expect(run.out + run.err).not.toContain(BEHAVIOR_A);
    expect(run.out + run.err).not.toContain(CI_TOKEN);
  });

  it("answers the CI line to a 403 from the server, with no description text", async () => {
    const forbidden = (url: string): Response | undefined =>
      url.includes("/v1/descriptions")
        ? new Response(JSON.stringify({ error: "forbidden", message: "a CI token cannot do this" }), {
            status: 403,
            headers: { "content-type": "application/json", "x-gantry-protocol-max": "1" },
          })
        : undefined;
    const run = await upload({ descriptions: true }, {}, forbidden);
    expect(run).toMatchObject({
      code: 1,
      err: "Descriptions need a signed-in user. Run gantry team login.\n",
    });
    expect(run.out + run.err).not.toContain(BEHAVIOR_A);
  });

  it("exits 1 with a plain line when the server answers 404", async () => {
    const missing = (url: string): Response | undefined =>
      url.includes("/v1/descriptions")
        ? new Response(JSON.stringify({ error: "not_found", message: "no such route" }), {
            status: 404,
            headers: { "content-type": "application/json", "x-gantry-protocol-max": "1" },
          })
        : undefined;
    const run = await upload({ descriptions: true }, {}, missing);
    expect(run).toMatchObject({ code: 1, err: "The server does not accept descriptions.\n" });
  });

  it("never prints the user token on a server error", async () => {
    const broken = (url: string): Response | undefined =>
      url.includes("/v1/descriptions")
        ? new Response(JSON.stringify({ error: "invalid", message: `bad ${USER_TOKEN}` }), {
            status: 400,
            headers: { "content-type": "application/json", "x-gantry-protocol-max": "1" },
          })
        : undefined;
    const run = await upload({ descriptions: true }, {}, broken);
    expect(run.code).toBe(1);
    expect(run.out + run.err).not.toContain(USER_TOKEN);
  });

  it("is a usage error (exit 2, no request) with --pr or --close", async () => {
    for (const extra of [{ pr: "1" }, { close: true, pr: "1", head: "main" }]) {
      const run = await upload({ descriptions: true, ...extra });
      expect(run).toMatchObject({
        code: 2,
        err: "--descriptions cannot be combined with --pr or --close\n",
        requests: [],
      });
    }
  });
});

// The built CLI, as a developer runs it.
describe("gantry upload --descriptions, built", () => {
  let bundleDir: string;
  let cli: string;
  let e2eFake: FakeServer;

  beforeAll(async () => {
    bundleDir = mkdtempSync(join(tmpdir(), "gantry-desc-bundle-"));
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
    e2eFake = await startFakeServer({ tokens: [USER_TOKEN], repo: REPO });
  }, 90_000);
  afterAll(async () => {
    await e2eFake?.close().catch(() => undefined); // the test closes it to prove no request is made
    rmSync(bundleDir, { recursive: true, force: true });
  });

  const gantry = (args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((resolve) => {
      const child = spawn("node", [cli, ...args], {
        cwd: fx.dir,
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          CLAUDE_PLUGIN_DATA: data,
          GANTRY_CREDENTIALS_FILE: join(home, "credentials.json"),
          GANTRY_SERVER: e2eFake.url,
          GANTRY_ORG: "acme",
          GANTRY_TOKEN: USER_TOKEN,
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
      child.on("close", (code) => resolve({ code, out, err }));
    });

  it("sends 2, then stores 0 new; switched off it makes no request", async () => {
    expect(await gantry(["upload", "--descriptions", "--json"])).toMatchObject({
      code: 0,
      out: '{"sent":2,"stored":2}\n',
    });
    expect(await gantry(["upload", "--descriptions", "--json"])).toMatchObject({
      code: 0,
      out: '{"sent":2,"stored":0}\n',
    });
    const seen = e2eFake.state.descriptions.size;
    expect(seen).toBe(2);
    // with the server gone, any request would end in exit 1: exit 0 shows none was made
    await e2eFake.close();
    mkdirSync(dirname(paths.configPath), { recursive: true });
    writeFileSync(
      paths.configPath,
      JSON.stringify({ team: { server: e2eFake.url, org: "acme", upload: { descriptions: false } } }),
    );
    const off = await gantry(["upload", "--descriptions"]);
    expect(off).toMatchObject({
      code: 0,
      out: "Description upload is switched off (team.upload.descriptions).\n",
    });
  }, 60_000);
});
