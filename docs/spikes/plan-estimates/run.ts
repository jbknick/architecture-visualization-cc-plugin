// Runner of the plan-estimates spike (#304): for each pull request, check out `base` in a worktree, heal the index,
// run the estimator prompt headless and record the area it names.
//   pnpm tsx docs/spikes/plan-estimates/run.ts [--pilot | --subset] --run <name> [--run <name> ...]
//   full set:   run.ts --run full
//   subset:     run.ts --subset --run sub-1   (and sub-2, sub-3)
//   pilot:      run.ts --pilot --run pilot-1 --run pilot-2 --run pilot-3 --run pilot-kw
// A run name ending in `-kw` is the keyword-only variant (descriptions removed from a copy of the index; the plain
// variant keeps whatever descriptions the index holds). Several `--run` names share one checkout and heal per PR.
// Needs `pnpm build` (plugin/dist), the history clones in GANTRY_PE_DIR (select.ts says how) and a claude.ai login.
// Writes runs/<name>.json ({ runs: [{ key, area: [{ id, confidence }] }] }: node ids and confidences only) and
// runs/<name>.meta.json (model id, tokens, wall time, description coverage, radius counts; no text). Resumable:
// a PR already in the run file is skipped. Never part of `pnpm check`.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeImpact,
  contentKey,
  describedByMap,
  FUNCTION_LIKE_KINDS,
  modifiedChanges,
  openStore,
  pathOfFileId,
  resolvePaths,
} from "../../../packages/core/src/index.js";
import { type AreaNode, actualFiles, areaFiles } from "./area.js";
import {
  cliPath,
  corpusRepos,
  git,
  here,
  historyClone,
  loadKeys,
  loadPlan,
  loadPrs,
  mcpPath,
  type Pr,
  planText,
  prKey,
  stable,
  workDir,
} from "./lib.js";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opts = (f: string): string[] => argv.flatMap((a, i) => (a === f ? [argv[i + 1] as string] : []));
const MODEL = opts("--model")[0] ?? "sonnet";
const EFFORT = opts("--effort")[0] ?? "low";
const TOKEN_BUDGET = Number(opts("--token-budget")[0] ?? 0); // 0: no stop; else stop when input+cache tokens pass it
const names = opts("--run");
const RADIUS_ONLY = flag("--radius-only");
if (names.length === 0) throw new Error("give at least one --run <name>");

const SCHEMA = {
  type: "object",
  properties: {
    area: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: { id: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 } },
        required: ["id", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["area"],
  additionalProperties: false,
} as const;

const TOOLS = ["gantry_search", "gantry_node", "gantry_impact"].map((t) => `mcp__gantry__${t}`);
const OTHER_TOOLS = [
  "gantry_browse",
  "gantry_claim_batch",
  "gantry_find_similar",
  "gantry_get_overview",
  "gantry_open_view",
  "gantry_save_overview",
  "gantry_submit_descriptions",
  "gantry_trace",
].map((t) => `mcp__gantry__${t}`);

interface RunMeta {
  key: string;
  status: "ok" | "failed";
  failure?: string;
  model: string | null;
  turns: number | null;
  tokens: { input: number; cacheCreate: number; cacheRead: number; output: number } | null;
  wallMs: number;
  empty: boolean;
  nodes: number;
  radius: { estimated: number; actual: number } | null;
}
interface PrMeta {
  key: string;
  coverage: { functionLike: number; model: number; template: number; fallback: number } | null;
  healMs: number;
}

const readJson = <T>(f: string, fallback: T): T =>
  existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback;
const runFile = (name: string) => join(here, "runs", `${name}.json`);
const metaFile = (name: string) => join(here, "runs", `${name}.meta.json`);

const scratch = mkdtempSync(join(tmpdir(), "plan-estimates-"));
const mcpConfig = (dataDir: string) => {
  const f = join(scratch, `mcp-${dataDir.replace(/\W+/g, "_")}.json`);
  writeFileSync(
    f,
    JSON.stringify({
      mcpServers: { gantry: { command: "node", args: [mcpPath], env: { CLAUDE_PLUGIN_DATA: dataDir } } },
    }),
  );
  return f;
};

function childEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GANTRY_WORKER: "1", CLAUDE_PLUGIN_DATA: dataDir };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return env;
}

interface Claude {
  structured: { area?: AreaNode[] } | null;
  model: string | null;
  turns: number | null;
  tokens: RunMeta["tokens"];
  wallMs: number;
  error: string | null;
}

function claudeRun(cwd: string, plan: string, dataDir: string): Promise<Claude> {
  const args = [
    "-p",
    "--model",
    MODEL,
    "--effort",
    EFFORT,
    "--setting-sources",
    "project",
    "--disable-slash-commands",
    "--tools",
    "",
    "--mcp-config",
    mcpConfig(dataDir),
    "--strict-mcp-config",
    "--allowedTools",
    TOOLS.join(" "),
    "--disallowedTools",
    OTHER_TOOLS.join(" "),
    "--system-prompt-file",
    join(here, "estimator.md"),
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(SCHEMA),
  ];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child: ChildProcess = spawn("claude", args, {
      cwd,
      env: childEnv(dataDir),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      out += d;
    });
    child.stderr?.on("data", (d) => {
      err += d;
    });
    child.stdin?.end(JSON.stringify({ untrusted_plan: plan }));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let j: Record<string, unknown> | null = null;
      try {
        j = JSON.parse(out) as Record<string, unknown>;
      } catch {
        j = null;
      }
      const u = (j?.usage ?? {}) as Record<string, number>;
      const mu = (j?.modelUsage ?? {}) as Record<string, unknown>;
      const structured = (j?.structured_output ?? null) as Claude["structured"];
      resolve({
        structured,
        model: Object.keys(mu).join(",") || null,
        turns: typeof j?.num_turns === "number" ? j.num_turns : null,
        tokens: j
          ? {
              input: u.input_tokens ?? 0,
              cacheCreate: u.cache_creation_input_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              output: u.output_tokens ?? 0,
            }
          : null,
        wallMs: Date.now() - t0,
        error:
          j && j.is_error !== true && structured
            ? null
            : `claude exit ${code}: ${j ? String(j.result ?? "no structured_output").slice(0, 200) : (err || out).slice(0, 200)}`,
      });
    });
  });
}

const node = (args: string[], cwd: string, dataDir: string) =>
  execFileSync("node", ["--max-old-space-size=6144", cliPath, ...args], {
    cwd,
    env: childEnv(dataDir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

/** The keyword-only variant: a copy of the healed index with every description removed. */
function keywordCopy(pathsDb: string, kwDb: string): void {
  mkdirSync(join(kwDb, ".."), { recursive: true });
  rmSync(kwDb, { force: true });
  const src = openStore(pathsDb);
  try {
    src.db.prepare("VACUUM INTO ?").run(kwDb);
  } finally {
    src.close();
  }
  const kw = openStore(kwDb);
  try {
    kw.db.exec(
      "DELETE FROM descriptions; UPDATE fts_symbols SET behavior = '', search_terms = '', suggested_name = ''",
    );
  } finally {
    kw.close();
  }
}

async function main() {
  if (!existsSync(cliPath)) throw new Error("plugin/dist/cli.js is missing: run pnpm build");
  const prs = loadPrs();
  const keys = flag("--pilot") ? loadKeys("pilot") : flag("--subset") ? loadKeys("subset") : prs.map(prKey);
  const only = opts("--only");
  const todo = keys
    .filter((k) => only.length === 0 || only.includes(k))
    .map((k) => prs.find((p) => prKey(p) === k) as Pr);
  const repos = corpusRepos();
  const dataDesc = join(workDir, "data-desc");
  const dataKw = join(workDir, "data-kw");
  const state = new Map<
    string,
    { runs: { key: string; area: AreaNode[] }[]; meta: RunMeta[]; pr: PrMeta[] }
  >();
  for (const n of names)
    state.set(n, {
      runs: readJson<{ runs: { key: string; area: AreaNode[] }[] }>(runFile(n), { runs: [] }).runs,
      meta: readJson<{ runs: RunMeta[]; prs: PrMeta[] }>(metaFile(n), { runs: [], prs: [] }).runs,
      pr: readJson<{ runs: RunMeta[]; prs: PrMeta[] }>(metaFile(n), { runs: [], prs: [] }).prs,
    });
  const save = (n: string) => {
    const s = state.get(n);
    if (!s) return;
    mkdirSync(join(here, "runs"), { recursive: true });
    const order = (a: { key: string }, b: { key: string }) => keys.indexOf(a.key) - keys.indexOf(b.key);
    writeFileSync(runFile(n), stable({ runs: [...s.runs].sort(order) }));
    writeFileSync(metaFile(n), stable({ runs: [...s.meta].sort(order), prs: [...s.pr].sort(order) }));
  };

  let used = 0;
  for (const repo of repos) {
    const mine = todo.filter((p) => p.repo === repo.name).sort((a, b) => a.number - b.number);
    if (mine.length === 0) continue;
    const bare = historyClone(repo.name);
    const wt = join(workDir, "wt", repo.name);
    for (const pr of mine) {
      const key = prKey(pr);
      const pending = RADIUS_ONLY ? [] : names.filter((n) => !state.get(n)?.runs.some((r) => r.key === key));
      const redo = RADIUS_ONLY ? names.filter((n) => state.get(n)?.runs.some((r) => r.key === key)) : [];
      if (pending.length === 0 && redo.length === 0) continue;
      if (TOKEN_BUDGET > 0 && used >= TOKEN_BUDGET) {
        console.log(`token budget ${TOKEN_BUDGET} reached (${used}); stopping before ${key}`);
        return;
      }
      if (existsSync(wt)) git(wt, "checkout", "--detach", "-f", pr.base);
      else {
        mkdirSync(join(workDir, "wt"), { recursive: true });
        git(bare, "worktree", "add", "--detach", wt, pr.base);
      }
      const paths = resolvePaths(wt, childEnv(dataDesc));
      const t0 = Date.now();
      if (existsSync(paths.dbPath)) node(["heal"], wt, dataDesc);
      else node(["init"], wt, dataDesc);
      const healMs = Date.now() - t0;
      let coverage: PrMeta["coverage"] = null;
      let radiusActual: number | null = null;
      const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath });
      try {
        const by = describedByMap(store);
        const fl = store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] });
        const c = { functionLike: fl.length, model: 0, template: 0, fallback: 0 };
        for (const s of fl) {
          const d = s.exactHash === "" ? undefined : by.get(contentKey(s.exactHash));
          if (d) c[d]++;
        }
        coverage = c;
        const { diff } = await actualFiles(pr, repo.slug);
        radiusActual = directConsumers(
          computeImpact(store, diff.changes, { files: diff.files.map((f) => f.path) }),
        );
      } finally {
        store.close();
      }
      if (pending.some((n) => n.endsWith("-kw")))
        keywordCopy(paths.dbPath, join(dataKw, "repos", paths.worktreeHash, "gantry.db"));
      // --radius-only: recompute the estimated radius of finished runs from their committed areas (no model call).
      for (const n of redo) {
        const s = state.get(n);
        const run = s?.runs.find((r) => r.key === key);
        const m = s?.meta.find((x) => x.key === key);
        if (!s || !run || !m) continue;
        const st = openStore(paths.dbPath, { overlayPath: paths.overlayPath });
        try {
          const files = areaFiles(pr.repo, pr.base, run.area);
          const ids = st
            .effectiveSymbols()
            .filter((sym) => files.has(pathOfFileId(sym.fileId)))
            .map((sym) => sym.id);
          const estimated = directConsumers(computeImpact(st, modifiedChanges(st, ids)));
          m.radius = radiusActual === null ? null : { estimated, actual: radiusActual };
        } finally {
          st.close();
        }
        save(n);
        console.log(`${n} ${key}: radius ${JSON.stringify(m.radius)}`);
      }
      if (pending.length === 0) continue;
      const plan = planText(loadPlan(pr));
      for (const n of pending) {
        const s = state.get(n);
        if (!s) continue;
        const kw = n.endsWith("-kw");
        const r = await claudeRun(wt, plan, kw ? dataKw : dataDesc);
        const area = (r.structured?.area ?? []).filter((a) => typeof a.id === "string");
        let estimated: number | null = null;
        if (!r.error) {
          const st = openStore(paths.dbPath, { overlayPath: paths.overlayPath });
          try {
            const files = areaFiles(pr.repo, pr.base, area);
            const ids = st
              .effectiveSymbols()
              .filter((sym) => files.has(pathOfFileId(sym.fileId)))
              .map((sym) => sym.id);
            estimated = directConsumers(computeImpact(st, modifiedChanges(st, ids)));
          } finally {
            st.close();
          }
        }
        const meta: RunMeta = {
          key,
          status: r.error ? "failed" : "ok",
          model: r.model,
          turns: r.turns,
          tokens: r.tokens,
          wallMs: r.wallMs,
          empty: !r.error && area.length === 0,
          nodes: area.length,
          radius: estimated === null || radiusActual === null ? null : { estimated, actual: radiusActual },
        };
        if (r.error) meta.failure = r.error;
        used += (r.tokens?.input ?? 0) + (r.tokens?.cacheCreate ?? 0) + (r.tokens?.cacheRead ?? 0);
        if (!r.error) s.runs.push({ key, area });
        s.meta = s.meta.filter((m) => m.key !== key).concat(meta);
        s.pr = s.pr.filter((x) => x.key !== key).concat({ key, coverage, healMs });
        save(n);
        console.log(
          `${n} ${key}: ${meta.status} nodes=${area.length} turns=${r.turns} wall=${Math.round(r.wallMs / 1000)}s tokens(all)=${used} ${r.error ?? ""}`,
        );
      }
    }
  }
}

/** Hop-1 consumers of the changes: the sum of `directTotal` over the symbol changes. */
function directConsumers(impact: ReturnType<typeof computeImpact>): number {
  return impact.consumers.filter((c) => c.target === "symbol").reduce((a, c) => a + c.directTotal, 0);
}

await main();
rmSync(scratch, { recursive: true, force: true });
