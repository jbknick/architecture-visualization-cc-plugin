// pnpm eval:packs [--only <name>...] [--repos <file>] [--runs <n>] [--truth] [--report <file>] [--json <file>]
// The proof of the Java and Python packs (spec section 13): each repo of evals/packs/repos.json, cloned at its SHA
// (`pnpm eval:clone --repos evals/packs/repos.json`), is indexed without `--scip` and then with it, each time in a fresh
// data directory, and the graph of the run without it is scored against the SCIP index of the repo (`eval-packs-score.ts`).
// Every repo is run `--runs` times (default 3), one after the other. The report lists every run, the worst of each
// metric against the bars of the issue, the wall time and the peak resident memory, and one verdict line per language.
//
// Where things are, all outside this repository:
//   GANTRY_OSS_DIR              the clones (as for eval:clone)
//   GANTRY_PACKS_TRUTH_DIR      the SCIP files `<name>.scip` (default `<GANTRY_OSS_DIR>/packs-truth`); kept out of git
//   GANTRY_CLI                  the built CLI (default plugin/dist/cli.js)
// `--truth` makes a missing `<name>.scip` first, never overwriting one: Java with `scip-java index` (the JDK of
// JAVA_HOME and Maven or Gradle on PATH; the tool is GANTRY_SCIP_JAVA or `scip-java` on PATH), Python with
// `scip-python index` (GANTRY_SCIP_PYTHON or `scip-python`) inside a virtual environment `venv-<name>` of
// GANTRY_PACKS_PYTHON (default `python3`) with the repo's `pip` packages. Gantry itself never runs any of them.
// Peak memory is read from `/usr/bin/time`. Files written: the report (`--report`) and the results (`--json`).
// Exit 0: the proof ran (a missed bar is a result, not an error). 1: a step failed. 2: invalid input.
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readScip } from "../packages/core/src/scip/index.js";
import { InputError, ossDir, type Repo, readRepos, repoRoot, targetDir } from "./eval-lib.js";
import {
  barMet,
  barMetrics,
  buildTruth,
  type CallScore,
  type Dump,
  type Frac,
  type Metric,
  type PackLang,
  type SymbolScore,
  scoreCalls,
  scoreSymbols,
  show,
  wantedLinesOf,
  worstOf,
} from "./eval-packs-score.js";

export const packsReposPath = join(repoRoot, "evals/packs/repos.json");

interface Measured {
  wallMs: number;
  rssBytes: number;
}
interface ScipStats {
  documents: number;
  edges: number;
  unmapped: number;
  otherRefs: number;
  stale: number;
}
interface RunResult {
  run: number;
  withoutScip: Measured;
  withScip: Measured & { stats: ScipStats | null; callEdges: number; callEdgesInTruth: number };
  symbols: SymbolScore;
  calls: CallScore;
  metrics: Metric[];
}
interface RepoResult {
  name: string;
  lang: PackLang;
  sha: string;
  files: number;
  scoredFiles: number;
  filesWithoutDocument: number;
  documentsNotIndexed: number;
  truthDefs: number;
  implicitDefs: number;
  annotationElementRefs: number;
  classCallsWithoutInit: number;
  runs: RunResult[];
  worst: Metric[];
  barMet: boolean;
  runsAgree: boolean;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function parseArgs(argv: string[]) {
  const out = {
    only: [] as string[],
    repos: undefined as string | undefined,
    runs: 3,
    truth: false,
    report: undefined as string | undefined,
    json: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repos") out.repos = argv[++i];
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--truth") out.truth = true;
    else if (a === "--runs") {
      out.runs = Number(argv[++i]);
      if (!Number.isInteger(out.runs) || out.runs < 1)
        throw new InputError("--runs needs a positive integer");
    } else if (a === "--only") {
      while (argv[i + 1] && !argv[i + 1]?.startsWith("--")) out.only.push(argv[++i] as string);
    } else throw new InputError(`unknown argument ${a}`);
  }
  return out;
}

const truthDir = () => resolve(process.env.GANTRY_PACKS_TRUTH_DIR || join(ossDir(), "packs-truth"));
const cliPath = () => resolve(process.env.GANTRY_CLI || join(repoRoot, "plugin/dist/cli.js"));

function langOf(r: Repo): PackLang {
  const l = r.lang[0];
  if (r.lang.length !== 1 || (l !== "java" && l !== "python"))
    throw new InputError(`${r.name}: lang must be ["java"] or ["python"]`);
  return l;
}

function checkClone(r: Repo): string {
  const dir = targetDir(r);
  const rel = relative(repoRoot, dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new InputError(`${dir} is inside this repository`);
  if (!existsSync(dir))
    throw new InputError(`${r.name}: no clone at ${dir}; run pnpm eval:clone --repos evals/packs/repos.json`);
  if (git(dir, "rev-parse", "HEAD") !== r.sha)
    throw new InputError(`${r.name}: the clone is not at ${r.sha}`);
  if (git(dir, "status", "--porcelain") !== "") throw new InputError(`${r.name}: the clone has a dirty tree`);
  return dir;
}

/** Makes `<name>.scip` with the repo's own indexer. */
function makeTruth(r: Repo, clone: string, file: string): void {
  mkdirSync(truthDir(), { recursive: true });
  const log = openSync(`${file}.log`, "w");
  try {
    let tool: string;
    let args: string[];
    let env: NodeJS.ProcessEnv = process.env;
    if (langOf(r) === "java") {
      tool = process.env.GANTRY_SCIP_JAVA || "scip-java";
      args = ["index", "--output", file];
    } else {
      const venv = join(truthDir(), `venv-${r.name}`);
      const py = process.env.GANTRY_PACKS_PYTHON || "python3";
      execFileSync(py, ["-m", "venv", venv], { stdio: ["ignore", log, log] });
      if (r.pip && r.pip.length > 0)
        execFileSync(join(venv, "bin/pip"), ["install", "-q", ...r.pip], { stdio: ["ignore", log, log] });
      env = {
        ...process.env,
        PATH: `${join(venv, "bin")}:${process.env.PATH ?? ""}`,
        ...(r.pythonPath && r.pythonPath.length > 0
          ? { PYTHONPATH: r.pythonPath.map((p) => join(clone, p)).join(":") }
          : {}),
      };
      tool = process.env.GANTRY_SCIP_PYTHON || "scip-python";
      args = ["index", ".", "--project-name", r.name, "--output", file];
    }
    const res = spawnSync(tool, args, { cwd: clone, env, stdio: ["ignore", log, log] });
    if (res.status !== 0) {
      rmSync(file, { force: true });
      throw new Error(
        `${r.name}: the indexer failed (${res.error?.message ?? `exit ${res.status}`}); see ${file}.log`,
      );
    }
  } finally {
    closeSync(log);
  }
}

/** One `index --dump` of the clone in a fresh data directory, with its wall time and peak memory. */
function indexRun(clone: string, scip: string | null): { dump: Dump; measured: Measured; stderr: string } {
  const data = mkdtempSync(join(tmpdir(), "gantry-packs-data-"));
  const out = join(data, "dump.json");
  const fd = openSync(out, "w");
  try {
    const darwin = process.platform === "darwin";
    const t0 = process.hrtime.bigint();
    const res = spawnSync(
      "/usr/bin/time",
      [
        darwin ? "-l" : "-v",
        process.execPath,
        cliPath(),
        "index",
        "--dump",
        ...(scip ? ["--scip", scip] : []),
      ],
      {
        cwd: clone,
        env: { ...process.env, CLAUDE_PLUGIN_DATA: join(data, "plugin-data") },
        stdio: ["ignore", fd, "pipe"],
        encoding: "utf8",
        maxBuffer: 1 << 28,
      },
    );
    const wallMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    if (res.status !== 0)
      throw new Error(`index failed in ${clone}: ${res.error?.message ?? res.stderr.slice(-400)}`);
    const rss = darwin
      ? /(\d+)\s+maximum resident set size/.exec(res.stderr)?.[1]
      : /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(res.stderr)?.[1];
    if (!rss) throw new Error("could not read the peak memory from /usr/bin/time");
    const rssBytes = darwin ? Number(rss) : Number(rss) * 1024;
    return {
      dump: JSON.parse(readFileSync(out, "utf8")) as Dump,
      measured: { wallMs, rssBytes },
      stderr: res.stderr,
    };
  } finally {
    closeSync(fd);
    rmSync(data, { recursive: true, force: true });
  }
}

const scipLine = (stderr: string): ScipStats | null => {
  const m = /scip:\s+(\d+) documents, (\d+) edges, (\d+) unmapped, (\d+) other references, (\d+) stale/.exec(
    stderr,
  );
  return m
    ? {
        documents: Number(m[1]),
        edges: Number(m[2]),
        unmapped: Number(m[3]),
        otherRefs: Number(m[4]),
        stale: Number(m[5]),
      }
    : null;
};

async function* scipDocuments(file: string) {
  for await (const it of readScip(file)) if (it.kind === "document") yield it.document;
}

async function measureOnce(lang: PackLang, clone: string, truthFile: string, run: number) {
  const a = indexRun(clone, null);
  const b = indexRun(clone, truthFile);
  const fileCache = new Map<string, string[] | undefined>();
  const fileLines = (p: string): string[] | undefined => {
    if (!fileCache.has(p)) {
      try {
        fileCache.set(p, readFileSync(join(clone, p), "utf8").split(/\r?\n/));
      } catch {
        fileCache.set(p, undefined);
      }
      if (fileCache.size > 200) fileCache.delete(fileCache.keys().next().value as string);
    }
    return fileCache.get(p);
  };
  const truth = await buildTruth({
    lang,
    dump: a.dump,
    documents: scipDocuments(truthFile),
    fileLines,
    wantedLines: wantedLinesOf(a.dump),
  });
  const symbols = scoreSymbols(a.dump, truth);
  const calls = scoreCalls(a.dump, truth);
  const truthPairs = new Set(truth.calls.flatMap((t) => t.alts.map((a) => `${t.caller}\0${a}`)));
  const scipEdges = b.dump.edges.filter((e) => e.kind === "calls" && e.source === "scip");
  const result: RunResult = {
    run,
    withoutScip: a.measured,
    withScip: {
      ...b.measured,
      stats: scipLine(b.stderr),
      callEdges: scipEdges.length,
      callEdgesInTruth: scipEdges.filter((e) => truthPairs.has(`${e.src}\0${e.dst}`)).length,
    },
    symbols,
    calls,
    metrics: barMetrics(lang, symbols, calls),
  };
  const files = a.dump.files.filter((f) => f.lang === lang).length;
  return { result, truth, files };
}

// ---------------------------------------------------------------------------------------------------------------
// Report.

const mb = (b: number) => `${Math.ceil(b / 1048576)} MB`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const entries = (o: Record<string, number>) =>
  Object.entries(o).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
const fracEntries = (o: Record<string, Frac>) => Object.entries(o).sort((x, y) => (x[0] < y[0] ? -1 : 1));

function runLines(run: RunResult): string[] {
  const out: string[] = [];
  out.push(`  run ${run.run}`);
  out.push(`    without --scip: ${sec(run.withoutScip.wallMs)}, peak ${mb(run.withoutScip.rssBytes)}`);
  const s = run.withScip.stats;
  out.push(
    `    with --scip: ${sec(run.withScip.wallMs)}, peak ${mb(run.withScip.rssBytes)}` +
      (s
        ? `; ${s.documents} documents, ${s.edges} edges, ${s.unmapped} unmapped, ${s.otherRefs} other references, ${s.stale} stale`
        : ""),
  );
  out.push(
    `    precise-mode call edges that are calls of the truth: ${run.withScip.callEdgesInTruth}/${run.withScip.callEdges}`,
  );
  out.push("    symbols");
  for (const [k, v] of Object.entries(run.symbols.perKind)) {
    out.push(`      ${k}: precision ${show(v.precision)}, recall ${show(v.recall)}`);
  }
  const c = run.calls;
  out.push("    calls");
  out.push(
    `      truth calls ${c.truthCalls}: self-recursive ${c.selfRecursive}, through a local symbol ${c.local} (no symbol of ours: ${c.localWithoutSymbol}), reachable by the graph ${c.reachable}`,
  );
  out.push(`      recall ${show(c.recall)}`);
  out.push(
    `      matched by: ${
      entries(c.matchedBy)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ") || "none"
    }`,
  );
  out.push(`      precision, all edges ${show(c.precision.all)}`);
  out.push(`      precision, high ${show(c.precision.high)}`);
  out.push(`      precision, low, per site ${show(c.precision.low)}; per edge ${show(c.precision.lowEdges)}`);
  for (const [k, v] of fracEntries(c.precision.byLevel)) out.push(`      precision, ${k} ${show(v)}`);
  for (const [k, v] of fracEntries(c.precision.byLevelConfidence))
    out.push(`      precision, ${k} ${show(v)}`);
  out.push(
    `      edges not scored (a class called with no initializer to name): ${c.precision.unverifiable}`,
  );
  return out;
}

function repoLines(r: RepoResult): string[] {
  const out: string[] = [];
  out.push(`${r.name} (${r.lang}) at ${r.sha}`);
  out.push(
    `  files indexed ${r.files}; scored ${r.scoredFiles}; without a document in the index ${r.filesWithoutDocument}; documents of the index for files not indexed ${r.documentsNotIndexed}`,
  );
  out.push(
    `  truth definitions ${r.truthDefs}; implicit definitions left out of them ${r.implicitDefs}; annotation elements left out of the calls ${r.annotationElementRefs}; class calls with no initializer, not in the truth ${r.classCallsWithoutInit}`,
  );
  out.push(`  the runs gave the same scores: ${r.runsAgree ? "yes" : "no"}`);
  for (const run of r.runs) out.push(...runLines(run));
  const worstWall = Math.max(...r.runs.map((x) => Math.max(x.withoutScip.wallMs, x.withScip.wallMs)));
  const worstRss = Math.max(...r.runs.map((x) => Math.max(x.withoutScip.rssBytes, x.withScip.rssBytes)));
  out.push(`  worst of ${r.runs.length} runs: wall time ${sec(worstWall)}, peak ${mb(worstRss)}`);
  for (const m of r.worst)
    out.push(`    ${m.label}: ${show(m.value)}, bar ${m.bar}%, ${barMet(m) ? "met" : "MISSED"}`);
  const first = r.runs[0];
  if (first) {
    out.push("  causes of misses (first run)");
    for (const [k, n] of entries(first.symbols.misses)) out.push(`    symbol recall: ${k}: ${n}`);
    out.push(
      `    local definitions ${first.symbols.localDefs}, mapped ${first.symbols.localDefsMapped}; implicit definitions ${first.symbols.implicitDefs}`,
    );
    for (const [k, n] of entries(first.calls.recallMisses)) out.push(`    call recall: ${k}: ${n}`);
    for (const [k, n] of entries(first.calls.noEdgeShapes)) out.push(`      no edge, shape ${k}: ${n}`);
    for (const [k, n] of entries(first.calls.wrongTargetLevels))
      out.push(`      another target, edge of ${k}: ${n}`);
    for (const [k, n] of entries(first.calls.precisionMisses)) out.push(`    call precision: ${k}: ${n}`);
    for (const [k, n] of entries(first.calls.precisionMissesByLevel))
      out.push(`      wrong edges of ${k}: ${n}`);
  }
  return out;
}

export function formatReport(results: RepoResult[]): string {
  const out: string[] = [];
  for (const lang of ["java", "python"] as const) {
    const repos = results.filter((r) => r.lang === lang);
    if (repos.length === 0) continue;
    out.push(lang === "java" ? "Java" : "Python");
    out.push(`Bar met: ${repos.every((r) => r.barMet) ? "yes" : "no"}`);
    out.push("");
    for (const r of repos) out.push(...repoLines(r), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

async function main(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const all = readRepos(args.repos ? resolve(args.repos) : packsReposPath);
    for (const n of args.only) if (!all.some((r) => r.name === n)) throw new InputError(`unknown repo ${n}`);
    const repos = all.filter((r) => args.only.length === 0 || args.only.includes(r.name));
    if (!existsSync(cliPath())) throw new InputError(`no CLI at ${cliPath()}; run pnpm build`);
    if (!existsSync("/usr/bin/time")) throw new InputError("/usr/bin/time is needed to read the peak memory");
    const results: RepoResult[] = [];
    for (const r of repos) {
      const lang = langOf(r);
      const clone = checkClone(r);
      const truthFile = join(truthDir(), `${r.name}.scip`);
      if (!existsSync(truthFile)) {
        if (!args.truth)
          throw new InputError(`${r.name}: no SCIP index at ${truthFile}; pass --truth to make it`);
        process.stderr.write(`making the SCIP index of ${r.name}\n`);
        makeTruth(r, clone, truthFile);
      }
      const runs: RunResult[] = [];
      let truthInfo: Awaited<ReturnType<typeof measureOnce>> | undefined;
      for (let i = 1; i <= args.runs; i++) {
        process.stderr.write(`${r.name}: run ${i} of ${args.runs}\n`);
        truthInfo = await measureOnce(lang, clone, truthFile, i);
        runs.push(truthInfo.result);
      }
      if (!truthInfo) throw new Error("no run");
      const worst = worstOf(runs.map((x) => x.metrics));
      const same = (x: RunResult) => JSON.stringify([x.symbols, x.calls]);
      results.push({
        name: r.name,
        lang,
        sha: r.sha,
        files: truthInfo.files,
        scoredFiles: truthInfo.truth.scoredPaths.length,
        filesWithoutDocument: truthInfo.truth.filesWithoutDocument,
        documentsNotIndexed: truthInfo.truth.documentsNotIndexed,
        truthDefs: truthInfo.truth.defs.length,
        implicitDefs: truthInfo.truth.implicitDefs,
        annotationElementRefs: truthInfo.truth.annotationElementRefs,
        classCallsWithoutInit: truthInfo.truth.classCallsWithoutInit,
        runs,
        worst,
        barMet: worst.every(barMet),
        runsAgree: runs.every((x) => same(x) === same(runs[0] as RunResult)),
      });
    }
    const text = formatReport(results);
    if (args.report) writeFileSync(resolve(args.report), text);
    else process.stdout.write(text);
    if (args.json) writeFileSync(resolve(args.json), `${JSON.stringify(results, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof InputError) {
      console.error(`eval:packs: ${err.message}`);
      return 2;
    }
    console.error(`eval:packs: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
