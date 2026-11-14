// Reprints the issue #6 score table from stored outputs under evals/private/describe-out/. No model calls.
// Usage: pnpm tsx docs/spikes/describe/score.ts
// Prints aggregate numbers only. Raw outputs and the labelled set are private and never printed.

import { join } from "node:path";
import { fixed, mdTable, type PathSummary, pct, summarize } from "./lib.js";
import {
  type CallRecord,
  descriptionsFrom,
  gradesFrom,
  loadCalls,
  loadLabelled,
  outDir,
  readJson,
  totalInput,
} from "./store.js";

const TARGETS = { acceptable: 0.85, schema: 0.98, nameFitsPrecision: 0.8 };
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

interface PathReport {
  name: string;
  summary: PathSummary;
  inPerFn: number | null;
  outPerFn: number | null;
  secPerFn: number | null;
  calls: number;
  note: string;
}

function perFunction(calls: CallRecord[], n: number) {
  const ok = calls.filter((c) => c.usage);
  if (ok.length === 0 || n === 0) return { inPerFn: null, outPerFn: null, secPerFn: null };
  const inTok = ok.reduce((a, c) => a + totalInput(c.usage as NonNullable<CallRecord["usage"]>), 0);
  const outTok = ok.reduce((a, c) => a + (c.usage?.outputTokens ?? 0), 0);
  const wall = ok.reduce((a, c) => a + c.wallMs, 0);
  return { inPerFn: inTok / n, outPerFn: outTok / n, secPerFn: wall / 1000 / n };
}

const rows = loadLabelled();
const reports: PathReport[] = [];

// Path A: headless recipe, Haiku/low, 5 batches of 40.
const aCalls = loadCalls(join(outDir, "path-a"), "call");
const aGrades = gradesFrom(loadCalls(join(outDir, "path-a"), "grade"));
if (aCalls.length > 0) {
  const descs = descriptionsFrom(aCalls);
  const summary = summarize(rows, descs, aGrades);
  reports.push({
    name: "A: headless Haiku/low",
    summary,
    ...perFunction(aCalls, summary.described),
    calls: aCalls.length,
    note: `${aCalls.length} calls of up to 40`,
  });
}

// Path A plus Sonnet retry: the 20 worst items replaced by the Sonnet/low rewrite.
const rCalls = loadCalls(join(outDir, "retry"), "call");
const rGrades = gradesFrom(loadCalls(join(outDir, "retry"), "grade"));
let retryDetail = "";
if (aCalls.length > 0 && rCalls.length > 0) {
  const base = descriptionsFrom(aCalls);
  const retried = descriptionsFrom(rCalls);
  const merged = new Map(base);
  const mergedGrades = new Map(aGrades);
  for (const [k, d] of retried) merged.set(k, d);
  for (const [k, g] of rGrades) mergedGrades.set(k, g);
  const summary = summarize(rows, merged, mergedGrades);
  reports.push({
    name: "A + Sonnet retry of 20 worst",
    summary,
    ...perFunction([...aCalls, ...rCalls], summary.described),
    calls: aCalls.length + rCalls.length,
    note: "Haiku batches plus 1 Sonnet call",
  });
  const before = summarize(rows, base, aGrades);
  const afterOnly = summarize(
    rows.filter((r) => retried.has(r.factSheet.contentKey)),
    retried,
    rGrades,
  );
  const beforeOnly = before.items.filter((i) => retried.has(i.key));
  const afterByKey = new Map(afterOnly.items.map((i) => [i.key, i]));
  let improved = 0;
  let same = 0;
  let worse = 0;
  for (const b of beforeOnly) {
    const a = afterByKey.get(b.key);
    const gb = b.grade ?? 0;
    const ga = a?.grade ?? 0;
    if (ga > gb) improved++;
    else if (ga === gb) same++;
    else worse++;
  }
  retryDetail = `Retry of ${beforeOnly.length} worst: mean grade ${fixed(mean(beforeOnly.map((i) => i.grade ?? 0)))} -> ${fixed(afterOnly.grades.mean)}; ${improved} improved, ${same} same, ${worse} worse; identifier pass ${pct(beforeOnly.filter((i) => i.identifierOk).length / (beforeOnly.length || 1))} -> ${pct(afterOnly.identifierPass)}; grade >= 1 ${pct(beforeOnly.filter((i) => (i.grade ?? 0) >= 1).length / (beforeOnly.length || 1))} -> ${pct(afterOnly.grades.acceptable)}.`;
}

// Path B: describer subagent (headless approximation or operator run), stored by pathb.ts as path-b/call-0.json.
const bCall = readJson<CallRecord & { functionsPerMinute?: number }>(join(outDir, "path-b", "call-0.json"));
const bGrades = gradesFrom(loadCalls(join(outDir, "path-b"), "grade"));
if (bCall) {
  const summary = summarize(rows, descriptionsFrom([bCall]), bGrades);
  reports.push({
    name: "B: describer subagent (headless approximation)",
    summary,
    ...perFunction([bCall], summary.described),
    calls: 1,
    note: bCall.functionsPerMinute ? `${fixed(bCall.functionsPerMinute, 1)} functions/min` : "",
  });
}

if (reports.length === 0) {
  console.log("No stored outputs found under evals/private/describe-out/. Run run.ts first.");
  process.exit(0);
}

const header = [
  "Path",
  "described",
  "schema pass",
  "length pass",
  "identifier pass",
  "mean grade",
  "% grade 2",
  "% grade >= 1",
  "nameFits flagged / precision / recall",
  "tokens in / fn",
  "tokens out / fn",
  "s / fn",
];
const table = mdTable(
  header,
  reports.map((r) => {
    const s = r.summary;
    const nf = s.nameFits;
    return [
      r.name,
      `${s.described}/${s.total}`,
      pct(s.schemaPass),
      pct(s.lengthPass),
      pct(s.identifierPass),
      s.grades.graded > 0 ? fixed(s.grades.mean) : "ungraded",
      s.grades.graded > 0 ? pct(s.grades.excellent) : "ungraded",
      s.grades.graded > 0 ? pct(s.grades.acceptable) : "ungraded",
      `${nf.predictedPositives} / ${pct(nf.precision)} / ${pct(nf.recall)}`,
      fixed(r.inPerFn, 0),
      fixed(r.outPerFn, 0),
      fixed(r.secPerFn, 2),
    ];
  }),
);
console.log(table);
console.log("");
const first = reports[0];
if (first) {
  const nf = first.summary.nameFits;
  console.log(
    `nameFits (positive = name misleads): labelled positives ${nf.labelledPositives}, predicted positives ${nf.predictedPositives}, true positives ${nf.truePositives}, agreement with labels ${pct(nf.agreement)}.`,
  );
}
if (retryDetail) console.log(retryDetail);

// Per-batch cost of path A (tokens are input incl. cache creation and cache reads).
if (aCalls.length > 0) {
  console.log("");
  console.log("Path A per batch:");
  console.log(
    mdTable(
      ["batch", "functions", "wall s", "tokens in", "tokens out", "cost USD"],
      aCalls.map((c, i) => [
        String(i),
        String(c.keys.length),
        fixed(c.wallMs / 1000, 1),
        String(c.usage ? totalInput(c.usage) : "n/a"),
        String(c.usage?.outputTokens ?? "n/a"),
        fixed(c.costUsd ?? null, 4),
      ]),
    ),
  );
  const a = reports[0]?.summary;
  if (a && aGrades.size > 0) {
    const byStratum = new Map<string, number[]>();
    for (const [i, r] of rows.entries()) {
      byStratum.set(r.stratum, [...(byStratum.get(r.stratum) ?? []), a.items[i]?.grade ?? 0]);
    }
    console.log("");
    console.log("Path A grade by stratum:");
    console.log(
      mdTable(
        ["stratum", "n", "mean grade", "% grade 2", "% grade >= 1"],
        [...byStratum.entries()].map(([s, gs]) => [
          s,
          String(gs.length),
          fixed(mean(gs)),
          pct(gs.filter((g) => g === 2).length / gs.length),
          pct(gs.filter((g) => g >= 1).length / gs.length),
        ]),
      ),
    );
    const counts = [0, 1, 2].map((g) => a.items.filter((i) => (i.grade ?? 0) === g).length);
    console.log("");
    console.log(`Path A grade counts: 0=${counts[0]}, 1=${counts[1]}, 2=${counts[2]}.`);
  }

  // gantry init --estimate style projection. DEVPRENTICE_FUNCTIONS is the number of non-trivial functions in the
  // sampling strata of the Devprentice test bed (pool sizes printed by evals/labelled/sample.ts), a lower bound on
  // what `gantry init --estimate` will report as needing a model.
  const fns = Number(process.env.DEVPRENTICE_FUNCTIONS ?? 2217);
  const a0 = reports[0];
  if (a0?.inPerFn != null && a0.outPerFn != null && a0.secPerFn != null) {
    const batches = Math.ceil(fns / 40);
    const rounds = Math.ceil(batches / 4);
    console.log("");
    console.log(`Projection for ${fns} functions (measured path A tokens and wall time per function):`);
    console.log(
      mdTable(
        ["measure", "value"],
        [
          ["input tokens (incl. cache)", String(Math.round(fns * a0.inPerFn))],
          ["output tokens", String(Math.round(fns * a0.outPerFn))],
          ["batches of 40", String(batches)],
          ["rounds of 4", String(rounds)],
          ["sequential headless wall time", `${fixed((fns * a0.secPerFn) / 60, 1)} min`],
          ["4 at a time, mean batch time per round", `${fixed((rounds * a0.secPerFn * 40) / 60, 1)} min`],
          [
            "4 at a time, slowest measured batch each round",
            `${fixed((rounds * Math.max(...aCalls.map((c) => c.wallMs))) / 60000, 1)} min`,
          ],
        ],
      ),
    );
  }
}

console.log("");
console.log("Targets (path A):");
if (first) {
  const s = first.summary;
  const ok = (b: boolean) => (b ? "met" : "missed");
  const graded = s.grades.graded > 0;
  console.log(
    `- grade >= 1 at least ${pct(TARGETS.acceptable, 0)}: ${graded ? `${pct(s.grades.acceptable)} ${ok(s.grades.acceptable >= TARGETS.acceptable)}` : "ungraded"}`,
  );
  console.log(
    `- schema pass at least ${pct(TARGETS.schema, 0)}: ${pct(s.schemaPass)} ${ok(s.schemaPass >= TARGETS.schema)}`,
  );
  const p = s.nameFits.precision;
  console.log(
    `- nameFits precision at least ${TARGETS.nameFitsPrecision}: ${
      p === null
        ? `undefined, no function was flagged as misleading (recall ${pct(s.nameFits.recall)} of ${s.nameFits.labelledPositives} labelled)`
        : `${fixed(p)} ${ok(p >= TARGETS.nameFitsPrecision)}`
    }`,
  );
}
