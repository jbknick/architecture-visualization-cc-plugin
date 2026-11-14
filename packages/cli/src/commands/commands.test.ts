import { spawnSync } from "node:child_process";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, type Store } from "@gantry/core";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: join(dataDir, "home"), CLAUDE_PLUGIN_DATA: dataDir, ...extraEnv },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function fixture(name: "single-pkg" | "pnpm-turbo" | "nx") {
  const fx = await materializeFixture(name);
  fixtures.push(fx);
  return fx;
}

/** A function with 9 statements, so it is above the code-embedding floor. */
const BIG_FN =
  "export function sumPositive(xs: number[]) {\n  let total = 0;\n  for (const x of xs) {\n    if (x > 0) {\n      total += x;\n    }\n  }\n  const avg = total / xs.length;\n  return { total, avg };\n}\n" +
  "export function sumNegative(xs: number[]) {\n  let total = 0;\n  for (const x of xs) {\n    if (x < 0) {\n      total -= x;\n    }\n  }\n  const avg = total / xs.length;\n  return { total, avg };\n}\n";

describe("gantry init", () => {
  it("indexes fixtures/pnpm-turbo, prints a summary and exits 0 without touching the repo", async () => {
    const fx = await fixture("pnpm-turbo");
    const r = run(fx.dir, ["init"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Indexed \d+ files in \d+ ms/);
    expect(r.out).toMatch(/symbols:\s+\d+/);
    expect(r.out).toMatch(/function-like:\s+\d+/);
    expect(r.out).toMatch(/edges:\s+\d+/);
    expect(r.out).toMatch(/unresolved:\s+\d+/);
    expect(r.out).not.toContain("Descriptions not estimated");
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("--estimate prints every estimate field for pnpm-turbo and makes no model calls", async () => {
    const fx = await fixture("pnpm-turbo");
    const r = run(fx.dir, ["init", "--estimate"]);
    expect(r.err).toBe("");
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
  it("opens the store with migration v2 (sqlite-vec resolves from the bundle)", async () => {
    const fx = await fixture("single-pkg");
    const r = run(fx.dir, ["init"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const db = openBundleDb();
    try {
      expect(db.getMeta("schema_version")).toBe("2");
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
    expect(r.err).toBe("");
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

describe("gantry search / node", () => {
  it("search 'relative date' lists formatRelativeDate first, as a table and as JSON", async () => {
    const fx = await fixture("pnpm-turbo");
    const t = run(fx.dir, ["search", "relative date"]);
    expect(t.err).toBe("");
    expect(t.code).toBe(0);
    const lines = t.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^NAME\s+KIND\s+LOCATION\s+SCORE$/);
    expect(lines[1]).toMatch(/^formatRelativeDate\s+function\s+packages\/utils\/src\/date\.ts:1\s+\d/);
    expect(t.out).not.toContain("\u001b[");

    const j = JSON.parse(run(fx.dir, ["search", "relative date", "--json"]).out);
    expect(j[0]).toMatchObject({ name: "formatRelativeDate", kind: "function" });
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
    expect(info.neighbors["contains:in"]).toContain("file:packages/utils/src/date.ts");
    expect(typeof info.fanIn).toBe("number");

    const text = run(fx.dir, ["node", "packages/utils/src/date.ts:5"]);
    expect(text.out).toContain("formatRelativeDate (function, exported)");
    expect(text.out).toMatch(/EDGE\s+NODE/);
    expect(run(fx.dir, ["node", "packages/utils/src/date.ts:999"]).code).toBe(1);
  });

  it("lookups heal and refresh first: a new uncommitted file is searchable without init", async () => {
    const fx = await fixture("single-pkg");
    writeFileSync(join(fx.dir, "brand-new.ts"), "export function brandNewThing() { return 1; }\n");
    const r = run(fx.dir, ["search", "brand new thing", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)[0]).toMatchObject({ name: "brandNewThing" });
  });

  it.each([["search", "x"], ["node", "x"], ["usage"], ["config", "get", "precommit.mode"]])(
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
