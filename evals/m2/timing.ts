/**
 * Pre-commit timing (issue #32, step 4): the wall time of a real `git commit` of 20 changed .ts/.tsx files with the
 * Gantry pre-commit hook, in `off` mode and in `timeboxed` mode at two budgets (8000 and 20000 ms).
 * Timeboxed runs make model calls (the headless worker) when logged in; each run starts from a fresh copy of the
 * data dir so the staged functions are undescribed every time.
 *
 * Usage: CLAUDE_PLUGIN_DATA=<data dir of the clone> pnpm tsx evals/m2/timing.ts <clone> [--repeats 3]
 * The clone is a throwaway: it is reset to its starting HEAD at the end. Writes `timing.json` (private) and prints
 * aggregates. Nothing is written to ~/.gantry: the hook is a script in a temp dir wired with core.hooksPath.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isIndexable, loadConfig, openStore, resolvePaths } from "../../packages/core/src/index.js";
import { cliJs, git, table, writePrivate } from "./lib.js";
import { assertThrowawayCopy, requireDataDir } from "./safety.js";

const repo = resolve(process.argv[2] ?? "");
const rArg = process.argv.indexOf("--repeats");
const repeats = rArg >= 0 ? Number(process.argv[rArg + 1]) : 3;
const dataSrc = requireDataDir();
assertThrowawayCopy(repo);
const FILES = 20;

const startHead = git(repo, ["rev-parse", "HEAD"]).trim();
const paths = resolvePaths(repo);
const config = loadConfig(paths);

// 20 files changed together by recent history: take the newest commits' .ts/.tsx edits (non-test) until we have 20,
// staged at the version just before the newest commit that touches them, over HEAD: functions whose content is not described yet.
const files: { rel: string; commit: string }[] = [];
for (const c of git(repo, ["log", "--no-merges", "-n", "60", "--format=%H"]).split("\n").filter(Boolean)) {
  for (const l of git(repo, ["diff-tree", "--no-commit-id", "--name-status", "-r", c, "--", "*.ts", "*.tsx"])
    .split("\n")
    .filter(Boolean)) {
    const [s, rel] = l.split("\t") as [string, string];
    if (s !== "M" || !isIndexable(rel, config) || /\.(test|spec)\.|\/(e2e|tests?)\//.test(rel)) continue;
    if (!files.some((f) => f.rel === rel)) files.push({ rel, commit: c });
  }
  if (files.length >= FILES) break;
}
const chosen = files.slice(0, FILES);
const hooks = mkdtempSync(join(tmpdir(), "gantry-timing-hooks-"));
writeFileSync(
  join(hooks, "pre-commit"),
  `#!/bin/sh\n[ "$GANTRY_WORKER" = 1 ] || node '${cliJs}' hook pre-commit </dev/null || true\nexit 0\n`,
);
chmodSync(join(hooks, "pre-commit"), 0o755);
const claudeBin = process.env.CLAUDE_CODE_EXECPATH ?? join(homedir(), ".local", "bin", "claude");

interface Run {
  mode: string;
  budgetMs: number | null;
  run: number;
  wallMs: number;
  files: number;
  /** Model usage of this run, from the usage_log rows the run added to its data dir copy. */
  worker: { calls: number; functions: number; inputTokens: number; outputTokens: number };
}
const runs: Run[] = [];
const usageBase = (() => {
  const st = openStore(resolvePaths(repo, { ...process.env, CLAUDE_PLUGIN_DATA: dataSrc }).dbPath);
  const r = st.db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(functions),0) AS f, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM usage_log",
    )
    .get() as { n: number; f: number; i: number; o: number };
  st.close();
  return r;
})();
const modes: { name: string; mode: "off" | "timeboxed"; budgetMs: number | null }[] = [
  { name: "off", mode: "off", budgetMs: null },
  { name: "timeboxed 8000", mode: "timeboxed", budgetMs: 8000 },
  { name: "timeboxed 20000", mode: "timeboxed", budgetMs: 20000 },
];
try {
  for (const m of modes) {
    for (let i = 1; i <= repeats; i++) {
      git(repo, ["reset", "-q", "--hard", startHead]);
      const data = mkdtempSync(join(tmpdir(), "gantry-timing-data-"));
      cpSync(dataSrc, data, { recursive: true });
      const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_EXECPATH: claudeBin };
      const cfgPath = join(resolvePaths(repo, env).dataDir, "config.json");
      mkdirSync(join(cfgPath, ".."), { recursive: true });
      writeFileSync(
        cfgPath,
        JSON.stringify({ precommit: { mode: m.mode, ...(m.budgetMs ? { budgetMs: m.budgetMs } : {}) } }),
      );
      for (const f of chosen) git(repo, ["checkout", `${f.commit}^`, "--", f.rel]);
      const t0 = Date.now();
      const r = spawnSync(
        "git",
        [
          "-c",
          `core.hooksPath=${hooks}`,
          "-c",
          "user.email=eval@example.invalid",
          "-c",
          "user.name=Gantry Eval",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-q",
          "-m",
          "eval commit",
        ],
        { cwd: repo, env, encoding: "utf8" },
      );
      const wallMs = Date.now() - t0;
      if (r.status !== 0) throw new Error("git commit failed");
      const st = openStore(resolvePaths(repo, env).dbPath);
      const before = usageBase;
      const u = st.db
        .prepare(
          "SELECT COUNT(*) AS n, COALESCE(SUM(functions),0) AS f, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM usage_log",
        )
        .get() as { n: number; f: number; i: number; o: number };
      st.close();
      runs.push({
        mode: m.name,
        budgetMs: m.budgetMs,
        run: i,
        wallMs,
        files: chosen.length,
        worker: {
          calls: u.n - before.n,
          functions: u.f - before.f,
          inputTokens: u.i - before.i,
          outputTokens: u.o - before.o,
        },
      });
      rmSync(data, { recursive: true, force: true });
    }
  }
} finally {
  git(repo, ["reset", "-q", "--hard", startHead]);
  rmSync(hooks, { recursive: true, force: true });
}
writePrivate("timing.json", runs);
process.stdout.write(
  `${table(
    ["mode", "files", "wall ms per run", "max ms"],
    modes.map((m) => {
      const rs = runs.filter((r) => r.mode === m.name);
      return [
        m.name,
        chosen.length,
        rs.map((r) => r.wallMs).join(" / "),
        Math.max(...rs.map((r) => r.wallMs)),
      ];
    }),
  )}\n`,
);
