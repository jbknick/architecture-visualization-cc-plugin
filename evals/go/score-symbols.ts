// pnpm tsx evals/go/score-symbols.ts <dump.json> <truth.json> (spec section 13).
// Scores the Go symbols of an `index --dump` against the ground truth of docs/spikes/v2-go/truth (go/ast).
// Prints { repo, perKind, all } as JSON. Exit 0 when every kind reaches 99% precision and 99% recall, 1 when one
// does not, 2 on unreadable input. The Go toolchain is needed only to produce the truth file, never by Gantry.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BAR = 0.99;

interface DumpFile {
  id: string;
  path: string;
  lang: string;
}
interface DumpSymbol {
  fileId: string;
  name: string;
  kind: string;
  lang: string;
}
export interface Dump {
  files: DumpFile[];
  symbols: DumpSymbol[];
}
interface TruthSymbol {
  file: string;
  name: string;
  receiver?: string;
  kind: string;
}
export interface Truth {
  module?: string;
  symbols: TruthSymbol[];
}

export interface KindScore {
  truth: number;
  found: number;
  matched: number;
  precision: number;
  recall: number;
}
export interface Score {
  repo: string;
  perKind: Record<string, KindScore>;
  all: KindScore;
}

/** The neutral kinds the index uses for the truth program's Go kinds. */
const TRUTH_KIND: Record<string, string> = { struct: "class", var: "const" };

const keyOf = (file: string, kind: string, receiver: string, name: string): string =>
  `${file}|${kind}|${receiver}|${name}`;

const counts = (keys: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
};

const ratio = (n: number, d: number): number => (d === 0 ? 1 : Math.round((n / d) * 10000) / 10000);

function score(truth: number, found: number, matched: number): KindScore {
  return { truth, found, matched, precision: ratio(matched, found), recall: ratio(matched, truth) };
}

/** Compares symbols on (file, kind, receiver, name); multiplicities count. Test files are outside the truth. */
export function scoreSymbols(dump: Dump, truth: Truth): Score {
  const pathOf = new Map(dump.files.map((f) => [f.id, f.path]));
  const found = new Map<string, string[]>();
  for (const s of dump.symbols) {
    if (s.lang !== "go") continue;
    const file = pathOf.get(s.fileId);
    if (file === undefined || file.endsWith("_test.go")) continue;
    let receiver = "";
    let name = s.name;
    if (s.kind === "method") {
      const dot = s.name.indexOf(".");
      receiver = s.name.slice(0, dot);
      name = s.name.slice(dot + 1);
    }
    const list = found.get(s.kind) ?? [];
    list.push(keyOf(file, s.kind, receiver, name));
    found.set(s.kind, list);
  }
  const expected = new Map<string, string[]>();
  for (const s of truth.symbols) {
    const kind = TRUTH_KIND[s.kind] ?? s.kind;
    const list = expected.get(kind) ?? [];
    list.push(keyOf(s.file, kind, s.receiver ?? "", s.name));
    expected.set(kind, list);
  }
  const perKind: Record<string, KindScore> = {};
  let t = 0;
  let f = 0;
  let m = 0;
  for (const kind of [...new Set([...found.keys(), ...expected.keys()])].sort()) {
    const tk = expected.get(kind) ?? [];
    const fk = found.get(kind) ?? [];
    const tc = counts(tk);
    let matched = 0;
    for (const [k, n] of counts(fk)) matched += Math.min(n, tc.get(k) ?? 0);
    perKind[kind] = score(tk.length, fk.length, matched);
    t += tk.length;
    f += fk.length;
    m += matched;
  }
  return { repo: truth.module ?? "", perKind, all: score(t, f, m) };
}

/** True when every kind reaches the bar on precision and recall. */
export const passes = (s: Score): boolean =>
  Object.values(s.perKind).every((k) => k.precision >= BAR && k.recall >= BAR);

function main(): number {
  const [dumpPath, truthPath] = process.argv.slice(2);
  if (!dumpPath || !truthPath) {
    process.stderr.write("usage: score-symbols.ts <dump.json> <truth.json>\n");
    return 2;
  }
  let result: Score;
  try {
    const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
    const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Truth;
    result = scoreSymbols(dump, truth);
  } catch (err) {
    process.stderr.write(`score-symbols: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return passes(result) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
