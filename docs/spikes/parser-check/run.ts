// Spike: community tags.scm queries (web-tree-sitter) against @ast-grep/napi with node-kind tables, on five languages.
// Usage: pnpm tsx docs/spikes/parser-check/run.ts <setup | sample | score | bench>
//   setup   installs the packages into a temp dir and clones the five repos at their pinned SHAs
//   sample  picks the 15 files per language from the seed and writes sample.json
//   score   runs both parsers over the sampled files and compares with hand-counts.json
//   bench   runs both parsers over every file of each repo: counts, time (three runs, worst), peak RSS
// Packages and clones live in $PARSER_CHECK_DIR (default: <os tmp>/parser-check); no manifest or lockfile of the repo changes.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addCounts, type Counts, emptyCounts, loadAstGrep, loadTags } from "./engines.ts";
import { LANGS, type Lang, MAX_LINES, MIN_LINES, PACKAGES, SAMPLE_SIZE, SEED } from "./langs.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WORK = process.env.PARSER_CHECK_DIR ?? join(tmpdir(), "parser-check");
export const repoDir = (lang: Lang): string => join(WORK, "repos", lang.id);

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Tracked files of the repo with the language's extension, in git's (byte) order. */
export function listFiles(lang: Lang): string[] {
  return sh("git", ["ls-files", `*${lang.ext}`], repoDir(lang))
    .split("\n")
    .filter(Boolean);
}

function setup(): void {
  mkdirSync(WORK, { recursive: true });
  if (!existsSync(join(WORK, "node_modules", "web-tree-sitter"))) {
    writeFileSync(
      join(WORK, "package.json"),
      JSON.stringify({ name: "parser-check-deps", private: true, dependencies: PACKAGES }, null, 2),
    );
    sh("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], WORK);
  }
  for (const lang of LANGS) {
    const dir = repoDir(lang);
    if (existsSync(join(dir, ".git"))) continue;
    mkdirSync(dir, { recursive: true });
    sh("git", ["init", "-q"], dir);
    sh("git", ["remote", "add", "origin", lang.repo.url], dir);
    sh("git", ["fetch", "-q", "--depth", "1", "origin", lang.repo.sha], dir);
    sh("git", ["checkout", "-q", "FETCH_HEAD"], dir);
    process.stdout.write(
      `${lang.label}: ${lang.repo.name} @ ${sh("git", ["rev-parse", "HEAD"], dir).trim()}\n`,
    );
  }
}

/** mulberry32: a small seeded generator, so the sample is the same on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The sample: eligible files (30 to 250 lines), Fisher-Yates shuffled with the seed, first 15, sorted by path. */
export function pickSample(lang: Lang): { total: number; eligible: number; files: string[] } {
  const all = listFiles(lang);
  const eligible = all.filter((f) => {
    const lines = readFileSync(join(repoDir(lang), f), "utf8").split("\n").length;
    return lines >= MIN_LINES && lines <= MAX_LINES;
  });
  const next = rng(SEED);
  const pool = [...eligible];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as string, pool[i] as string];
  }
  return { total: all.length, eligible: eligible.length, files: pool.slice(0, SAMPLE_SIZE).sort() };
}

function sample(): void {
  const out: Record<string, unknown> = {};
  for (const lang of LANGS) {
    const s = pickSample(lang);
    out[lang.id] = { repo: lang.repo.name, sha: lang.repo.sha, ...s };
    process.stdout.write(`${lang.label}: ${s.total} files, ${s.eligible} eligible\n`);
  }
  writeFileSync(join(HERE, "sample.json"), `${JSON.stringify(out, null, 2)}\n`);
}

// ---------------------------------------------------------------- score against the hand counts

interface Hand {
  function: number;
  method: number;
  class: number;
  interface: number;
  module: number;
  call: number;
  new: number;
  macro: number;
  inMacro: number;
  import: number;
}

/** A metric compares vectors of counts per file: matched is the sum of the smaller number in each position. */
const METRICS: Record<string, (c: Counts) => number[]> = {
  definitions: (c) => [c.function, c.method, c.class, c.interface, c.module],
  definitionsMerged: (c) => [c.function + c.method, c.class, c.interface, c.module],
  calls: (c) => [c.call],
  newExpressions: (c) => [c.new],
  macros: (c) => [c.macro],
  imports: (c) => [c.import],
};

interface Score {
  hand: number;
  tool: number;
  matched: number;
  recall: number | null;
  precision: number | null;
}

function score(pairs: { hand: Counts; tool: Counts }[], pick: (c: Counts) => number[]): Score {
  let hand = 0;
  let tool = 0;
  let matched = 0;
  for (const p of pairs) {
    const h = pick(p.hand);
    const t = pick(p.tool);
    for (let i = 0; i < h.length; i++) {
      hand += h[i] as number;
      tool += t[i] as number;
      matched += Math.min(h[i] as number, t[i] as number);
    }
  }
  return {
    hand,
    tool,
    matched,
    recall: hand > 0 ? matched / hand : null,
    precision: tool > 0 ? matched / tool : null,
  };
}

const handToCounts = (h: Hand): Counts => ({ ...emptyCounts(), ...h });

function readTagsInfo(lang: Lang, query: { captureNames: string[]; patternCount(): number }, path: string) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith(";"));
  const captures = query.captureNames.filter(
    (n) => n.startsWith("definition.") || n.startsWith("reference."),
  );
  return {
    exists: true,
    nonBlankLines: lines.length,
    patterns: query.patternCount(),
    tagCaptures: [...new Set(captures)].sort(),
    hasImportCapture: query.captureNames.some((n) => n.includes("import")),
    language: lang.id,
  };
}

async function scoreCommand(): Promise<void> {
  const hand = JSON.parse(readFileSync(join(HERE, "hand-counts.json"), "utf8")) as {
    languages: Record<string, { files: Record<string, Hand> }>;
  };
  const out: Record<string, unknown> = {};
  for (const lang of LANGS) {
    const files = hand.languages[lang.id]?.files ?? {};
    const tags = await loadTags(WORK, lang);
    const ast = loadAstGrep(WORK, lang);
    const rows: {
      path: string;
      hand: Counts;
      tags: Counts;
      ast: Counts;
      tagsError: boolean;
      astError: boolean;
    }[] = [];
    for (const [path, h] of Object.entries(files)) {
      const source = readFileSync(join(repoDir(lang), path), "utf8");
      const t = tags.run(source, true, true);
      const a = ast.run(source, true);
      rows.push({
        path,
        hand: handToCounts(h),
        tags: t?.counts ?? emptyCounts(),
        ast: a?.counts ?? emptyCounts(),
        tagsError: t?.hasError ?? true,
        astError: a?.hasError ?? true,
      });
    }
    const totals = { hand: emptyCounts(), tags: emptyCounts(), ast: emptyCounts() };
    for (const r of rows) {
      addCounts(totals.hand, r.hand);
      addCounts(totals.tags, r.tags);
      addCounts(totals.ast, r.ast);
    }
    const tagScores: Record<string, Score> = {};
    const astScores: Record<string, Score> = {};
    for (const [name, pick] of Object.entries(METRICS)) {
      tagScores[name] = score(
        rows.map((r) => ({ hand: r.hand, tool: r.tags })),
        pick,
      );
      astScores[name] = score(
        rows.map((r) => ({ hand: r.hand, tool: r.ast })),
        pick,
      );
    }
    const scores: Record<string, Record<string, Score>> = { tags: tagScores, ast: astScores };
    const inMacro = Object.values(files).reduce((n, f) => n + f.inMacro, 0);
    out[lang.id] = {
      files: rows,
      totals,
      handCallsInsideMacroArguments: inMacro,
      scores,
      parseErrorFiles: {
        tags: rows.filter((r) => r.tagsError).length,
        ast: rows.filter((r) => r.astError).length,
      },
      tagsInfo: readTagsInfo(lang, tags.query, tags.tagsPath),
      tagsAbi: tags.abiVersion,
    };
    const s = scores;
    const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
    for (const p of ["tags", "ast"] as const) {
      const d = s[p]?.definitions as Score;
      const m = s[p]?.definitionsMerged as Score;
      const c = s[p]?.calls as Score;
      process.stdout.write(
        `${lang.label} ${p}: defs recall ${pct(d.recall)} precision ${pct(d.precision)}; merged ${pct(m.recall)}/${pct(m.precision)}; calls recall ${pct(c.recall)} precision ${pct(c.precision)}\n`,
      );
    }
  }
  writeFileSync(join(HERE, "score.json"), `${JSON.stringify(out, null, 2)}\n`);
}

// ---------------------------------------------------------------- whole-repo counts, timings, memory

type Parser = "tags" | "ast";

async function engineFor(parser: Parser, lang: Lang) {
  if (parser === "tags") {
    const e = await loadTags(WORK, lang);
    return (source: string, extract: boolean, free: boolean) => e.run(source, extract, free);
  }
  const e = loadAstGrep(WORK, lang);
  return (source: string, extract: boolean, _free: boolean) => e.run(source, extract);
}

/** Child process: one pass over every file of the repo with one parser. Prints one JSON line. */
async function timeChild(parser: Parser, langId: string, pass: string, free: boolean): Promise<void> {
  const lang = LANGS.find((l) => l.id === langId) as Lang;
  const run = await engineFor(parser, lang);
  const files = listFiles(lang);
  const extract = pass === "full";
  run("", extract, true); // warm-up on an empty file, outside the timing
  const rssBefore = process.memoryUsage().rss;
  let ns = 0n;
  const totals = emptyCounts();
  let errorFiles = 0;
  for (const f of files) {
    const source = readFileSync(join(repoDir(lang), f), "utf8");
    const t0 = process.hrtime.bigint();
    const r = run(source, extract, free);
    ns += process.hrtime.bigint() - t0;
    if (r) {
      addCounts(totals, r.counts);
      if (r.hasError) errorFiles++;
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      files: files.length,
      ms: Number(ns / 1000n) / 1000,
      rssBeforeKb: Math.round(rssBefore / 1024),
      maxRssKb: process.resourceUsage().maxRSS,
      totals,
      errorFiles,
    })}\n`,
  );
}

interface ChildResult {
  files: number;
  ms: number;
  rssBeforeKb: number;
  maxRssKb: number;
  totals: Counts;
  errorFiles: number;
}

function spawnChild(parser: Parser, lang: Lang, pass: string, free: boolean): ChildResult {
  const args = [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "time",
    parser,
    lang.id,
    pass,
    free ? "free" : "nofree",
  ];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env: process.env, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() as string) as ChildResult;
}

const uptime = (): string => execFileSync("uptime", { encoding: "utf8" }).trim();
const worst = (xs: number[]): number => Math.max(...xs);

function bench(): void {
  const out: Record<string, unknown> = {
    machine: {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      uptimeAtStart: uptime(),
    },
    packages: PACKAGES,
    languages: {} as Record<string, unknown>,
  };
  const langs = out.languages as Record<string, unknown>;
  for (const lang of LANGS) {
    const entry: Record<string, unknown> = { repo: lang.repo.name, sha: lang.repo.sha };
    for (const parser of ["tags", "ast"] as const) {
      const parseRuns = [0, 1, 2].map(() => spawnChild(parser, lang, "parse", true));
      const fullRuns = [0, 1, 2].map(() => spawnChild(parser, lang, "full", true));
      const noFree = parser === "tags" ? spawnChild(parser, lang, "full", false) : undefined;
      const first = fullRuns[0] as ChildResult;
      entry[parser] = {
        files: first.files,
        parseMsRuns: parseRuns.map((r) => r.ms),
        parseMsWorst: worst(parseRuns.map((r) => r.ms)),
        fullMsRuns: fullRuns.map((r) => r.ms),
        fullMsWorst: worst(fullRuns.map((r) => r.ms)),
        rssBeforeKb: first.rssBeforeKb,
        peakRssKbWorst: worst(fullRuns.map((r) => r.maxRssKb)),
        peakRssKbNoFree: noFree?.maxRssKb,
        totals: first.totals,
        filesWithParseErrors: first.errorFiles,
      };
      process.stdout.write(
        `${lang.label} ${parser}: ${first.files} files, parse worst ${worst(parseRuns.map((r) => r.ms)).toFixed(0)} ms, parse+extract worst ${worst(fullRuns.map((r) => r.ms)).toFixed(0)} ms, peak RSS ${worst(fullRuns.map((r) => r.maxRssKb))} KB\n`,
      );
    }
    langs[lang.id] = entry;
  }
  (out.machine as Record<string, unknown>).uptimeAtEnd = uptime();
  writeFileSync(join(HERE, "bench.json"), `${JSON.stringify(out, null, 2)}\n`);
}

// ---------------------------------------------------------------- lines of table

function tableLines(): void {
  const src = readFileSync(join(HERE, "tables.ts"), "utf8").split("\n");
  const counts: Record<string, number> = {};
  for (const lang of LANGS) {
    const a = src.indexOf(`  // ${lang.id}:begin`);
    const b = src.indexOf(`  // ${lang.id}:end`);
    counts[lang.id] = src.slice(a + 1, b).filter((l) => l.trim() !== "").length;
  }
  const eng = readFileSync(join(HERE, "engines.ts"), "utf8").split("\n");
  const a = eng.indexOf("// classify:begin");
  const b = eng.indexOf("// classify:end");
  counts.shared = eng.slice(a + 1, b).filter((l) => l.trim() !== "").length;
  writeFileSync(join(HERE, "table-lines.json"), `${JSON.stringify(counts, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

const command = process.argv[2];
if (command === "setup") setup();
else if (command === "sample") sample();
else if (command === "score") await scoreCommand();
else if (command === "bench") bench();
else if (command === "table-lines") tableLines();
else if (command === "time")
  await timeChild(
    process.argv[3] as Parser,
    process.argv[4] as string,
    process.argv[5] as string,
    process.argv[6] === "free",
  );
else {
  process.stderr.write("usage: run.ts <setup | sample | score | bench | table-lines>\n");
  process.exitCode = 1;
}
