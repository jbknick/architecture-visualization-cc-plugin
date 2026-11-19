/**
 * Regression check on the M0 hand-written pairs (`docs/spikes/embed/pairs.jsonl`, public): the same-or-different
 * recall and false-positive rate of the code and description cosines at the old and the chosen thresholds, with
 * the product's own embedder and normalizer, and (#131) how the token gates treat the code pairs: the near tier's
 * gate (`nearTokenJaccard`, with the shape gate and the 6-statement floor) and the code-vector tier's gate
 * (`codeVectorTokenJaccard`, on the pairs at or above `codeVector`). These pairs were not used to fit the gates.
 * Public data only.
 *
 * Usage: pnpm tsx evals/m2/pairs.ts [codeVector semantic]   (default: the thresholds in the default config)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cachedEmbedder,
  hashSymbol,
  MINHASH_PERMUTATIONS,
  minhashJaccard,
  NEAR_MIN_STMTS,
  nearScore,
  normalizeForEmbedding,
  parseSource,
} from "../../packages/core/src/index.js";
import { DEFAULT_THRESHOLDS } from "./defaults.js";
import { gantryRoot, pct, table } from "./lib.js";

interface Pair {
  kind: "code" | "description";
  same: boolean;
  topic: string;
  a: string;
  b: string;
}
const pairs = readFileSync(join(gantryRoot, "docs", "spikes", "embed", "pairs.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Pair);
const embedder = await cachedEmbedder()();
if (!embedder) throw new Error("embedding model is not cached");

function codeText(src: string): string {
  const parsed = parseSource("repo", "pair.ts", src);
  const sym = parsed.symbols.find((s) => ["function", "component", "hook", "method"].includes(s.kind));
  const range = sym && parsed.bodies.get(sym.id);
  return range ? normalizeForEmbedding(src, range, "ts") : src;
}
function features(src: string): { stmt: number } & ReturnType<typeof hashSymbol> {
  const parsed = parseSource("repo", "pair.ts", src);
  const sym = parsed.symbols.find((s) => ["function", "component", "hook", "method"].includes(s.kind));
  const range = sym && parsed.bodies.get(sym.id);
  if (!sym || !range) throw new Error("pair without a function");
  return { stmt: sym.stmtCount, ...hashSymbol(src, range, "ts") };
}
const dot = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * (b[i] as number), 0);

const cfg = DEFAULT_THRESHOLDS;
const cv = Number(process.argv[2] ?? cfg.codeVector);
const sem = Number(process.argv[3] ?? cfg.semantic);
const rows: (string | number)[][] = [];
for (const [kind, thresholds] of [
  ["code", [0.92, 0.96, cv]],
  ["description", [0.6, sem]],
] as const) {
  const ps = pairs.filter((p) => p.kind === kind);
  const va = await embedder.embed(
    ps.map((p) => (kind === "code" ? codeText(p.a) : p.a)),
    kind === "code" ? "code" : "document",
  );
  const vb = await embedder.embed(
    ps.map((p) => (kind === "code" ? codeText(p.b) : p.b)),
    kind === "code" ? "code" : "document",
  );
  const cos = ps.map((_, i) => dot(va[i] as Float32Array, vb[i] as Float32Array));
  for (const t of [...new Set(thresholds)]) {
    const same = ps.filter((p) => p.same);
    const diff = ps.filter((p) => !p.same);
    const hit = same.filter((p) => (cos[ps.indexOf(p)] as number) >= t).length;
    const fp = diff.filter((p) => (cos[ps.indexOf(p)] as number) >= t).length;
    rows.push([
      kind,
      t,
      `${hit}/${same.length} (${pct(hit, same.length)})`,
      `${fp}/${diff.length} (${pct(fp, diff.length)})`,
    ]);
  }
}
process.stdout.write(
  `${table(["pairs", "threshold", "same pairs found", "different pairs flagged"], rows)}\n`,
);

// Token gates (#131) on the code pairs.
const code = pairs.filter((p) => p.kind === "code");
const fa = code.map((p) => features(p.a));
const fb = code.map((p) => features(p.b));
const tok = code.map((_, i) =>
  minhashJaccard(fa[i]?.nearMinhash as Uint32Array, fb[i]?.nearMinhash as Uint32Array),
);
const cvA = await embedder.embed(
  code.map((p) => codeText(p.a)),
  "code",
);
const cvB = await embedder.embed(
  code.map((p) => codeText(p.b)),
  "code",
);
const cosC = code.map((_, i) => dot(cvA[i] as Float32Array, cvB[i] as Float32Array));
const gateRows: (string | number)[][] = [];
const count = (
  same: boolean,
  ok: (i: number) => boolean,
  among: (i: number) => boolean = () => true,
): string => {
  const idx = code.map((p, i) => i).filter((i) => code[i]?.same === same && among(i));
  return `${idx.filter(ok).length}/${idx.length}`;
};
const bigEnough = (i: number): boolean =>
  (fa[i]?.stmt ?? 0) >= NEAR_MIN_STMTS && (fb[i]?.stmt ?? 0) >= NEAR_MIN_STMTS;
const near = (i: number): boolean =>
  fa[i]?.nearMinhash.length === MINHASH_PERMUTATIONS &&
  nearScore(fa[i] as NonNullable<(typeof fa)[number]>, fb[i] as NonNullable<(typeof fb)[number]>, cfg) !==
    null;
gateRows.push([
  "token Jaccard >= nearTokenJaccard, all pairs",
  cfg.nearTokenJaccard,
  count(true, (i) => (tok[i] ?? 0) >= cfg.nearTokenJaccard),
  count(false, (i) => (tok[i] ?? 0) >= cfg.nearTokenJaccard),
]);
gateRows.push([
  "whole near tier, pairs of >= 6 statements",
  cfg.nearTokenJaccard,
  count(true, near, bigEnough),
  count(false, near, bigEnough),
]);
const cvHit = (i: number): boolean => (cosC[i] ?? 0) >= cv;
gateRows.push([
  "code_vector >= codeVector, without the token gate",
  cv,
  count(true, cvHit),
  count(false, cvHit),
]);
gateRows.push([
  "code_vector >= codeVector, with codeVectorTokenJaccard",
  cfg.codeVectorTokenJaccard,
  count(true, (i) => cvHit(i) && (tok[i] ?? 0) >= cfg.codeVectorTokenJaccard),
  count(false, (i) => cvHit(i) && (tok[i] ?? 0) >= cfg.codeVectorTokenJaccard),
]);
process.stdout.write(
  `\n${table(["code pairs, token gates (#131)", "threshold", "same pairs kept", "different pairs kept"], gateRows)}\n`,
);
