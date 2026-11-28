// pnpm eval:clojure [--only <name>...] [--repos <file>] [--truth] [--report <file>]
// The proof of the Clojure module (spec section 13): each repo of evals/packs/clojure-repos.json, cloned at its SHA
// (`pnpm eval:clone --repos evals/packs/clojure-repos.json`), is indexed in a fresh data directory and its graph is
// scored against the analysis of clj-kondo (var definitions and var usages). The truth is clj-kondo's syntactic
// analysis, not a SCIP index and not a compiler: it resolves names the way the Clojure compiler would, from the `ns`
// forms, without running the code. The index is deterministic, so one run is scored.
//
// Where things are, all outside this repository:
//   GANTRY_OSS_DIR              the clones (as for eval:clone)
//   GANTRY_PACKS_TRUTH_DIR      the analyses `<name>.kondo.json` (default `<GANTRY_OSS_DIR>/packs-truth`); kept out of git
//   GANTRY_CLI                  the built CLI (default plugin/dist/cli.js)
//   GANTRY_CLJ_KONDO            clj-kondo (default `clj-kondo` on PATH), run by `--truth` for a missing analysis
// Exit 0: the proof ran. 1: a step failed. 2: invalid input.
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InputError, ossDir, type Repo, readRepos, repoRoot, targetDir } from "./eval-lib.js";
import { type Frac, frac, show } from "./eval-packs-score.js";

export const clojureReposPath = join(repoRoot, "evals/packs/clojure-repos.json");

/** The analysis config clj-kondo is run with: JSON output, the three analyses that are read, no lint output kept. */
export const KONDO_CONFIG = "{:output {:format :json} :analysis {:var-definitions true :var-usages true}}";

interface KondoDef {
  filename: string;
  ns: string;
  name: string;
  "defined-by"?: string;
}
interface KondoUsage {
  filename: string;
  from: string;
  to: string;
  name: string;
  row: number;
}
export interface Kondo {
  analysis: {
    "namespace-definitions": { filename: string; name: string }[];
    "var-definitions": KondoDef[];
    "var-usages": KondoUsage[];
  };
}
interface DumpSymbol {
  id: string;
  fileId: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}
interface DumpEdge {
  src: string;
  dst: string;
  kind: string;
  confidence: "high" | "low";
  level?: number;
}
export interface ClojureDump {
  files: { id: string; path: string; lang: string }[];
  symbols: DumpSymbol[];
  edges: DumpEdge[];
}

export interface ClojureScore {
  files: number;
  scoredFiles: number;
  kondoFilesNotIndexed: number;
  symbols: { precision: Frac; recall: Frac; defmethods: number; missedBy: Record<string, number> };
  calls: {
    truthPairs: number;
    selfReferences: number;
    outsideDefinitions: number;
    recall: Frac;
    precision: Frac;
    precisionHigh: Frac;
    precisionLow: Frac;
    edges: { high: number; low: number };
    /** Missed pairs whose target var has no symbol in the graph (defined in a file the index does not hold). */
    missedNoSymbol: number;
    missed: string[];
    wrong: string[];
  };
}

const strip = (p: string): string => p.replace(/^\.\//, "");

/** Repo-relative path of a file name clj-kondo gives, through symbolic links. */
const canonicalIn =
  (clone: string) =>
  (p: string): string => {
    try {
      return relative(realpathSync(clone), realpathSync(join(clone, p)));
    } catch {
      return strip(p);
    }
  };

/** The var a graph symbol stands for: its name, the method of a protocol, null for a `defmethod`. */
function varOf(s: DumpSymbol, interfaces: Set<string>): string | null {
  const name = s.name.replace(/~\d+$/, "");
  if (s.kind !== "method") return name;
  const dot = name.indexOf(".");
  return interfaces.has(`${s.fileId}\0${name.slice(0, dot)}`) ? name.slice(dot + 1) : null;
}

/**
 * Scores the graph of a repo against clj-kondo. Files: those the graph holds that clj-kondo analysed. Symbols: each
 * graph symbol of those files is the var it defines (a protocol method its method, a record's constructor functions
 * their names; a `defmethod` is no var and is counted apart), matched on (file, var) with the var definitions. Calls: a
 * truth pair is a var usage to a var of the repo, from the innermost graph symbol whose lines hold the usage, to the
 * var; a usage outside every symbol, and a symbol's use of its own var, are left out and counted. The graph's `calls`
 * edges of those files are mapped the same way: (source symbol, the var of the target). `canonical` turns a file name of
 * clj-kondo into the repo-relative path the graph uses (clj-kondo names a file reached through a symbolic link, such as
 * a Leiningen `checkouts` folder, by the link).
 */
export function scoreClojure(
  dump: ClojureDump,
  kondo: Kondo,
  canonical: (p: string) => string = strip,
  sample = 12,
): ClojureScore {
  const a = kondo.analysis;
  const canon = new Map<string, string>();
  const strip = (p: string): string => {
    let c = canon.get(p);
    if (c === undefined) {
      c = canonical(p);
      canon.set(p, c);
    }
    return c;
  };
  const files = dump.files.filter((f) => f.lang === "clojure");
  const kondoFiles = new Set(a["namespace-definitions"].map((d) => strip(d.filename)));
  const scored = new Set(files.filter((f) => kondoFiles.has(f.path)).map((f) => f.id));
  const scoredPaths = new Set(files.filter((f) => kondoFiles.has(f.path)).map((f) => f.path));
  const pathOf = new Map(files.map((f) => [f.id, f.path]));
  const nsOfFile = new Map(a["namespace-definitions"].map((d) => [strip(d.filename), d.name]));
  const syms = dump.symbols.filter((s) => scored.has(s.fileId));
  const interfaces = new Set(syms.filter((s) => s.kind === "interface").map((s) => `${s.fileId}\0${s.name}`));
  const varKey = new Map<string, string>(); // symbol id -> ns/var
  let defmethods = 0;
  for (const s of syms) {
    const v = varOf(s, interfaces);
    if (v === null) defmethods++;
    else varKey.set(s.id, `${nsOfFile.get(pathOf.get(s.fileId) as string)}/${v}`);
  }

  // Symbols, by (file, var).
  const graphDefs = new Set<string>();
  for (const s of syms) {
    const v = varOf(s, interfaces);
    if (v !== null) graphDefs.add(`${pathOf.get(s.fileId)}\0${v}`);
  }
  const truthDefs = new Map<string, KondoDef>();
  for (const d of a["var-definitions"]) {
    const p = strip(d.filename);
    if (scoredPaths.has(p)) truthDefs.set(`${p}\0${d.name}`, d);
  }
  const symHit = [...graphDefs].filter((k) => truthDefs.has(k)).length;
  const missedBy: Record<string, number> = {};
  for (const [k, d] of truthDefs)
    if (!graphDefs.has(k)) missedBy[d["defined-by"] ?? "?"] = (missedBy[d["defined-by"] ?? "?"] ?? 0) + 1;

  // Calls.
  const repoNs = new Set(a["namespace-definitions"].map((d) => d.name));
  const definedVars = new Set(a["var-definitions"].map((d) => `${d.ns}/${d.name}`));
  const symsByPath = new Map<string, DumpSymbol[]>();
  for (const s of syms) {
    const p = pathOf.get(s.fileId) as string;
    const list = symsByPath.get(p) ?? [];
    list.push(s);
    symsByPath.set(p, list);
  }
  const innermost = (p: string, row: number): DumpSymbol | null => {
    let best: DumpSymbol | null = null;
    for (const s of symsByPath.get(p) ?? [])
      if (
        s.startLine <= row &&
        row <= s.endLine &&
        (!best || s.endLine - s.startLine < best.endLine - best.startLine)
      )
        best = s;
    return best;
  };
  const truth = new Set<string>();
  let selfReferences = 0;
  let outsideDefinitions = 0;
  for (const u of a["var-usages"]) {
    const p = strip(u.filename);
    if (!scoredPaths.has(p)) continue;
    if (!repoNs.has(u.to) || !definedVars.has(`${u.to}/${u.name}`)) continue;
    const caller = innermost(p, u.row);
    if (!caller) {
      outsideDefinitions++;
      continue;
    }
    const dst = `${u.to}/${u.name}`;
    if (varKey.get(caller.id) === dst) {
      selfReferences++;
      continue;
    }
    truth.add(`${caller.id} -> ${dst}`);
  }
  const symIds = new Set(syms.map((s) => s.id));
  const graph = new Map<string, "high" | "low">();
  for (const e of dump.edges) {
    if (e.kind !== "calls" || !symIds.has(e.src) || !varKey.has(e.dst)) continue;
    const k = `${e.src} -> ${varKey.get(e.dst)}`;
    if (graph.get(k) !== "high") graph.set(k, e.confidence);
  }
  const hit = [...truth].filter((k) => graph.has(k)).length;
  const targetVars = new Set(varKey.values());
  const highs = [...graph].filter(([, c]) => c === "high");
  const lows = [...graph].filter(([, c]) => c === "low");
  return {
    files: files.length,
    scoredFiles: scored.size,
    kondoFilesNotIndexed: [...kondoFiles].filter((p) => !scoredPaths.has(p)).length,
    symbols: {
      precision: frac(symHit, graphDefs.size),
      recall: frac(symHit, truthDefs.size),
      defmethods,
      missedBy,
    },
    calls: {
      truthPairs: truth.size,
      selfReferences,
      outsideDefinitions,
      recall: frac(hit, truth.size),
      precision: frac([...graph.keys()].filter((k) => truth.has(k)).length, graph.size),
      precisionHigh: frac(highs.filter(([k]) => truth.has(k)).length, highs.length),
      precisionLow: frac(lows.filter(([k]) => truth.has(k)).length, lows.length),
      edges: { high: highs.length, low: lows.length },
      missedNoSymbol: [...truth].filter(
        (k) => !graph.has(k) && !targetVars.has(k.slice(k.indexOf(" -> ") + 4)),
      ).length,
      missed: [...truth].filter((k) => !graph.has(k)).slice(0, sample),
      wrong: [...graph.keys()].filter((k) => !truth.has(k)).slice(0, sample),
    },
  };
}

function parseArgs(argv: string[]) {
  const out = {
    only: [] as string[],
    repos: clojureReposPath,
    truth: false,
    report: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repos") out.repos = argv[++i] as string;
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--truth") out.truth = true;
    else if (a === "--only") {
      while (argv[i + 1] && !argv[i + 1]?.startsWith("--")) out.only.push(argv[++i] as string);
    } else throw new InputError(`unknown argument ${a}`);
  }
  return out;
}

const truthDir = () => resolve(process.env.GANTRY_PACKS_TRUTH_DIR || join(ossDir(), "packs-truth"));
const cliPath = () => resolve(process.env.GANTRY_CLI || join(repoRoot, "plugin/dist/cli.js"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function checkClone(r: Repo): string {
  const dir = targetDir(r);
  const rel = relative(repoRoot, dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new InputError(`${dir} is inside this repository`);
  if (!existsSync(dir))
    throw new InputError(`${r.name}: no clone at ${dir}; run pnpm eval:clone --repos ${clojureReposPath}`);
  if (git(dir, "rev-parse", "HEAD") !== r.sha)
    throw new InputError(`${r.name}: the clone is not at ${r.sha}`);
  if (git(dir, "status", "--porcelain") !== "") throw new InputError(`${r.name}: the clone has a dirty tree`);
  return dir;
}

/** The analysis of clj-kondo, made with `--truth` when it is missing; never overwritten. */
function kondoOf(r: Repo, clone: string, make: boolean): Kondo {
  const file = join(truthDir(), `${r.name}.kondo.json`);
  if (!existsSync(file)) {
    if (!make) throw new InputError(`${r.name}: no analysis at ${file}; run with --truth`);
    mkdirSync(truthDir(), { recursive: true });
    const fd = openSync(file, "w");
    try {
      // clj-kondo exits 2 or 3 when it finds lint warnings or errors; the analysis is written either way.
      const res = spawnSync(
        process.env.GANTRY_CLJ_KONDO || "clj-kondo",
        ["--parallel", "--cache", "false", "--lint", ".", "--config", KONDO_CONFIG],
        { cwd: clone, stdio: ["ignore", fd, "ignore"] },
      );
      if (res.error || (res.status !== 0 && res.status !== 2 && res.status !== 3))
        throw new Error(`clj-kondo failed in ${clone}: ${res.error?.message ?? `exit ${res.status}`}`);
    } finally {
      closeSync(fd);
    }
  }
  return JSON.parse(readFileSync(file, "utf8")) as Kondo;
}

/** One `index --dump` of the clone in a fresh data directory, with its wall time and peak memory. */
function indexRun(clone: string): { dump: ClojureDump; wallMs: number; rssBytes: number } {
  const data = mkdtempSync(join(tmpdir(), "gantry-clojure-data-"));
  const out = join(data, "dump.json");
  const fd = openSync(out, "w");
  try {
    const darwin = process.platform === "darwin";
    const t0 = process.hrtime.bigint();
    const res = spawnSync(
      "/usr/bin/time",
      [darwin ? "-l" : "-v", process.execPath, cliPath(), "index", "--dump"],
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
    return {
      dump: JSON.parse(readFileSync(out, "utf8")) as ClojureDump,
      wallMs,
      rssBytes: rss ? (darwin ? Number(rss) : Number(rss) * 1024) : 0,
    };
  } finally {
    closeSync(fd);
    rmSync(data, { recursive: true, force: true });
  }
}

/** The report text of one repo. */
export function reportOf(r: Repo, s: ClojureScore, run: { wallMs: number; rssBytes: number }): string {
  const c = s.calls;
  const top = Object.entries(s.symbols.missedBy)
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, 8)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `${r.name} (clojure) at ${r.sha}`,
    `  files indexed ${s.files}; scored ${s.scoredFiles}; analysed by clj-kondo but not indexed ${s.kondoFilesNotIndexed}`,
    `  index: ${(run.wallMs / 1000).toFixed(1)} s, peak ${Math.round(run.rssBytes / 1048576)} MB`,
    "  symbols",
    `    precision ${show(s.symbols.precision)}, recall ${show(s.symbols.recall)}`,
    `    defmethod symbols (no var, not scored) ${s.symbols.defmethods}`,
    `    missed, by the form that defines them: ${top || "none"}`,
    "  calls",
    `    truth pairs ${c.truthPairs}; left out: references to the caller's own var ${c.selfReferences}, usages outside every symbol ${c.outsideDefinitions}`,
    `    recall ${show(c.recall)}; missed pairs whose target has no symbol of ours ${c.missedNoSymbol}`,
    `    precision, all edges ${show(c.precision)}`,
    `    precision, high ${show(c.precisionHigh)}; low ${show(c.precisionLow)}`,
    `    edges: high ${c.edges.high}, low ${c.edges.low}, all level 1`,
    `    missed (sample): ${c.missed.join("; ") || "none"}`,
    `    wrong (sample): ${c.wrong.join("; ") || "none"}`,
  ].join("\n");
}

function main(): number {
  let args: ReturnType<typeof parseArgs>;
  let repos: Repo[];
  try {
    args = parseArgs(process.argv.slice(2));
    repos = readRepos(args.repos).filter((r) => args.only.length === 0 || args.only.includes(r.name));
    if (repos.length === 0) throw new InputError("no repo selected");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const parts: string[] = [];
  try {
    for (const r of repos) {
      const clone = checkClone(r);
      const kondo = kondoOf(r, clone, args.truth);
      const run = indexRun(clone);
      const text = reportOf(r, scoreClojure(run.dump, kondo, canonicalIn(clone)), run);
      console.log(text);
      parts.push(text);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return err instanceof InputError ? 2 : 1;
  }
  if (args.report) writeFileSync(args.report, `${parts.join("\n\n")}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
