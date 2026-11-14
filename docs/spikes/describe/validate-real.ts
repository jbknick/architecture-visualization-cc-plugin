// Runs validateDescription (issue #22) over the stored real model outputs of the M0 describe spike. No model calls.
// Usage: GANTRY_PRIVATE_DIR=<dir holding labelled/ and describe-out/> pnpm tsx docs/spikes/describe/validate-real.ts
// Prints COUNTS ONLY: accepted, repaired, and rejected per reason code, plus how often each fixed-vocabulary rule
// fired. It never prints a description, a fact sheet, a token from either, or a failure detail. The inputs are private
// (git-ignored evals/private/) and must not be copied into commits or the PR.

import { join } from "node:path";
import { addressingHits, shapeProblem } from "../../../packages/core/src/describe/shape.js";
import { validateDescription } from "../../../packages/core/src/describe/validate.js";
import type { FactSheet } from "../../../packages/core/src/types.js";
import { descriptionsFrom, loadCalls, loadLabelled, outDir } from "./store.js";

const rows = loadLabelled();
const base = descriptionsFrom(loadCalls(join(outDir, "path-a"), "call"));
const retried = descriptionsFrom(loadCalls(join(outDir, "retry"), "call"));

function run(label: string, descs: Map<string, unknown>): void {
  let total = 0;
  let accepted = 0;
  let repaired = 0;
  const byReason = new Map<string, number>();
  const shape = new Map<string, number>();
  const addressing = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const row of rows) {
    const d = descs.get(row.factSheet.contentKey);
    if (d === undefined) continue;
    total++;
    const sheet = row.factSheet as unknown as FactSheet;
    const r = validateDescription(d, sheet);
    if (r.ok) {
      accepted++;
      if (r.repairs !== undefined) repaired++;
      continue;
    }
    bump(byReason, r.reason);
    const behavior = (d as { behavior?: unknown }).behavior;
    if (r.reason === "shape" && typeof behavior === "string") {
      const p = shapeProblem(behavior);
      if (p !== null) bump(shape, p);
      for (const w of addressingHits(behavior)) bump(addressing, w);
    }
  }
  const pct = (n: number) => (total === 0 ? "n/a" : `${((100 * n) / total).toFixed(1)}%`);
  const fmt = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(" ") || "none";
  console.log(`${label}: ${total} descriptions`);
  console.log(`  accepted ${accepted} (${pct(accepted)}), of which repaired ${repaired}`);
  console.log(`  rejected ${total - accepted} (${pct(total - accepted)}): ${fmt(byReason)}`);
  console.log(`  shape problems: ${fmt(shape)}`);
  console.log(`  addressing words: ${fmt(addressing)}`);
}

run("path A (headless Haiku/low)", base);
const merged = new Map(base);
for (const [k, v] of retried) merged.set(k, v);
if (retried.size > 0) run("path A with the Sonnet retry of the 20 worst", merged);
