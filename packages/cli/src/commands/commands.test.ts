import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, resolvePaths, type Store } from "@gantry/core";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (
    name: string,
    opts?: { feature?: boolean; dirName?: string },
  ) => Promise<MaterializedFixture>;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
let bundleDir: string;
let cli: string;
let dataDir: string;
const fixtures: MaterializedFixture[] = [];

// Bundle the real CLI entry exactly like tsup.config.ts does (native deps external), so these tests
// prove the bundled artifact works: schema DDL included, native modules resolvable.
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "gantry-cli-bundle-"));
  dataDir = mkdtempSync(join(tmpdir(), "gantry-cli-data-"));
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
      o.alias = { "@gantry/core": join(repoRoot, "packages/core/src/index.ts") };
    },
    silent: true,
    dts: false,
    config: false,
  });
  cli = join(bundleDir, "dist/cli.js");
}, 60_000);

afterAll(async () => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

/** The one stderr line a first `init` in a data dir without an index prints. */
const FRESH_NOTE = (repoDir: string): string =>
  `gantry: no index for this repository in ${resolvePaths(repoDir, { HOME: join(dataDir, "home"), CLAUDE_PLUGIN_DATA: dataDir }).dataDir}; building a fresh one\n`;

function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: join(dataDir, "home"), CLAUDE_PLUGIN_DATA: dataDir, ...extraEnv },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function fixture(name: "single-pkg" | "pnpm-turbo" | "nx" | "adapters") {
  const fx = await materializeFixture(name);
  fixtures.push(fx);
  return fx;
}

/** A function with 9 statements, so it is above the code-embedding floor. */
const BIG_FN =
  "export function sumPositive(xs: number[]) {\n  let total = 0;\n  for (const x of xs) {\n    if (x > 0) {\n      total += x;\n    }\n  }\n  const avg = total / xs.length;\n  return { total, avg };\n}\n" +
  "export function sumNegative(xs: number[]) {\n  let total = 0;\n  for (const x of xs) {\n    if (x < 0) {\n      total -= x;\n    }\n  }\n  const avg = total / xs.length;\n  return { total, avg };\n}\n";

describe("gantry init: one data directory", () => {
  it("builds a fresh index in an empty plugin data dir, says so on stderr and leaves ~/.gantry/data untouched", async () => {
    const fx = await fixture("pnpm-turbo");
    const home = mkdtempSync(join(tmpdir(), "gantry-onedir-home-"));
    const plugin = mkdtempSync(join(tmpdir(), "gantry-onedir-plugin-"));
    try {
      const hash = resolvePaths(fx.dir, { HOME: home }).worktreeHash;
      const legacyDb = join(home, ".gantry/data/repos", hash, "gantry.db");
      expect(run(fx.dir, ["init"], { HOME: home, CLAUDE_PLUGIN_DATA: "" }).code).toBe(0);
      const sha = () => createHash("sha256").update(readFileSync(legacyDb)).digest("hex");
      const before = sha();
      const r = run(fx.dir, ["init"], { HOME: home, CLAUDE_PLUGIN_DATA: plugin });
      expect(r.code).toBe(0);
      expect(r.err).toContain(`no index for this repository in ${join(plugin, "repos", hash)}`);
      expect(existsSync(join(plugin, "repos", hash, "gantry.db"))).toBe(true);
      expect(sha()).toBe(before);
      expect(run(fx.dir, ["init"], { HOME: home, CLAUDE_PLUGIN_DATA: plugin }).err).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(plugin, { recursive: true, force: true });
    }
  });
});

describe("gantry init", () => {
  it("indexes fixtures/pnpm-turbo, prints a summary and exits 0 without touching the repo", async () => {
    const fx = await fixture("pnpm-turbo");
    const r = run(fx.dir, ["init"]);
    expect(r.err).toBe(FRESH_NOTE(fx.dir));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Indexed \d+ files in \d+ ms/);
    expect(r.out).toMatch(/symbols:\s+\d+/);
    expect(r.out).toMatch(/function-like:\s+\d+/);
    expect(r.out).toMatch(/edges:\s+\d+/);
    expect(r.out).toMatch(/unresolved:\s+\d+/);
    expect(r.out).not.toContain("Descriptions not estimated");
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("reports the same file and edge counts as /api/meta, and one function-like count in --estimate", async () => {
    const fx = await fixture("pnpm-turbo");
    const r = run(fx.dir, ["init", "--estimate"]);
    expect(r.code).toBe(0);
    const summary = (label: string): number =>
      Number(
        ((new RegExp(`${label}:\\s+([\\d,]+)`).exec(r.out) as RegExpExecArray)[1] as string).replace(
          /,/g,
          "",
        ),
      );
    const files = Number((/Indexed (\d+) files/.exec(r.out) as RegExpExecArray)[1]);
    const functionLike = [...r.out.matchAll(/function-like:\s+([\d,]+)/g)].map((m) => m[1]);
    expect(functionLike).toHaveLength(2);
    expect(functionLike[0]).toBe(functionLike[1]);

    const explorerPath = "../../../explorer/server/index.js";
    const { handleApi } = (await import(/* @vite-ignore */ explorerPath)) as {
      handleApi: (
        ctx: unknown,
        pathname: string,
        query: URLSearchParams,
      ) => { counts: Record<string, number> };
    };
    const paths = resolvePaths(fx.dir, { HOME: join(dataDir, "home"), CLAUDE_PLUGIN_DATA: dataDir });
    const store = openStore(paths.dbPath);
    try {
      const { counts } = handleApi({ store, paths, config: {} }, "/api/meta", new URLSearchParams());
      expect(files).toBe(counts.files);
      expect(summary("edges")).toBe(counts.edges);
      expect(summary("symbols")).toBe(counts.symbols);
    } finally {
      store.close();
    }
  });

  it("--estimate prints every estimate field for pnpm-turbo and makes no model calls", async () => {
    const fx = await fixture("pnpm-turbo");
    const r = run(fx.dir, ["init", "--estimate"]);
    expect(r.err).toBe(FRESH_NOTE(fx.dir));
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("not estimated");
    const num = (label: string): number => {
      const m = new RegExp(`${label}:\\s+([\\d,]+)`).exec(r.out);
      expect(m, label).not.toBeNull();
      return Number(((m as RegExpExecArray)[1] as string).replace(/,/g, ""));
    };
    const toDescribe = num("to describe");
    expect(num("function-like")).toBeGreaterThan(0);
    expect(num("templated")).toBeGreaterThan(0);
    expect(toDescribe).toBeGreaterThan(0);
    expect(num("input tokens")).toBe(950 * toDescribe);
    expect(num("output tokens")).toBe(250 * toDescribe);
    expect(num("batches")).toBe(Math.ceil(toDescribe / 40));
    expect(num("rounds")).toBe(Math.ceil(Math.ceil(toDescribe / 40) / 4));
    expect(r.out).toContain("0.96 s per function");
    expect(r.out).not.toMatch(/subagent/i);
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("--estimate --exports-first counts only priority 0-1 functions", async () => {
    const fx = await fixture("pnpm-turbo");
    const all = run(fx.dir, ["init", "--estimate"]);
    const first = run(fx.dir, ["init", "--estimate", "--exports-first"]);
    expect(first.code).toBe(0);
    const get = (out: string, label: string): number =>
      Number(
        ((new RegExp(`${label}:\\s+([\\d,]+)`).exec(out) as RegExpExecArray)[1] as string).replace(/,/g, ""),
      );
    expect(get(first.out, "function-like")).toBeLessThanOrEqual(get(all.out, "function-like"));
    expect(get(first.out, "to describe")).toBeLessThanOrEqual(get(all.out, "to describe"));
    expect(first.out).toContain("exported and entry-file functions only");
  });

  it("exits 2 outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-nogit-"));
    try {
      const r = run(dir, ["init"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("Not a git repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Opens the database the bundled CLI wrote last (each fixture repo has its own under the data dir). */
function openBundleDb(): Store {
  const repos = join(dataDir, "repos");
  const dbs = readdirSync(repos)
    .map((d) => join(repos, d, "gantry.db"))
    .filter((d) => existsSync(d))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); // the repo indexed last comes first
  if (!dbs[0]) throw new Error("no gantry.db written");
  return openStore(dbs[0]);
}

describe("bundled CLI: vector tables and embeddings", () => {
  it("opens the store with its vec tables (sqlite-vec resolves from the bundle)", async () => {
    const fx = await fixture("single-pkg");
    const r = run(fx.dir, ["init"]);
    expect(r.err).toBe(FRESH_NOTE(fx.dir));
    expect(r.code).toBe(0);
    const db = openBundleDb();
    try {
      expect(db.getMeta("schema_version")).toBe("13");
      expect(db.getMeta("vec_available")).toBe("1");
      expect(db.getMeta("embed_model")).toBe("jinaai/jina-embeddings-v2-base-code");
      expect(db.getMeta("embed_dim")).toBe("768");
      const tables = (
        db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      ).map((t) => t.name);
      expect(tables).toContain("vec_descriptions");
      expect(tables).toContain("vec_code");
    } finally {
      db.close();
    }
  });

  const modelDir = join(process.env.HOME ?? "", ".gantry", "models");
  const haveModel = existsSync(
    join(modelDir, "jinaai/jina-embeddings-v2-base-code/onnx/model_quantized.onnx"),
  );
  it("does not embed by default: no model load, no vectors, no warning, even with no model cache", async () => {
    const fx = await fixture("single-pkg");
    writeFileSync(join(fx.dir, "src/embedme.ts"), BIG_FN);
    fx.git(["add", "-A"]);
    fx.git(["commit", "-m", "add embedme"]);
    // A model dir that does not exist: any attempt to load the model would print a warning on stderr.
    const t0 = Date.now();
    const r = run(fx.dir, ["init"], { GANTRY_MODELS_DIR: join(dataDir, "no-models-here") });
    const ms = Date.now() - t0;
    expect(r.err).toBe(FRESH_NOTE(fx.dir));
    expect(r.code).toBe(0);
    expect(ms).toBeLessThan(15_000);
    const db = openBundleDb();
    try {
      expect(db.db.prepare("SELECT count(*) AS n FROM vec_code").get()).toEqual({ n: 0 });
      expect(db.db.prepare("SELECT count(*) AS n FROM vec_descriptions").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  const eligibleCode = (db: Store): number =>
    (
      db.db
        .prepare(
          "SELECT count(DISTINCT exact_hash) AS n FROM symbols WHERE kind IN ('function','method','component','hook') AND stmt_count >= 3",
        )
        .get() as { n: number }
    ).n;
  const storedCode = (db: Store): number =>
    (db.db.prepare("SELECT count(*) AS n FROM vec_code").get() as { n: number }).n;

  it.skipIf(!haveModel)(
    "gantry init --embed and gantry embed use the external transformers/onnxruntime packages and resume",
    async () => {
      const fx = await fixture("single-pkg");
      writeFileSync(join(fx.dir, "src/embedme.ts"), BIG_FN);
      fx.git(["add", "-A"]);
      fx.git(["commit", "-m", "add embedme"]);
      const env = { GANTRY_MODELS_DIR: modelDir };
      expect(run(fx.dir, ["init"], env).code).toBe(0);
      let db = openBundleDb();
      const eligible = eligibleCode(db);
      expect(eligible).toBeGreaterThan(1);
      expect(storedCode(db)).toBe(0);
      db.close();

      const first = run(fx.dir, ["embed", "--limit", "1", "--json"], env);
      expect(first.code).toBe(0);
      // Template descriptions are embedded before code, so one vector of either kind was stored.
      const j1 = JSON.parse(first.out) as { descriptions: number; code: number; stoppedBy: string };
      expect(j1.descriptions + j1.code).toBe(1);
      expect(j1.stoppedBy).toBe("limit");

      const second = run(fx.dir, ["embed", "--json"], env);
      expect(second.code).toBe(0);
      expect(JSON.parse(second.out)).toMatchObject({
        remaining: 0,
        stoppedBy: "complete",
      });
      db = openBundleDb();
      expect(storedCode(db)).toBe(eligible);
      db.close();

      // `init --embed` on an already complete store embeds nothing more and prints the summary.
      const again = run(fx.dir, ["init", "--embed"], env);
      expect(again.code).toBe(0);
      expect(again.out).toContain("Embedded 0 code");
    },
    120_000,
  );
});

describe("gantry index --dump", () => {
  it.each(["single-pkg", "pnpm-turbo", "nx"] as const)(
    "%s dump equals the committed snapshot and is byte-identical across runs",
    async (name) => {
      const fx = await fixture(name);
      expect(run(fx.dir, ["init"]).code).toBe(0);
      const a = run(fx.dir, ["index", "--dump"]);
      const b = run(fx.dir, ["index", "--dump"]);
      expect(a.code).toBe(0);
      expect(a.out).toBe(b.out);
      const snap = readFileSync(join(repoRoot, `packages/core/src/__snapshots__/dump-${name}.json`), "utf8");
      expect(a.out).toBe(snap);
      expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
    },
  );

  it("two clones at different paths give byte-identical dumps, with the same origin and with no remote", () => {
    const clone = (parent: string, remote: string | null): string => {
      const dir = join(parent, "repo");
      mkdirSync(dir, { recursive: true });
      cpSync(join(repoRoot, "fixtures/pnpm-turbo"), dir, { recursive: true });
      const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init", "-q", "-b", "main");
      git("add", "-A", "-f");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
      if (remote) git("remote", "add", "origin", remote);
      return dir;
    };
    const dump = (dir: string): string => {
      const data = mkdtempSync(join(tmpdir(), "gantry-dump-data-"));
      try {
        const r = run(dir, ["index", "--dump"], { CLAUDE_PLUGIN_DATA: data });
        expect(r.code).toBe(0);
        return r.out;
      } finally {
        rmSync(data, { recursive: true, force: true });
      }
    };
    const base = mkdtempSync(join(tmpdir(), "gantry-clones-"));
    try {
      const url = "https://github.com/example/pnpm-turbo.git";
      const a = clone(join(base, "x"), url);
      const b = clone(join(base, "y", "z"), url);
      const da = dump(a);
      expect(da).toBe(dump(b));
      expect(JSON.parse(da).files[0].id).toMatch(/^file:example\/pnpm-turbo:/);
      expect(da).not.toContain(base);
      expect(da).not.toContain(resolvePaths(a, { HOME: "/home/x" }).worktreeHash);

      spawnSync("git", ["remote", "remove", "origin"], { cwd: a });
      spawnSync("git", ["remote", "remove", "origin"], { cwd: b });
      const na = dump(a);
      expect(na).toBe(dump(b));
      expect(JSON.parse(na).files[0].id).toMatch(/^file:repo:/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects an invalid --layer with exit 1", async () => {
    const fx = await fixture("single-pkg");
    expect(run(fx.dir, ["index", "--layer", "nope"]).code).toBe(1);
  });
});

describe("gantry heal", () => {
  it("reports an incremental heal after a commit and a no-op afterwards", async () => {
    const fx = await fixture("pnpm-turbo");
    expect(run(fx.dir, ["init"]).code).toBe(0);
    writeFileSync(join(fx.dir, "packages/utils/src/extra.ts"), "export const extra = 1;\n");
    fx.git(["add", "-A"]);
    fx.git(["commit", "-q", "-m", "extra"]);
    const a = run(fx.dir, ["heal"]);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/^Healed 1 file \(incremental\) in \d+ ms$/m);
    expect(run(fx.dir, ["heal"]).out).toMatch(/^Healed 0 files \(incremental\)/m);
    expect(run(fx.dir, ["heal", "--from", "deadbeef"]).out).toMatch(/\(full re-index\)/);
  });
});

describe("gantry review", () => {
  it("on fixtures/deep-radius lists the reachable tier and matches the committed snapshot from two fresh data dirs", async () => {
    // The directory is named `repo`, as in `scripts/fixture-repo.ts deep-radius <tmp>/repo`, so the ids match the snapshot.
    const fx = await materializeFixture("deep-radius", { feature: true, dirName: "repo" });
    fixtures.push(fx);
    const outs: string[] = [];
    for (const name of ["deep-radius-1", "deep-radius-2"]) {
      const env = { CLAUDE_PLUGIN_DATA: join(dataDir, name), HOME: join(dataDir, name, "home") };
      expect(run(fx.dir, ["init"], env).code).toBe(0);
      const r = run(fx.dir, ["review", "main...feature", "--json"], env);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      outs.push(r.out);
    }
    expect(outs[1]).toBe(outs[0]);
    await expect(outs[0]).toMatchFileSnapshot(join(repoRoot, "fixtures/deep-radius.review.json"));
  }, 60_000);

  it("prints the symbol diff as JSON on a clean stdout, creates no data dir and leaves the repo alone", async () => {
    const fx = await fixture("pnpm-turbo");
    fx.git(["checkout", "-b", "feature"]);
    const file = join(fx.dir, "packages/utils/src/slug.ts");
    const extra = "export function slugifyAll(xs: string[]): string[] {\n  return xs.map(slugify);\n}\n";
    writeFileSync(file, `${readFileSync(file, "utf8")}${extra}`);
    fx.git(["add", "-A"]);
    fx.git(["commit", "-m", "add"]);
    const data = join(dataDir, "review-data");
    const r = run(fx.dir, ["review", "main...feature", "--json"], { CLAUDE_PLUGIN_DATA: data });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as {
      base: string;
      head: string;
      files: { path: string; status: string }[];
      changes: { id: string; kind: string }[];
    };
    expect(j.base).toBe("main");
    expect(j.head).toBe("feature");
    expect(j.files).toEqual([{ path: "packages/utils/src/slug.ts", status: "M" }]);
    expect(j.changes.map((c) => [c.kind, c.id])).toEqual([
      ["added", "sym:pnpm-turbo:packages/utils/src/slug.ts#slugifyAll"],
    ]);
    expect(existsSync(data)).toBe(false);
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("fails with a clear message for a bad range, an unknown ref and a missing mode", async () => {
    const fx = await fixture("pnpm-turbo");
    const bad = run(fx.dir, ["review", "main", "--json"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("expected <base>...<head>");
    expect(bad.out).toBe("");
    const unknown = run(fx.dir, ["review", "main...nope", "--json"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown git ref: nope");
    expect(unknown.out).toBe("");
    expect(run(fx.dir, ["review", "--json"]).code).toBe(1);
  });

  it("prints a short text summary without --json: risk, reasons, hop counts, crossings, consumers", async () => {
    const fx = await fixture("pnpm-turbo");
    fx.git(["checkout", "-b", "feature"]);
    const file = join(fx.dir, "packages/ui/src/button.tsx");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "{ label: string; onClick?: () => void }",
        "{ label: string; onClick?: () => void; size?: number }",
      ),
    );
    fx.git(["add", "-A"]);
    fx.git(["commit", "-m", "button"]);
    const env = { CLAUDE_PLUGIN_DATA: join(dataDir, "review-text-data") };
    const r = run(fx.dir, ["review", "main...feature"], env);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Risk: medium (56/100)");
    expect(r.out).toContain("+30 signature changed on an exported symbol");
    expect(r.out).toContain(
      "hop 1: 3 (file:pnpm-turbo:packages/ui/src/index.ts, sym:pnpm-turbo:apps/web/src/routes/index.tsx#HomePage",
    );
    expect(r.out).toContain("Crossings: 2");
    expect(r.out).toContain(
      [
        "Consumers of sym:pnpm-turbo:packages/ui/src/button.tsx#Button:",
        "  Directly affected (3):",
        "    index.ts (file, packages/ui/src/index.ts) imports",
        "    HomePage (component, apps/web/src/routes/index.tsx:7) renders; crosses app",
        "    ProfilePage (component, apps/web/src/routes/settings/profile.tsx:7) renders; crosses app",
        "  Potentially affected (",
      ].join("\n"),
    );
    expect(r.out).toMatch(/\/ \(route, apps\/web\/src\/routes\/index\.tsx\) serves hop 2 via HomePage/);
    expect(r.out).toBe(run(fx.dir, ["review", "main...feature"], env).out);
  });

  it("--json adds the impact from the index as it is (no heal, no re-index) once the repo is indexed", async () => {
    const fx = await fixture("pnpm-turbo");
    const env = { CLAUDE_PLUGIN_DATA: join(dataDir, "review-json-impact") };
    expect(run(fx.dir, ["init"], env).code).toBe(0);
    const db = resolvePaths(fx.dir, { HOME: join(dataDir, "home"), ...env }).dbPath;
    expect(existsSync(db)).toBe(true);
    fx.git(["checkout", "-b", "feature"]);
    const file = join(fx.dir, "packages/ui/src/button.tsx");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "{ label: string; onClick?: () => void }",
        "{ label: string; onClick?: () => void; size?: number }",
      ),
    );
    fx.git(["add", "-A"]);
    fx.git(["commit", "-m", "button"]);
    const before = openStore(db);
    const indexedAt = before.headSha();
    before.close();
    const r = run(fx.dir, ["review", "main...feature", "--json"], env);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as {
      changes: { id: string }[];
      impact: {
        risk: { score: number; level: string };
        callersByHop: { hop: number; ids: string[] }[];
        consumers: {
          id: string;
          target: string;
          direct: { id: string; uses: string[]; crosses: string[] }[];
          directTotal: number;
          potential: { id: string; hop: number; via: string }[];
          potentialTotal: number;
        }[];
      } | null;
    };
    expect(j.changes.map((c) => c.id)).toEqual(["sym:pnpm-turbo:packages/ui/src/button.tsx#Button"]);
    expect(j.impact?.risk).toMatchObject({ score: 56, level: "medium" });
    const button = j.impact?.consumers.find(
      (c) => c.id === "sym:pnpm-turbo:packages/ui/src/button.tsx#Button",
    );
    expect(button?.target).toBe("symbol");
    expect(button?.directTotal).toBe(3);
    expect(button?.direct[1]).toMatchObject({
      id: "sym:pnpm-turbo:apps/web/src/routes/index.tsx#HomePage",
      uses: ["renders"],
      crosses: ["app"],
    });
    expect(
      button?.potential.some(
        (p) => p.hop === 2 && p.via === "sym:pnpm-turbo:apps/web/src/routes/index.tsx#HomePage",
      ),
    ).toBe(true);
    expect(j.impact?.consumers.map((c) => c.id)).toContain("file:pnpm-turbo:packages/ui/src/button.tsx");
    expect(j.impact?.callersByHop[0]?.ids).toContain("sym:pnpm-turbo:apps/web/src/routes/index.tsx#HomePage");
    // The index was not brought to the new HEAD: --json never heals.
    const after = openStore(db);
    expect(after.headSha()).toBe(indexedAt);
    after.close();
  });

  it("--json prints the same bytes on every run and from fresh data dirs, with no ms field", async () => {
    const fx = await fixture("pnpm-turbo");
    const env1 = { CLAUDE_PLUGIN_DATA: join(dataDir, "review-stable-1") };
    const env2 = { CLAUDE_PLUGIN_DATA: join(dataDir, "review-stable-2") };
    const file = join(fx.dir, "packages/utils/src/slug.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}\nexport const extra = (s: string) => s.trim();\n`);
    fx.git(["add", "-A"]);
    fx.git(["commit", "-m", "change"]);
    expect(run(fx.dir, ["init"], env1).code).toBe(0);
    expect(run(fx.dir, ["init"], env2).code).toBe(0);
    const first = run(fx.dir, ["review", "HEAD~1...HEAD", "--json"], env1);
    expect(first.code).toBe(0);
    expect(first.out).not.toContain('"ms"');
    expect((JSON.parse(first.out) as { changes: unknown[] }).changes.length).toBeGreaterThan(0);
    expect(run(fx.dir, ["review", "HEAD~1...HEAD", "--json"], env1).out).toBe(first.out);
    expect(run(fx.dir, ["review", "HEAD~1...HEAD", "--json"], env2).out).toBe(first.out);
  });

  it("--open starts the explorer like gantry_open_view and opens the review view of the range", async () => {
    const fx = await fixture("pnpm-turbo");
    const data = join(dataDir, "review-open");
    const bin = join(dataDir, "fake-open-bin");
    mkdirSync(bin, { recursive: true });
    const opened = join(dataDir, "opened.txt");
    for (const name of ["open", "xdg-open"])
      writeFileSync(join(bin, name), `#!/bin/sh\necho "$1" >> "${opened}"\n`, { mode: 0o755 });
    const env = { CLAUDE_PLUGIN_DATA: data, PATH: `${bin}:${process.env.PATH ?? ""}` };
    expect(run(fx.dir, ["init"], env).code).toBe(0);
    fx.git(["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(fx.dir, "packages/utils/src/extra.ts"), "export function extra() {\n  return 1;\n}\n");
    fx.git(["add", "-A"]);
    fx.git(["commit", "-q", "-m", "extra"]);
    const r = run(fx.dir, ["review", "main...feature", "--open"], env);
    try {
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const url =
        /Review view: (http:\/\/127\.0\.0\.1:\d+\/\?t=[^#\s]+#\/review\?range=main\.\.\.feature)\n/.exec(
          r.out,
        )?.[1];
      expect(url).toBeDefined();
      for (let i = 0; i < 50 && !existsSync(opened); i++) await new Promise((res) => setTimeout(res, 50));
      expect(readFileSync(opened, "utf8").trim()).toBe(url);
      // The explorer answers the review view with the same range.
      const u = new URL(url as string);
      const token = u.searchParams.get("t") ?? "";
      const res = await fetch(
        `${u.origin}/api/view/review?filters=${encodeURIComponent(JSON.stringify({ range: "main...feature" }))}`,
        { headers: { "x-gantry-token": token } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { review: { changes: { id: string; kind: string }[] } };
      expect(body.review.changes).toEqual([
        expect.objectContaining({ id: "sym:pnpm-turbo:packages/utils/src/extra.ts#extra", kind: "added" }),
      ]);
    } finally {
      const f = join(resolvePaths(fx.dir, { HOME: join(dataDir, "home"), ...env }).dataDir, "explorer.json");
      if (existsSync(f))
        process.kill((JSON.parse(readFileSync(f, "utf8")) as { pid: number }).pid, "SIGTERM");
    }
  });

  it("--pr takes only a pull request number", async () => {
    const fx = await fixture("pnpm-turbo");
    for (const bad of ["abc", "0", "7x", "-1", "1e3"]) {
      const r = run(fx.dir, ["review", "--pr", bad, "--json"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`invalid pull request number: ${bad}`);
      expect(r.out).toBe("");
    }
  });

  it("--pr without a usable gh prints the range form as the way out", async () => {
    const fx = await fixture("pnpm-turbo");
    const bin = join(dataDir, "fake-gh-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n", { mode: 0o755 });
    const r = run(fx.dir, ["review", "--pr", "7", "--json"], { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/gh pr view 7 failed \(not logged in\)/);
    expect(r.err).toContain("gantry review <base>...<head>");
    expect(r.out).toBe("");
  });
});

describe("gantry search / node", () => {
  it("search 'relative date' lists formatRelativeDate first, as a table and as JSON", async () => {
    const fx = await fixture("pnpm-turbo");
    const t = run(fx.dir, ["search", "relative date"]);
    expect(t.err).toBe("");
    expect(t.code).toBe(0);
    const lines = t.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^NAME\s+KIND\s+LANG\s+LOCATION\s+SCORE$/);
    expect(lines[1]).toMatch(
      /^formatRelativeDate\s+function\s+TypeScript\s+packages\/utils\/src\/date\.ts:1\s+\d/,
    );
    expect(t.out).not.toContain("\u001b[");

    const j = JSON.parse(run(fx.dir, ["search", "relative date", "--json"]).out);
    expect(j[0]).toMatchObject({ name: "formatRelativeDate", kind: "function", lang: "typescript" });
    // #220: --lang filters by language and rejects an unknown one.
    const ts = JSON.parse(run(fx.dir, ["search", "relative date", "--lang", "typescript", "--json"]).out);
    expect(ts.map((h: { id: string }) => h.id)).toEqual(j.map((h: { id: string }) => h.id));
    expect(JSON.parse(run(fx.dir, ["search", "relative date", "--lang", "go", "--json"]).out)).toEqual([]);
    const bad = run(fx.dir, ["search", "relative date", "--lang", "cobol"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("Unknown --lang 'cobol'");
    // #175: description text leaves only as untrusted_description, never under a plain key.
    for (const h of j) {
      expect(Object.keys(h)).toContain("untrusted_description");
      expect(Object.keys(h)).not.toContain("description");
    }
    expect(run(fx.dir, ["search", "zzzqqq"]).out).toBe("No matches\n");
    expect(JSON.parse(run(fx.dir, ["search", "date", "--kind", "const", "--json"]).out)).toEqual([]);
    expect(run(fx.dir, ["search", "date", "--kind", "bogus"]).code).toBe(1);
  });

  it("node path:line --json returns the symbol and neighbors grouped by edge kind", async () => {
    const fx = await fixture("pnpm-turbo");
    const r = run(fx.dir, ["node", "packages/utils/src/date.ts:5", "--json"]);
    expect(r.code).toBe(0);
    const info = JSON.parse(r.out);
    expect(info.node).toMatchObject({
      name: "formatRelativeDate",
      kind: "function",
      path: "packages/utils/src/date.ts",
    });
    expect(info.node.minhash).toBeUndefined();
    expect(info.neighbors["contains:in"]).toContain("file:pnpm-turbo:packages/utils/src/date.ts");
    expect(typeof info.fanIn).toBe("number");

    const text = run(fx.dir, ["node", "packages/utils/src/date.ts:5"]);
    expect(text.out).toContain("formatRelativeDate (function, exported)");
    expect(text.out).toMatch(/EDGE\s+NODE/);
    expect(run(fx.dir, ["node", "packages/utils/src/date.ts:999"]).code).toBe(1);
  });

  it("node accepts the short forms of ids and prints the full id", async () => {
    const fx = await fixture("pnpm-turbo");
    for (const target of [
      "packages/utils/src/date.ts",
      "file:packages/utils/src/date.ts",
      "file:pnpm-turbo:packages/utils/src/date.ts",
    ]) {
      const r = run(fx.dir, ["node", target, "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).node.id).toBe("file:pnpm-turbo:packages/utils/src/date.ts");
    }
    const sym = run(fx.dir, ["node", "sym:packages/utils/src/date.ts#formatRelativeDate", "--json"]);
    expect(JSON.parse(sym.out).node.id).toBe("sym:pnpm-turbo:packages/utils/src/date.ts#formatRelativeDate");
  });

  it("lookups heal and refresh first: a new uncommitted file is searchable without init", async () => {
    const fx = await fixture("single-pkg");
    writeFileSync(join(fx.dir, "brand-new.ts"), "export function brandNewThing() { return 1; }\n");
    const r = run(fx.dir, ["search", "brand new thing", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)[0]).toMatchObject({ name: "brandNewThing" });
  });

  it.each([["search", "x"], ["node", "x"], ["trace", "x"], ["usage"], ["config", "get", "precommit.mode"]])(
    "%s exits 2 outside a git repository",
    (...args) => {
      const dir = mkdtempSync(join(tmpdir(), "gantry-nogit-"));
      try {
        const r = run(dir, args);
        expect(r.code).toBe(2);
        expect(r.err).toContain("Not a git repository");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("gantry trace", () => {
  it("traces a page down to its endpoints and tables, and a table up to its pages, as text and JSON", async () => {
    const fx = await fixture("adapters");
    const down = run(fx.dir, ["trace", "route:@demo/web:/posts/$postId", "--json"]);
    expect(down.code).toBe(0);
    const d = JSON.parse(down.out);
    expect(d).toMatchObject({
      target: "route:adapters:@demo/web:/posts/$postId",
      direction: "down",
      truncated: false,
    });
    const ids = d.chain.map((s: { id: string }) => s.id);
    expect(ids).toContain("ep:adapters:@demo/api:rpc posts.get");
    expect(ids).toContain("table:adapters:posts");

    const text = run(fx.dir, ["trace", "/posts/$postId"]);
    expect(text.code).toBe(0);
    expect(text.out.split("\n")[0]).toBe("Down from route:adapters:@demo/web:/posts/$postId");
    expect(text.out).toContain("requests → endpoint ep:adapters:@demo/api:rpc posts.get");
    expect(text.out).not.toContain("(low confidence)");
    expect(text.out).toContain('unmatched client call "rpc posts.archive"');

    const up = JSON.parse(run(fx.dir, ["trace", "table:posts", "--json"]).out);
    expect(up.direction).toBe("up");
    expect(
      up.chain.filter((s: { kind: string }) => s.kind === "route").map((s: { id: string }) => s.id),
    ).toEqual(["route:adapters:@demo/web:/posts/$postId"]);
    expect(run(fx.dir, ["trace", "no-such-thing"]).code).toBe(1);
  });
});

describe("gantry usage", () => {
  it("prints an empty table and [] as JSON in M1", async () => {
    const fx = await fixture("single-pkg");
    const t = run(fx.dir, ["usage"]);
    expect(t.code).toBe(0);
    expect(t.out.trimEnd().split("\n")).toHaveLength(1);
    expect(t.out).toMatch(/^TASK\s+MODEL\s+RUNS/);
    expect(JSON.parse(run(fx.dir, ["usage", "--json"]).out)).toEqual([]);
  });
});

describe("gantry config", () => {
  it("sets and gets a value, persisting it in the project config", async () => {
    const fx = await fixture("single-pkg");
    expect(run(fx.dir, ["config", "get", "precommit.mode"]).out).toBe("off\n");
    const s = run(fx.dir, ["config", "set", "precommit.mode", "timeboxed"]);
    expect(s.err).toBe("");
    expect(s.code).toBe(0);
    expect(run(fx.dir, ["config", "get", "precommit.mode"]).out).toBe("timeboxed\n");
    expect(run(fx.dir, ["config", "set", "precommit.budgetMs", "1234"]).code).toBe(0);
    expect(run(fx.dir, ["config", "get", "precommit.budgetMs"]).out).toBe("1234\n");
    expect(run(fx.dir, ["config", "set", "exclude", '["a/**","b"]']).code).toBe(0);
    expect(JSON.parse(run(fx.dir, ["config", "get", "exclude"]).out)).toEqual(["a/**", "b"]);
    expect(JSON.parse(run(fx.dir, ["config", "get", "precommit"]).out)).toMatchObject({
      mode: "timeboxed",
      budgetMs: 1234,
    });
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("sets the optional worker.binary (the headless worker's claude path)", async () => {
    const fx = await fixture("single-pkg");
    expect(run(fx.dir, ["config", "set", "worker.binary", "/opt/claude/bin/claude"]).code).toBe(0);
    expect(run(fx.dir, ["config", "get", "worker.binary"]).out).toBe("/opt/claude/bin/claude\n");
    expect(run(fx.dir, ["config", "set", "worker.other", "1"]).code).toBe(1);
  });

  it("rejects invalid values and unknown keys with a clear message and leaves the config alone", async () => {
    const fx = await fixture("single-pkg");
    const bad = run(fx.dir, ["config", "set", "precommit.mode", "sometimes"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/Invalid value for precommit\.mode/);
    expect(run(fx.dir, ["config", "get", "precommit.mode"]).out).toBe("off\n");
    const num = run(fx.dir, ["config", "set", "precommit.budgetMs", "-5"]);
    expect(num.code).toBe(1);
    expect(num.err).toMatch(/Invalid value for precommit\.budgetMs/);
    const unknown = run(fx.dir, ["config", "set", "nope.key", "1"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("Unknown config key: nope.key");
    expect(run(fx.dir, ["config", "get", "nope"]).code).toBe(1);
  });
});

describe("gantry backlog", () => {
  it("prints counts by status and priority, as text and as JSON, without writing to the repo", async () => {
    const fx = await fixture("pnpm-turbo");
    expect(run(fx.dir, ["init"]).code).toBe(0);
    const j = run(fx.dir, ["backlog", "--json"]);
    expect(j.code).toBe(0);
    const c = JSON.parse(j.out) as {
      total: number;
      byStatus: { pending: number; claimed: number; failed: number };
      byPriority: Record<string, { pending: number; claimed: number; failed: number; total: number }>;
    };
    expect(c.total).toBeGreaterThan(0);
    expect(c.byStatus.pending).toBe(c.total);
    expect(c.byStatus.claimed + c.byStatus.failed).toBe(0);
    const sum = Object.values(c.byPriority).reduce((n, v) => n + v.total, 0);
    expect(sum).toBe(c.total);
    for (const k of Object.keys(c.byPriority)) expect(["0", "1", "2"]).toContain(k);
    const t = run(fx.dir, ["backlog"]);
    expect(t.code).toBe(0);
    expect(t.out).toContain(`Backlog: ${c.total} (pending ${c.byStatus.pending}, claimed 0, failed 0)`);
    expect(t.out).toMatch(/\n {2}priority \d: /);
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("reports zeros and indexed: false for a repository with no index, and creates no data dir", async () => {
    const fx = await fixture("single-pkg");
    const before = existsSync(join(dataDir, "repos")) ? readdirSync(join(dataDir, "repos")) : [];
    const c = JSON.parse(run(fx.dir, ["backlog", "--json"]).out);
    expect(c).toMatchObject({
      total: 0,
      byStatus: { pending: 0, claimed: 0, failed: 0 },
      byPriority: {},
      indexed: false,
    });
    expect(c.data_dir).toMatch(
      new RegExp(`^${dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/repos/[0-9a-f]{16}$`),
    );
    const text = run(fx.dir, ["backlog"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`No Gantry index for this repository in ${c.data_dir}`);
    // Neither backlog, usage nor heal creates the data dir of a repository that has no index (#147).
    expect(run(fx.dir, ["usage", "--json"]).out.trim()).toBe("[]");
    const h = run(fx.dir, ["heal"]);
    expect(h.code).toBe(0);
    expect(h.err).toContain("no index for this repository");
    const after = existsSync(join(dataDir, "repos")) ? readdirSync(join(dataDir, "repos")) : [];
    expect(after.sort()).toEqual(before.sort());
    expect(existsSync(c.data_dir)).toBe(false);
  });

  it("prints the data dir it read, as text and as JSON, after init", async () => {
    const fx = await fixture("single-pkg");
    const init = run(fx.dir, ["init"]);
    const dir = /data:\s+(\S+)/.exec(init.out)?.[1];
    expect(dir).toBeDefined();
    const j = JSON.parse(run(fx.dir, ["backlog", "--json"]).out);
    expect(j).toMatchObject({ data_dir: dir, indexed: true });
    expect(run(fx.dir, ["backlog"]).out).toContain(`Data: ${dir}`);
  });

  it("--failed lists failed functions with rule names only, and --retry-failed puts them back to pending", async () => {
    const fx = await fixture("pnpm-turbo");
    expect(run(fx.dir, ["init"]).code).toBe(0);
    const dir = JSON.parse(run(fx.dir, ["backlog", "--json"]).out).data_dir as string;
    const MARK = "zqxmarkerzq";
    const db = openStore(join(dir, "gantry.db"));
    let keys: string[];
    try {
      keys = (
        db.db.prepare("SELECT content_key FROM backlog ORDER BY priority, symbol_id LIMIT 2").all() as {
          content_key: string;
        }[]
      ).map((r) => r.content_key);
      const set = db.db.prepare(
        "UPDATE backlog SET status = 'failed', attempts = 2, last_error = ? WHERE content_key = ?",
      );
      set.run(`identifier: ${MARK}… is not a word`, keys[0]);
      set.run(`injection: searchTerms: ${MARK} imperative term`, keys[1]);
    } finally {
      db.close();
    }
    const j = JSON.parse(run(fx.dir, ["backlog", "--failed", "--json"]).out) as {
      failed: { content_key: string; symbol_id: string; reason: string; field?: string; attempts: number }[];
    };
    expect(j.failed.map((f) => [f.content_key, f.reason, f.field, f.attempts])).toEqual([
      [keys[0], "identifier", undefined, 2],
      [keys[1], "injection", "searchTerms", 2],
    ]);
    const text = run(fx.dir, ["backlog", "--failed"]);
    expect(text.out).toMatch(/^Failed: 2 /);
    expect(text.out).toMatch(/ identifier {2}attempts 2$/m);
    // Description text never appears, only rule names.
    expect(`${text.out}${JSON.stringify(j)}`).not.toContain(MARK);

    const r = JSON.parse(run(fx.dir, ["backlog", "--retry-failed", "--json"]).out);
    expect(r.retried).toBe(2);
    const c = JSON.parse(run(fx.dir, ["backlog", "--json"]).out);
    expect(c.byStatus.failed).toBe(0);
    expect(JSON.parse(run(fx.dir, ["backlog", "--failed", "--json"]).out).failed).toEqual([]);
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("counts fallback descriptions (written without a model) as JSON and as text (#150)", async () => {
    const fx = await fixture("single-pkg");
    expect(run(fx.dir, ["init"]).code).toBe(0);
    const before = JSON.parse(run(fx.dir, ["backlog", "--json"]).out);
    expect(before.fallback).toBe(0);
    expect(run(fx.dir, ["backlog"]).out).not.toContain("Fallback descriptions");
    const db = openStore(join(before.data_dir as string, "gantry.db"));
    try {
      db.db
        .prepare(
          `INSERT INTO descriptions(content_key, behavior, search_terms, name_fits, provenance, model, prompt_version, created_at)
           VALUES ('k:p1', 'Defines a function (generated without a model).', '["function"]', 1, 'fallback', NULL, 'p1', 'now')`,
        )
        .run();
    } finally {
      db.close();
    }
    expect(JSON.parse(run(fx.dir, ["backlog", "--json"]).out).fallback).toBe(1);
    expect(run(fx.dir, ["backlog"]).out).toContain("Fallback descriptions (written without a model): 1");
  });
});

describe("gantry recipe check and the recipe on index", () => {
  const commit = (fx: MaterializedFixture, msg: string) => {
    fx.git(["add", "-A", "-f"]);
    fx.git(["commit", "-q", "-m", msg]);
  };
  const endpoints = (dump: string): number =>
    (JSON.parse(dump).adapterNodes as { kind: string }[]).filter((n) => n.kind === "endpoint").length;

  it("checks the committed recipe of fixtures/adapters: every rule ok, exit 0", async () => {
    const fx = await fixture("adapters");
    const r = run(fx.dir, ["recipe", "check"]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n").filter((l) => l.startsWith("hono-") || l.startsWith("tanstack-"));
    expect(lines.length).toBe(11);
    for (const l of lines) expect(l).toContain("schema ok, examples ok");
    expect(r.out).toContain("recipe ok");
    const j = JSON.parse(run(fx.dir, ["recipe", "check", "--json"]).out);
    expect(j.errors).toEqual([]);
    expect(j.rules.find((x: { id: string }) => x.id === "hono-route").matches).toBeGreaterThan(0);
  });

  it("a rule that fails its schema is one error naming it, exit 1; the rest of the recipe still runs", async () => {
    const fx = await fixture("adapters");
    const file = join(fx.dir, ".gantry/recipe.json");
    const recipe = JSON.parse(readFileSync(file, "utf8"));
    recipe.rules.find((x: { id: string }) => x.id === "hono-mount").rule = { pattern: 42 };
    writeFileSync(file, JSON.stringify(recipe, null, 2));
    const r = run(fx.dir, ["recipe", "check", "--json"]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.errors).toHaveLength(1);
    expect(j.errors[0]).toContain("hono-mount");
    expect(j.rules.find((x: { id: string }) => x.id === "hono-mount").valid).toBe(false);
    commit(fx, "broken rule");
    const idx = run(fx.dir, ["index", "--dump"]);
    expect(idx.code).toBe(0);
    expect(idx.err).toContain("Gantry: recipe rule hono-mount skipped:");
    expect(endpoints(idx.out)).toBeGreaterThan(0);
  });

  it("a rule whose example does not match is reported and exits 1; zero matches is only a warning", async () => {
    const fx = await fixture("adapters");
    const file = join(fx.dir, ".gantry/recipe.json");
    const recipe = JSON.parse(readFileSync(file, "utf8"));
    const rule = recipe.rules.find((x: { id: string }) => x.id === "hono-app");
    rule.examples.match.push("const nothing = 1;");
    recipe.rules.push({
      id: "never",
      language: "typescript",
      rule: { pattern: "neverCalledAnywhere($A)" },
      emit: { kind: "router" },
      examples: { match: ["neverCalledAnywhere(1)"], noMatch: [] },
    });
    writeFileSync(file, JSON.stringify(recipe, null, 2));
    const r = run(fx.dir, ["recipe", "check", "--json"]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.rules.find((x: { id: string }) => x.id === "hono-app").examples.failed).toHaveLength(1);
    const never = j.rules.find((x: { id: string }) => x.id === "never");
    expect(never.matches).toBe(0);
    expect(never.warning).toBeDefined();
    expect(never.examples.failed).toEqual([]);
  });

  it("--nodes lists what the index makes with file and line, bounded by --limit; counts stay the default (#367)", async () => {
    const fx = await fixture("adapters");
    const plain = run(fx.dir, ["recipe", "check"]);
    expect(plain.out).not.toContain("nodes the index makes");
    const r = run(fx.dir, ["recipe", "check", "--nodes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("4 routes, 7 endpoints, 3 middleware, 2 tables, 5 reads, 3 writes");
    expect(r.out).toContain("endpoint GET /health  apps/server/src/app.ts:15");
    expect(r.out).toMatch(/^ {2}read posts {2}packages\/db\/src\/queries\.ts:8 {2}in listPosts$/m);
    const small = run(fx.dir, ["recipe", "check", "--nodes", "--limit", "2"]);
    expect(small.out).toContain("... 5 more endpoints (raise --limit to see them)");
    expect(small.out.split("\n").filter((l) => l.startsWith("  endpoint "))).toHaveLength(2);
    const j = JSON.parse(run(fx.dir, ["recipe", "check", "--nodes", "--json"]).out);
    expect(j.nodes.totals.endpoint).toBe(7);
    expect(
      j.nodes.entries.some(
        (e: { kind: string; file: string; line: number }) => e.kind === "endpoint" && e.line > 0,
      ),
    ).toBe(true);
    expect(run(fx.dir, ["recipe", "check", "--limit", "0", "--nodes"]).code).toBe(1);
  });

  it("an extra path argument gets a usage hint, not a bare 'too many arguments' (#367)", async () => {
    const fx = await fixture("adapters");
    const r = run(fx.dir, ["recipe", "check", ".gantry/recipe.json", "."]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("too many arguments");
    expect(r.err).toContain('unexpected extra argument "."');
    expect(r.err).toContain("gantry recipe check [<file>]");
    expect(r.err).toContain("current directory");
  });

  it("index prints no recipe line at all when there is no recipe, and exits 0", async () => {
    const fx = await fixture("adapters");
    fx.git(["rm", "-q", "-r", ".gantry"]);
    fx.git(["commit", "-q", "-m", "norecipe"]);
    const r = run(fx.dir, ["index", "--dump"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/recipe/i);
    expect(run(fx.dir, ["recipe", "check"]).code).toBe(1);
  });
});
