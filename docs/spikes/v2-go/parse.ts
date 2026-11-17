// Spike v2-go-parse: tree-sitter Go (ast-grep) parse speed and top-level symbol accuracy vs go/ast.
// Usage: pnpm tsx docs/spikes/v2-go/parse.ts <repo-root> <truth.json> [--runs N]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classify,
  extractSymbols,
  GENERATED_RE,
  type GoSymbol,
  hasError,
  listGoFiles,
  median,
  parseGo,
} from "./lib.js";

const [root, truthPath] = process.argv.slice(2);
if (!root || !truthPath) throw new Error("usage: parse.ts <repo-root> <truth.json> [--runs N]");
const runsArg = process.argv.indexOf("--runs");
const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 3;

const files = classify(listGoFiles(root));
const sources = files.sources.map((f) => ({ f, src: readFileSync(join(root, f), "utf8") }));
const bytes = sources.reduce((a, s) => a + Buffer.byteLength(s.src), 0);

const parseMs: number[] = [];
const symMs: number[] = [];
let symbols: GoSymbol[] = [];
let errorFiles = 0;
for (let r = 0; r < runs; r++) {
  let tParse = 0;
  let tSym = 0;
  const syms: GoSymbol[] = [];
  let errs = 0;
  for (const { f, src } of sources) {
    const t0 = performance.now();
    const tree = parseGo(src);
    const t1 = performance.now();
    syms.push(...extractSymbols(f, tree));
    if (hasError(tree)) errs++;
    tSym += performance.now() - t1;
    tParse += t1 - t0;
  }
  parseMs.push(tParse);
  symMs.push(tSym);
  symbols = syms;
  errorFiles = errs;
}

interface Truth {
  symbols: GoSymbol[];
  generated: string[] | null;
  testFiles: number;
  vendorFiles: number;
  parseErrors: number;
}
const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Truth;
const key = (s: GoSymbol): string => `${s.file}|${s.kind}|${s.receiver ?? ""}|${s.name}`;
const count = (xs: GoSymbol[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const s of xs) m.set(key(s), (m.get(key(s)) ?? 0) + 1);
  return m;
};
const kinds = ["function", "method", "class", "interface", "type", "const", "var"] as const;
const rows: Record<string, { truth: number; found: number; tp: number; lineOk: number; exportedOk: number }> =
  {};
const tLines = new Map(truth.symbols.map((s) => [`${key(s)}|${s.line}`, s]));
const misses: string[] = [];
for (const k of kinds) {
  const t = count(truth.symbols.filter((s) => s.kind === k));
  const p = count(symbols.filter((s) => s.kind === k));
  let tp = 0;
  for (const [kk, n] of p) tp += Math.min(n, t.get(kk) ?? 0);
  for (const [kk, n] of t) if ((p.get(kk) ?? 0) < n && misses.length < 15) misses.push(`miss ${kk}`);
  for (const [kk, n] of p) if ((t.get(kk) ?? 0) < n && misses.length < 30) misses.push(`extra ${kk}`);
  const found = symbols.filter((s) => s.kind === k);
  rows[k] = {
    truth: [...t.values()].reduce((a, b) => a + b, 0),
    found: found.length,
    tp,
    lineOk: found.filter((s) => tLines.has(`${key(s)}|${s.line}`)).length,
    exportedOk: found.filter((s) => tLines.get(`${key(s)}|${s.line}`)?.exported === s.exported).length,
  };
}

// Stable-ID feasibility: package dir + receiver + name, ignoring build tags (all files of a dir).
const ids = new Map<string, string[]>();
for (const s of symbols) {
  if (s.name === "_" || s.name === "init") continue;
  const dir = s.file.includes("/") ? s.file.slice(0, s.file.lastIndexOf("/")) : ".";
  const id = `${dir}|${s.receiver ?? ""}|${s.name}`;
  const list = ids.get(id) ?? [];
  list.push(s.file);
  ids.set(id, list);
}
const dups = [...ids.entries()].filter(([, fs]) => fs.length > 1);
const constrained = new Set(
  sources
    .filter(
      (s) => /^\/\/go:build /m.test(s.src) || /_(windows|linux|darwin|unix|freebsd|other)\.go$/.test(s.f),
    )
    .map((s) => s.f),
);
// A duplicate is explained by build constraints when at most one of its files is unconstrained.
const tagged = dups.filter(([, fs]) => fs.filter((f) => !constrained.has(f)).length <= 1);
const blankOrInit = symbols.filter((s) => s.name === "_" || s.name === "init").length;

console.log(
  JSON.stringify(
    {
      files: {
        sources: files.sources.length,
        tests: files.tests.length,
        vendor: files.vendor.length,
        testdataOrHidden: files.testdata.length,
        generated: sources.filter((s) => GENERATED_RE.test(s.src)).length,
        truthGenerated: truth.generated?.length ?? 0,
        bytes,
      },
      parse: {
        runs,
        parseMsMedian: Math.round(median(parseMs)),
        symbolWalkMsMedian: Math.round(median(symMs)),
        parseMsAll: parseMs.map(Math.round),
        filesPerSec: Math.round(sources.length / (median(parseMs) / 1000)),
        mbPerSec: +(bytes / 1e6 / (median(parseMs) / 1000)).toFixed(1),
        errorFiles,
        goParserErrorFiles: truth.parseErrors,
      },
      symbols: rows,
      totals: {
        truth: truth.symbols.length,
        found: symbols.length,
        tp: Object.values(rows).reduce((a, r) => a + r.tp, 0),
      },
      stableIds: {
        ids: ids.size,
        duplicateIds: dups.length,
        duplicatesExplainedByBuildConstraints: tagged.length,
        blankOrInitSymbols: blankOrInit,
        examples: dups.slice(0, 8).map(([id, fs]) => `${id} <- ${fs.join(", ")}`),
      },
      misses,
    },
    null,
    2,
  ),
);
