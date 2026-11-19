/**
 * Go seeded duplicates with the local embedding model (not part of `pnpm check`). Same loop as `seeded.test.ts`, and
 * with `--embed` each draft is embedded by `gantry embed` (the built CLI, so run `pnpm build` first) before the engine
 * is asked, which lets the code_vector tier answer the misleading cases.
 *
 * Usage: GANTRY_MODELS_DIR=$HOME/.gantry/models pnpm tsx evals/seeded-duplicates-go/run.ts --embed
 * Prints `{ found, misleadingFound, perCase: [{ id, tier, score }], negatives: [{ id, candidates }] }` as JSON.
 * Bar (docs/milestones/M2.md section 1): found >= 8 of 10 and misleadingFound >= 2 of 3.
 */
import { Harness, loadCases, loadNegatives } from "./lib.js";

const embed = process.argv.includes("--embed");
const h = await Harness.create();
try {
  if (embed) h.embed();
  let found = 0;
  let misleadingFound = 0;
  const perCase: { id: string; tier: string | null; score: number | null; top: string | null }[] = [];
  for (const c of loadCases()) {
    // The draft is in the working layer once `place` has indexed it; embed it, then ask again.
    let { candidates } = await h.place(c.targetFile, h.codeOf(c));
    if (embed) {
      h.embed();
      candidates = (await h.again(c.targetFile)).candidates;
    }
    h.clear(c.targetFile);
    const hit = candidates.find((x) => x.symbolId === h.id(c.existing));
    const ok = hit !== undefined && c.expected.tiers.includes(hit.tier) && candidates[0] === hit;
    if (ok) {
      found++;
      if (c.misleading) misleadingFound++;
    }
    perCase.push({
      id: c.id,
      tier: hit?.tier ?? null,
      score: hit ? Number(hit.score.toFixed(4)) : null,
      top: candidates[0]?.symbolId.split("#")[1] ?? null,
    });
  }
  const negatives: { id: string; candidates: number }[] = [];
  for (const n of loadNegatives()) {
    let { candidates } = await h.place(n.targetFile, n.newCode);
    if (embed) {
      h.embed();
      candidates = (await h.again(n.targetFile)).candidates;
    }
    h.clear(n.targetFile);
    negatives.push({ id: n.id, candidates: candidates.length });
  }
  process.stdout.write(`${JSON.stringify({ embed, found, misleadingFound, perCase, negatives }, null, 2)}\n`);
} finally {
  h.close();
}
