// pnpm tsx evals/go/score-calls.ts <dump.json> <truth.json> (spec section 13).
// Scores the Go `calls` and `implements` edges of an `index --dump` against the type-checked truth of
// docs/spikes/v2-go/truth (go/packages). Edges are compared as the graph stores them: one per (caller, callee).
// Truth `pkgpath.Name` / `pkgpath.Recv.Name` is mapped to the symbols of the dump through the module path of the
// workspace that holds the file and the package directory. Only truth files in `callFiles` (the host build) are
// scored; each truth edge takes the kind of its first call site; a call of a function by itself is left out because
// the index stores no self edge. The Go toolchain is needed only to produce the truth file, never by Gantry.
//
// A call through an interface is matched on (caller, method name): the index points a call to a method that an
// embedded interface declares at the embedded interface's symbol, where go/types names the receiver's own interface.
//
// Prints { module, perKind, all, precision, implements } as JSON. Exit 0 when same-package and package-qualified
// recall are at least 0.99, concrete-method recall at least 0.90 and precision at least 0.999; 1 when one is not;
// 2 on unreadable input.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BARS = { samePackage: 0.99, qualified: 0.99, concreteMethod: 0.9, precision: 0.999 };

interface DumpFile {
  id: string;
  path: string;
  lang: string;
}
interface DumpSymbol {
  id: string;
  fileId: string;
  name: string;
  kind: string;
  lang: string;
}
interface DumpEdge {
  src: string;
  dst: string;
  kind: string;
}
interface DumpWorkspace {
  name: string;
  dir: string;
  lang?: string;
}
export interface Dump {
  workspaces?: DumpWorkspace[];
  files: DumpFile[];
  symbols: DumpSymbol[];
  edges: DumpEdge[];
}
interface TruthCall {
  file: string;
  name: string;
  caller: string;
  kind: string;
  callee?: string;
  inRepo: boolean;
}
export interface Truth {
  module: string;
  calls: TruthCall[];
  callFiles: string[];
  implementers: Record<string, string[]>;
}

const KINDS = {
  "same-package": "samePackage",
  "pkg-qualified": "qualified",
  method: "concreteMethod",
  "method-promoted": "promoted",
  "interface-method": "interfaceMethod",
} as const;
type KindName = (typeof KINDS)[keyof typeof KINDS];

export interface Recall {
  truth: number;
  matched: number;
  recall: number;
}
export interface CallScore {
  module: string;
  perKind: Record<KindName, Recall>;
  all: Recall & { found: number };
  precision: number;
  implements: { truth: number; found: number; matched: number; recall: number; precision: number };
}

const ratio = (n: number, d: number): number => (d === 0 ? 1 : Math.round((n / d) * 10000) / 10000);
const recall = (matched: number, truth: number): Recall => ({
  truth,
  matched,
  recall: ratio(matched, truth),
});
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

export function scoreCalls(dump: Dump, truth: Truth): CallScore {
  const pathOf = new Map(dump.files.map((f) => [f.id, f.path]));
  const symbols = new Map(dump.symbols.map((s) => [s.id, s]));
  const goWs = (dump.workspaces ?? []).filter((w) => w.lang === undefined || w.lang === "go");
  /** Package path of a file: the module path of the longest workspace directory holding it, plus the folder below. */
  const pkgPath = (path: string): string => {
    let best: DumpWorkspace | undefined;
    for (const w of goWs)
      if (w.dir === "." || path.startsWith(`${w.dir}/`))
        if (!best || (w.dir === "." ? 0 : w.dir.length) > (best.dir === "." ? 0 : best.dir.length)) best = w;
    const mod = best?.name ?? truth.module;
    const base = best?.dir ?? ".";
    const dir = dirOf(path);
    const sub = base === "." ? dir : dir === base ? "." : dir.slice(base.length + 1);
    return sub === "." ? mod : `${mod}/${sub}`;
  };
  const callFiles = new Set(truth.callFiles);
  const keyOf = (id: string): { file: string; key: string; name: string; kind: string } | null => {
    const s = symbols.get(id);
    const file = s ? pathOf.get(s.fileId) : undefined;
    if (!s || file === undefined) return null;
    return { file, key: `${pkgPath(file)}.${s.name}`, name: s.name, kind: s.kind };
  };
  /** Methods declared inside an interface body, as `Iface.Method` symbols of an `interface` symbol of the same file. */
  const interfaceNames = new Set(
    dump.symbols.filter((s) => s.kind === "interface").map((s) => `${s.fileId}#${s.name}`),
  );
  const isInterfaceMethod = (id: string): boolean => {
    const s = symbols.get(id);
    if (!s || s.kind !== "method") return false;
    return interfaceNames.has(`${s.fileId}#${s.name.slice(0, s.name.indexOf("."))}`);
  };
  const methodOf = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

  // Truth edges: one per (caller, callee), the kind of its first site.
  const truthEdges = new Map<string, KindName>();
  const truthIface = new Set<string>();
  for (const t of truth.calls) {
    if (!callFiles.has(t.file) || !t.inRepo || !t.callee) continue;
    const kind = (KINDS as Record<string, KindName | undefined>)[t.kind];
    if (!kind) continue;
    const caller = `${pkgPath(t.file)}.${t.caller}`;
    if (caller === t.callee) continue;
    const id = `${caller}|${t.callee}`;
    if (!truthEdges.has(id)) truthEdges.set(id, kind);
    if (kind === "interfaceMethod") truthIface.add(`${caller}|${methodOf(t.callee)}`);
  }

  // Dump edges from callers in the scored files.
  const found = new Set<string>();
  /** Loose key of the edges to an interface method symbol: found edge id to `caller|method`. */
  const foundIface = new Map<string, string>();
  for (const e of dump.edges) {
    if (e.kind !== "calls") continue;
    const src = keyOf(e.src);
    const dst = keyOf(e.dst);
    if (!src || !dst || !callFiles.has(src.file)) continue;
    const id = `${src.key}|${dst.key}`;
    found.add(id);
    if (isInterfaceMethod(e.dst)) foundIface.set(id, `${src.key}|${methodOf(dst.name)}`);
  }

  const perKind = Object.fromEntries(
    (Object.values(KINDS) as KindName[]).map((k) => [k, { truth: 0, matched: 0 }]),
  ) as Record<KindName, { truth: number; matched: number }>;
  const looseFound = new Set(foundIface.values());
  let matched = 0;
  for (const [id, kind] of truthEdges) {
    const sep = id.indexOf("|");
    const loose = `${id.slice(0, sep)}|${methodOf(id.slice(sep + 1))}`;
    const hit = found.has(id) || (kind === "interfaceMethod" && looseFound.has(loose));
    perKind[kind].truth++;
    if (hit) {
      perKind[kind].matched++;
      matched++;
    }
  }
  let correct = 0;
  for (const id of found) {
    const loose = foundIface.get(id);
    if (truthEdges.has(id) || (loose !== undefined && truthIface.has(loose))) correct++;
  }
  const foundCount = found.size;

  // `implements`: pairs of (concrete type, interface) among the scored files.
  const truthPairs = new Set<string>();
  for (const [iface, impls] of Object.entries(truth.implementers))
    for (const c of impls) truthPairs.add(`${c}|${iface}`);
  const foundPairs = new Set<string>();
  for (const e of dump.edges) {
    if (e.kind !== "implements") continue;
    const src = keyOf(e.src);
    const dst = keyOf(e.dst);
    if (src && dst && callFiles.has(src.file) && callFiles.has(dst.file))
      foundPairs.add(`${src.key}|${dst.key}`);
  }
  let pairHits = 0;
  for (const p of foundPairs) if (truthPairs.has(p)) pairHits++;

  return {
    module: truth.module,
    perKind: Object.fromEntries(
      (Object.keys(perKind) as KindName[]).map((k) => [k, recall(perKind[k].matched, perKind[k].truth)]),
    ) as Record<KindName, Recall>,
    all: { ...recall(matched, truthEdges.size), found: foundCount },
    precision: ratio(correct, foundCount),
    implements: {
      truth: truthPairs.size,
      found: foundPairs.size,
      matched: pairHits,
      recall: ratio(pairHits, truthPairs.size),
      precision: ratio(pairHits, foundPairs.size),
    },
  };
}

/** True when every bar of the issue is met. */
export const passes = (s: CallScore): boolean =>
  s.perKind.samePackage.recall >= BARS.samePackage &&
  s.perKind.qualified.recall >= BARS.qualified &&
  s.perKind.concreteMethod.recall >= BARS.concreteMethod &&
  s.precision >= BARS.precision;

function main(): number {
  const [dumpPath, truthPath] = process.argv.slice(2);
  if (!dumpPath || !truthPath) {
    process.stderr.write("usage: score-calls.ts <dump.json> <truth.json>\n");
    return 2;
  }
  let result: CallScore;
  try {
    const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
    const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Truth;
    result = scoreCalls(dump, truth);
  } catch (err) {
    process.stderr.write(`score-calls: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return passes(result) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
