import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  type GantryPaths,
  indexRepo,
  openStore,
  resetTeamProtocolCache,
  resolvePaths,
  storeDescriptions,
} from "@gantry/core";
import { DEFAULT_PART_LIMITS, UploadRefused } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUploadParts, runUpload, serialiseBody, type UploadOptions } from "./upload.js";

// A scratch hook between the payload builders and the command: a test sets `tamper` to change the records the command
// is about to send, which is how a bug in a builder (a field that could carry source) is simulated.
const hook = vi.hoisted(() => ({
  tamper: undefined as undefined | ((record: Record<string, unknown>) => void),
}));
vi.mock("@gantry/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@gantry/core")>();
  const through = <T extends { t: string }>(records: T[]): T[] => {
    if (hook.tamper === undefined) return records;
    return records.map((r) => {
      const copy = { ...r } as Record<string, unknown>;
      hook.tamper?.(copy);
      return copy as unknown as T;
    });
  };
  return {
    ...real,
    snapshotRecords: (...args: Parameters<typeof real.snapshotRecords>) =>
      through(real.snapshotRecords(...args) as { t: string }[]),
    changeSetRecords: (...args: Parameters<typeof real.changeSetRecords>) =>
      through(real.changeSetRecords(...args) as { t: string }[]),
  };
});

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
const USER_TOKEN = "tok-user-30a7c1";
const CI_TOKEN = "gct_ci-30a7c1";
const KEYS = [`${"a".repeat(32)}:p1`, `${"b".repeat(32)}:p1`] as const;
const BEHAVIORS = ["Turns a title into a lower-case slug.", "Joins path parts with a slash."] as const;

let fx: UploadFixture;
let data: string;
let paths: GantryPaths;
let fake: FakeServer;

function seedDescriptions(): void {
  const store = openStore(paths.dbPath);
  try {
    storeDescriptions(
      store,
      KEYS.map((contentKey, i) => ({
        contentKey,
        model: "haiku",
        description: {
          behavior: BEHAVIORS[i] as string,
          searchTerms: i === 0 ? ["slug", "title"] : ["join", "path"],
          nameFits: true,
        },
      })),
    );
  } finally {
    store.close();
  }
}

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
  data = mkdtempSync(join(tmpdir(), "gantry-guard-data-"));
  paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  fx.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
}, 60_000);
afterAll(async () => {
  rmSync(data, { recursive: true, force: true });
  await fx.cleanup();
});

beforeEach(async () => {
  resetTeamProtocolCache();
  hook.tamper = undefined;
  fake = await startFakeServer({ tokens: [CI_TOKEN, USER_TOKEN], repo: REPO });
  seedDescriptions();
});
afterEach(async () => {
  hook.tamper = undefined;
  await fake.close();
  rmSync(paths.configPath, { force: true });
});

interface Request {
  method: string;
  url: string;
  body: string | undefined;
  /** The decompressed text of a gzipped part. */
  part?: string;
}
interface Run {
  code: number;
  out: string;
  err: string;
  requests: Request[];
}

async function upload(opts: UploadOptions, env: Record<string, string | undefined> = {}): Promise<Run> {
  const requests: Request[] = [];
  let out = "";
  let err = "";
  const code = await runUpload(
    {
      paths,
      env: {
        GANTRY_CREDENTIALS_FILE: join(data, "no-credentials.json"),
        GANTRY_SERVER: fake.url,
        GANTRY_ORG: "acme",
        // descriptions need a signed-in user; graphs go with the CI token
        GANTRY_TOKEN: opts.descriptions === true ? USER_TOKEN : CI_TOKEN,
        ...env,
      },
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      sleep: async () => undefined,
      fetch: async (input, init) => {
        const body = init?.body;
        requests.push({
          method: init?.method ?? "GET",
          url: String(input),
          body: typeof body === "string" ? body : undefined,
          ...(body instanceof Uint8Array ? { part: gunzipSync(body).toString("utf8") } : {}),
        });
        return fetch(input, init);
      },
    },
    opts,
  );
  return { code, out, err, requests };
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
const MAIN: UploadOptions = { forceMain: true };

const writeConfig = (descriptions: boolean): void => {
  mkdirSync(dirname(paths.configPath), { recursive: true });
  writeFileSync(
    paths.configPath,
    JSON.stringify({ team: { server: fake.url, org: "acme", upload: { descriptions } } }),
  );
};
const descriptionRequests = (run: Run): Request[] =>
  run.requests.filter((r) => r.url.includes("/v1/descriptions"));
/** Everything a run sent, as text: request bodies and decompressed parts. */
const wireText = (run: Run): string => run.requests.map((r) => `${r.body ?? ""}${r.part ?? ""}`).join("\n");

/** A scratch change to one record of the payload: set `key` to `value` on the first record of kind `t`. */
const set =
  (t: string, key: string, value: unknown) =>
  (record: Record<string, unknown>): void => {
    if (record.t === t) record[key] = value;
  };

const injections: [string, (record: Record<string, unknown>) => void, string][] = [
  ["signature", set("s", "signature", "export function slugify(title: string) {"), "signature"],
  ["body", set("s", "body", "return 1;"), "body"],
  ["fact_sheet", set("s", "fact_sheet", { calls: [] }), "fact_sheet"],
  ["source that is a language", set("f", "source", "typescript"), "source"],
  ["a string over 1,024 characters", set("s", "name", "x".repeat(1025)), "name"],
];

describe("the guard refuses before any request, on every path that builds a body", () => {
  for (const [label, tamper, field] of injections) {
    const line = `upload refused: field ${field} may carry source\n`;

    it(`main snapshot with ${label}: exit 1, the message, and not one request`, async () => {
      hook.tamper = tamper;
      const run = await upload(MAIN);
      expect(run).toMatchObject({ code: 1, out: expect.not.stringContaining("done"), requests: [] });
      expect(run.err).toBe(line);
      expect(fake.state.snapshots.size).toBe(0);
    });

    it(`dry run with ${label}: the same message, exit 1, nothing printed as a payload`, async () => {
      hook.tamper = tamper;
      const run = await upload({ dryRun: true });
      expect(run).toMatchObject({ code: 1, out: "", requests: [] });
      expect(run.err).toBe(line);
      const summary = await upload({ dryRun: true, summary: true });
      expect(summary).toMatchObject({ code: 1, out: "", requests: [] });
      expect(summary.err).toBe(line);
    });
  }

  it("a change set with an injected key: exit 1 and no request, real run and dry run", async () => {
    hook.tamper = set("n", "code", "export const a = 1;");
    const line = "upload refused: field code may carry source\n";
    const real = await upload(PR);
    expect(real).toMatchObject({ code: 1, requests: [] });
    expect(real.err).toBe(line);
    const dry = await upload({ ...PR, dryRun: true });
    expect(dry).toMatchObject({ code: 1, out: "", err: line, requests: [] });
  });

  it("a change set whose own source field is not pr or branch is refused", async () => {
    hook.tamper = set("c", "source", "typescript");
    const run = await upload(PR);
    expect(run).toMatchObject({ code: 1, requests: [] });
    expect(run.err).toBe("upload refused: field source may carry source\n");
  });

  it("under --json the refusal is one failed object with the same text, still no request", async () => {
    hook.tamper = injections[0]?.[1];
    const run = await upload({ ...MAIN, json: true });
    expect(run.code).toBe(1);
    expect(run.requests).toEqual([]);
    const lines = run.out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      kind: "main",
      status: "failed",
      error: "upload refused: field signature may carry source",
    });
  });

  it("refuses the same payload without --force-main only after the branch check, still with no request", async () => {
    hook.tamper = injections[0]?.[1];
    const run = await upload({});
    expect(run.requests).toEqual([]);
    expect(run.code).toBe(1);
    expect(run.err).toBe("upload refused: field signature may carry source\n");
  });

  it("an untouched payload passes the guard and is sent whole (the guard is not a no-op block)", async () => {
    const run = await upload(MAIN);
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(fake.state.snapshots.size).toBe(1);
    const dry = await upload({ dryRun: true });
    expect(dry.code).toBe(0);
    expect(dry.out).not.toMatch(
      /"(signature|body|text|code|snippet|doc|content|contents|fact_sheet|factSheet)":/,
    );
  });
});

describe("the description switch", () => {
  it("on: --descriptions makes one request carrying two records", async () => {
    writeConfig(true);
    const run = await upload({ descriptions: true, json: true });
    expect(run).toMatchObject({ code: 0, out: '{"status":"done","sent":2,"stored":2}\n', err: "" });
    const sent = descriptionRequests(run);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body as string).descriptions).toHaveLength(2);
    expect(fake.state.descriptions.size).toBe(2);
  });

  it("off: --descriptions prints the switched-off line, exits 0 and makes no request at all", async () => {
    writeConfig(false);
    const text = await upload({ descriptions: true });
    expect(text).toMatchObject({
      code: 0,
      out: "Description upload is switched off (team.upload.descriptions).\n",
      err: "",
      requests: [],
    });
    const json = await upload({ descriptions: true, json: true });
    expect(json).toMatchObject({
      code: 0,
      out: '{"status":"skipped","sent":0,"stored":0,"reason":"switched off"}\n',
      requests: [],
    });
    expect(fake.state.descriptions.size).toBe(0);
  });

  it("off: no /v1/descriptions request after --force-main, --pr 1 and --descriptions, and no description text on the wire", async () => {
    writeConfig(false);
    const runs = [await upload(MAIN), await upload(PR), await upload({ descriptions: true })];
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0]);
    for (const run of runs) expect(descriptionRequests(run)).toEqual([]);
    expect(runs[0]?.requests.length).toBeGreaterThan(2);
    expect(runs[1]?.requests.length).toBeGreaterThan(2);
    expect(runs[2]?.requests).toEqual([]);
    expect(fake.state.descriptions.size).toBe(0);
    for (const run of runs) for (const b of BEHAVIORS) expect(wireText(run)).not.toContain(b);
  });

  it("on or off, the main snapshot and the change set bodies carry no descriptions or behavior key", async () => {
    for (const on of [true, false]) {
      writeConfig(on);
      for (const run of [await upload(MAIN), await upload(PR)]) {
        expect(run.code).toBe(0);
        expect(descriptionRequests(run)).toEqual([]);
        const texts = run.requests.filter((r) => r.body !== undefined || r.part !== undefined);
        expect(texts.length).toBeGreaterThan(1);
        for (const r of texts) {
          expect(r.body ?? r.part).not.toMatch(/"(descriptions|behavior|search_terms|suggested_name)"/);
          for (const b of BEHAVIORS) expect(r.body ?? r.part).not.toContain(b);
        }
      }
    }
  });

  it("off: the dry run prints no description and makes no request, with --summary too", async () => {
    writeConfig(false);
    for (const extra of [{}, { summary: true }]) {
      const run = await upload({ descriptions: true, dryRun: true, ...extra });
      expect(run).toMatchObject({ code: 0, out: "", requests: [] });
      expect(run.err).toContain("Description upload is switched off (team.upload.descriptions).");
      for (const b of BEHAVIORS) expect(run.out + run.err).not.toContain(b);
    }
    writeConfig(true);
    const on = await upload({ descriptions: true, dryRun: true });
    expect(on.out.trimEnd().split("\n")).toHaveLength(1);
    expect(on.out).toContain(BEHAVIORS[0]);
    expect(on.requests).toEqual([]);
  });

  it("off: GANTRY_* environment values, a CI token and a missing token do not turn it back on", async () => {
    writeConfig(false);
    for (const env of [{ GANTRY_TOKEN: "gct_ci-30a7" }, { GANTRY_TOKEN: "" }, { GANTRY_SERVER: fake.url }]) {
      const run = await upload({ descriptions: true, json: true }, env);
      expect(run.requests).toEqual([]);
      expect(run.out).toContain('"reason":"switched off"');
    }
  });

  it("off by a team block written with only the switch and the environment naming the server", async () => {
    mkdirSync(dirname(paths.configPath), { recursive: true });
    writeFileSync(
      paths.configPath,
      JSON.stringify({ team: { server: fake.url, org: "acme", upload: { descriptions: false } } }),
    );
    const run = await upload({ descriptions: true }, { GANTRY_SERVER: fake.url, GANTRY_ORG: "acme" });
    expect(run.requests).toEqual([]);
  });
});

// A static check on the source: only the upload command may send descriptions, and it always passes the switch.
describe("no other code path sends descriptions", () => {
  const root = join(import.meta.dirname, "../../../..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx|js|mjs|cjs|sh|yml|json)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });
  const files = ["packages", "action", "plugin", "scripts"].flatMap((d) => walk(join(root, d)));

  it("finds the sources", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("names the description sender only in the command, its function and the client that holds the route", () => {
    const allowed = new Set([
      "packages/cli/src/commands/upload.ts",
      "packages/core/src/team/descriptionUpload.ts",
      "packages/core/src/team/client.ts",
      "packages/protocol/src/routes.ts",
      "packages/protocol/src/testing/fakeServer.ts",
    ]);
    const hits = files
      .filter((f) => /\b(uploadDescriptions|putDescriptions)\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .filter((f) => !allowed.has(f));
    expect(hits).toEqual([]);
  });

  it("calls uploadDescriptions only with the switch, in both places of the command", () => {
    const text = readFileSync(join(root, "packages/cli/src/commands/upload.ts"), "utf8");
    const calls = [...text.matchAll(/await uploadDescriptions\(/g)];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(text.slice(call.index, (call.index ?? 0) + 400)).toMatch(/\benabled\b/);
    }
  });

  it("starts no automatic description upload: no workflow, hook, script or skill runs --descriptions", () => {
    const hits = files
      .filter((f) => !f.endsWith("upload.ts") && /upload\b[^\n]*--descriptions/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });
});

describe("the functions that write a body refuse on their own", () => {
  const SHA = "1863607d4346a2737224baab89b421b2b1a1b8bf";
  const start = {
    kind: "main",
    sha: SHA,
    counts: { workspaces: 0, files: 0, symbols: 0, edges: 0, adapter_nodes: 0 },
  };
  const description = {
    content_key: KEYS[0],
    behavior: BEHAVIORS[0],
    search_terms: ["slug"],
    name_fits: true,
    provenance: "model",
    model: "haiku",
    prompt_version: "p1",
    created_at: "2026-03-04T05:06:07.000Z",
  };

  it("serialiseBody writes a clean body of every kind", () => {
    expect(serialiseBody("main", start)).toContain(SHA);
    expect(serialiseBody("close", { merged: true, head_sha: SHA })).toContain("merged");
    expect(serialiseBody("descriptions", { repo: REPO, descriptions: [description] })).toContain("behavior");
  });

  it("serialiseBody refuses a start, a close body and a description batch that carry a forbidden key", () => {
    const bodies: [Parameters<typeof serialiseBody>[0], unknown, string][] = [
      ["main", { ...start, signature: "x" }, "signature"],
      ["change_set", { kind: "change_set", counts: { nodes: 1, radius: 0 }, snippet: "x" }, "snippet"],
      ["close", { merged: false, content: "x" }, "content"],
      ["descriptions", { repo: REPO, descriptions: [{ ...description, text: "x" }] }, "descriptions[0].text"],
      [
        "descriptions",
        { repo: REPO, descriptions: [{ ...description, behavior: "x".repeat(1025) }] },
        "descriptions[0].behavior",
      ],
      ["descriptions", { repo: REPO, doc: "x", descriptions: [] }, "doc"],
    ];
    for (const [kind, payload, path] of bodies) {
      expect(() => serialiseBody(kind, payload)).toThrow(UploadRefused);
      try {
        serialiseBody(kind, payload);
      } catch (err) {
        expect((err as UploadRefused).path).toBe(path);
      }
    }
  });

  it("buildUploadParts refuses a record with a forbidden key before it compresses anything", () => {
    const good = { t: "w", id: `ws:${REPO}:.`, name: "root", path: "." } as const;
    expect(buildUploadParts([good], DEFAULT_PART_LIMITS, SHA).parts).toHaveLength(1);
    const bad = { ...good, signature: "x" } as unknown as typeof good;
    expect(() => buildUploadParts([good, bad], DEFAULT_PART_LIMITS, SHA)).toThrow(UploadRefused);
    expect(() => buildUploadParts([good, bad], DEFAULT_PART_LIMITS, SHA)).toThrow(
      "upload refused: field signature may carry source",
    );
  });
});
