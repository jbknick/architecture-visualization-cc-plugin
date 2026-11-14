/**
 * M1 regression benchmark (issue #20): performance, determinism and git-flow on a real repository.
 *
 * Usage: pnpm build && pnpm tsx evals/bench/m1.ts <repo> [--runs 3] [--calcom <path>] [--skip-tests]
 *        [--i-know-this-is-a-throwaway-clone]
 *
 * Runs the built CLI (`plugin/dist/cli.js`) against <repo> with a throwaway data dir (CLAUDE_PLUGIN_DATA) per
 * cold run, so nothing is written to ~/.gantry. It does edit one tracked file in <repo> and stashes it
 * (`git stash push -u -m gantry-m1-bench-<nonce>`), so it refuses any <repo> outside the system temp dir
 * unless --i-know-this-is-a-throwaway-clone is passed. The edit and the stash are always undone, also on
 * Ctrl-C (see m1-safety.ts and the recovery notes in docs/milestones/M1.md).
 * Prints aggregate numbers only (counts, percentages, timings); never paths, symbols or graph content.
 * Exits non-zero if a done-when line is missed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dumpGraph, indexRepo, openStore, resolvePaths } from "../../packages/core/src/index.js";
import {
  type BenchResults,
  evaluate,
  exitCode,
  formatReport,
  type InitRun,
  parseSummary,
} from "./m1-report.js";
import { assertThrowawayClone, ProbeGuard, THROWAWAY_FLAG } from "./m1-safety.js";

const here = dirname(fileURLToPath(import.meta.url));
const gantryRoot = resolve(here, "..", "..");
const cli = join(gantryRoot, "plugin", "dist", "cli.js");
const PROBE = "__gantryBenchProbe";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repoArg = process.argv[2];
if (!repoArg || repoArg.startsWith("--")) {
  process.stderr.write(
    `usage: pnpm tsx evals/bench/m1.ts <repo> [--runs 3] [--calcom <path>] [--skip-tests] [${THROWAWAY_FLAG}]\n`,
  );
  process.exit(2);
}
const repo = resolve(repoArg);
try {
  assertThrowawayClone(repo, process.argv.includes(THROWAWAY_FLAG));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
const runs = Number(arg("--runs") ?? 3);
const skipTests = process.argv.includes("--skip-tests");
const calcomPath = arg("--calcom");
if (!existsSync(cli)) {
  process.stderr.write("plugin/dist/cli.js is missing: run `pnpm build` first\n");
  process.exit(2);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "gantry-m1-"));
let dirN = 0;
const freshDataDir = (): string => join(tmpRoot, `data-${dirN++}`);

function gantry(
  args: string[],
  cwd: string,
  dataDir: string,
): { out: string; err: string; ms: number; code: number } {
  const t0 = performance.now();
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return { out: r.stdout, err: r.stderr, ms: performance.now() - t0, code: r.status ?? 1 };
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function initRun(path: string): InitRun {
  const r = gantry(["init"], path, freshDataDir());
  if (r.code !== 0) throw new Error(`gantry init failed (exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
  return { ...parseSummary(r.out), wallMs: r.ms };
}

/** Graph dump of the current store in <dataDir>, formatted exactly like `gantry index --dump`. */
function storeDumpSha(dataDir: string): { sha: string; files: string[] } {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const store = openStore(resolvePaths(repo).dbPath);
  try {
    const dump = dumpGraph(store);
    const files = (dump.files as { path: string }[]).map((f) => f.path);
    return { sha: sha256(`${JSON.stringify(dump, null, 2)}\n`), files };
  } finally {
    store.close();
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
}

function vitest(args: string[]): boolean {
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...args], { cwd: gantryRoot, stdio: "ignore" });
  return r.status === 0;
}

async function main(): Promise<number> {
  // Step 1: cold init, median of N, each with its own empty data dir.
  process.stderr.write(`init x${runs} (cold)\n`);
  const init: InitRun[] = [];
  for (let i = 0; i < runs; i++) init.push(initRun(repo));

  // Resolution classes need the resolver stats, which the CLI summary does not carry: one untimed in-process run.
  process.env.CLAUDE_PLUGIN_DATA = freshDataDir();
  const stat = await indexRepo(resolvePaths(repo), { layer: "main" });
  const c = stat.specifierCounts;
  const specifiers = { file: c.file, unresolved: c.unresolved, generated: c.generated, excluded: c.excluded };
  delete process.env.CLAUDE_PLUGIN_DATA;

  // Step 2: determinism, two cold `index --dump` runs.
  process.stderr.write("determinism\n");
  const dirA = freshDataDir();
  const a = gantry(["index", "--dump"], repo, dirA);
  const b = gantry(["index", "--dump"], repo, freshDataDir());
  if (a.code !== 0 || b.code !== 0) throw new Error("gantry index --dump failed");
  const shaA = sha256(a.out);
  const shaB = sha256(b.out);

  // Step 3: edit one file, search (refreshes working), stash, search, compare dumps.
  process.stderr.write("refresh and git-flow\n");
  const clean = storeDumpSha(dirA);
  if (clean.sha !== shaA) throw new Error("in-process dump differs from CLI dump of the same store");
  const candidates = clean.files.filter(
    (p) => /\.tsx?$/.test(p) && !/\.(test|spec)\./.test(p) && !p.endsWith(".d.ts"),
  );
  const target = candidates[Math.floor(candidates.length / 2)];
  if (!target) throw new Error("no editable source file found");
  const guard = new ProbeGuard(repo, target);
  guard.arm(); // refuses a dirty tree; restores the clone on Ctrl-C, SIGTERM and exit
  gantry(["search", PROBE], repo, dirA); // settle: heal check + refresh on the clean tree
  const noop = gantry(["search", PROBE], repo, dirA);

  let editVisible = false;
  let refreshMs = Number.NaN;
  let stashHealed = false;
  const abs = join(repo, target);
  try {
    appendFileSync(abs, `\nexport function ${PROBE}(): number {\n  return 1;\n}\n`);
    guard.markEdited();
    const edited = gantry(["search", PROBE], repo, dirA);
    refreshMs = edited.ms;
    editVisible = edited.out.includes(PROBE);

    guard.stash();
    gantry(["search", PROBE], repo, dirA); // heal + refresh after the tree went back to clean
    const after = storeDumpSha(dirA);
    stashHealed = after.sha === clean.sha;
  } finally {
    guard.restore();
    guard.disarm();
  }
  if (!guard.isClean()) throw new Error("test bed is not clean after the run");

  // Step 4: tests.
  let fullSuite: boolean | null = null;
  let healMatrix: boolean | null = null;
  if (!skipTests) {
    process.stderr.write("vitest (heal matrix, then full suite)\n");
    healMatrix = vitest(["packages/core/src/heal"]);
    fullSuite = vitest([]);
  }

  // Step 5: optional Cal.com timing.
  let calcom: BenchResults["calcom"];
  if (calcomPath && existsSync(resolve(calcomPath))) {
    process.stderr.write("cal.com init\n");
    const p = resolve(calcomPath);
    const walls: number[] = [];
    let files = 0;
    for (let i = 0; i < runs; i++) {
      const r = initRun(p);
      walls.push(r.wallMs);
      files = r.files;
    }
    calcom = {
      files,
      wallMs: [...walls].sort((x, y) => x - y)[Math.floor(walls.length / 2)] as number,
      packagesResolved: existsSync(join(p, "node_modules")),
    };
  }

  const results: BenchResults = {
    runs,
    init,
    specifiers,
    shaA,
    shaB,
    refreshMs,
    noopSearchMs: noop.ms,
    editVisible,
    stashHealed,
    fullSuite,
    healMatrix,
    calcom,
  };
  process.stdout.write(`${formatReport(results)}\n`);
  return exitCode(evaluate(results));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`m1 bench failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  })
  .finally(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });
