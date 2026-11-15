/**
 * Regression check on the M0 hand-written pairs (`docs/spikes/embed/pairs.jsonl`, public): the same-or-different
 * recall and false-positive rate of the code and description cosines at the old and the chosen thresholds, with
 * the product's own embedder and normalizer. Public data only.
 *
 * Usage: pnpm tsx evals/m2/pairs.ts [codeVector semantic]   (default: the thresholds in the default config)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cachedEmbedder, normalizeForEmbedding, parseSource } from "../../packages/core/src/index.js";
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
  const parsed = parseSource("pair.ts", src);
  const sym = parsed.symbols.find((s) => ["function", "component", "hook", "method"].includes(s.kind));
  const range = sym && parsed.bodies.get(sym.id);
  return range ? normalizeForEmbedding(src, range, "ts") : src;
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
