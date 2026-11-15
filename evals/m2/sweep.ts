/**
 * Threshold sweep (issue #32, step 3) over the private replay candidates, the Sonnet labels and the seeded results.
 * nearJaccard 0.80..0.90 and codeVector 0.91..1.00 in 0.01 steps; semantic 0.55..0.65 on its own (the hook and
 * find_similar never apply it to a draft: it only gates the description-to-description tier). Prints aggregates only.
 *
 * Usage: GANTRY_PRIVATE_DIR=... pnpm tsx evals/m2/sweep.ts [--json]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIER_RANK } from "../../packages/core/src/dup/engine.js";
import { pct, privateDir, readPrivate, table } from "./lib.js";
import type { SeededResult } from "./seeded-report.js";

export interface Cand {
  sym: string;
  name: string;
  line: number;
  stmt: number;
  match: string;
  tier: "exact" | "near" | "code_vector";
  score: number;
  sameShape: boolean;
  inline: boolean;
}
export interface Edit {
  commit: string;
  status: string;
  path: string;
  changed: number;
  shipped: string | null;
  hookMs: number;
  cands: Cand[];
  imports: { line: number; action: string }[];
}
export interface Thresholds {
  nearJaccard: number;
  codeVector: number;
}
export type Labels = Record<string, boolean>;

export const dupKey = (e: Edit, c: Cand): string => `${e.commit}|${e.path}|${c.sym}|${c.match}`;
export const importKey = (e: Edit, i: { line: number; action: string }): string =>
  `${e.commit}|${e.path}|import|${i.line}|${i.action}`;

export function loadEdits(): Edit[] {
  return readFileSync(join(privateDir(), "replay.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Edit);
}

/** The findings the hook would print for one edit at `t` (limit 2 per symbol, inline-only when any is inline). */
export function findingsFor(e: Edit, t: Thresholds): string[] {
  const passes = (c: Cand): boolean =>
    c.tier === "exact" ||
    (c.tier === "near" && (c.sameShape || c.score >= t.nearJaccard)) ||
    (c.tier === "code_vector" && c.score >= t.codeVector);
  const bySym = new Map<string, Cand[]>();
  for (const c of e.cands.filter(passes)) bySym.set(c.sym, [...(bySym.get(c.sym) ?? []), c]);
  const keys: string[] = [];
  for (const list of bySym.values()) {
    list.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score);
    const top = list.slice(0, 2);
    const shown = top.some((c) => c.inline) ? top.filter((c) => c.inline) : top;
    for (const c of shown) keys.push(dupKey(e, c));
  }
  for (const i of e.imports) keys.push(importKey(e, i));
  return keys;
}

export interface Point {
  nearJaccard: number;
  codeVector: number;
  edits: number;
  alerts: number;
  editsAlerting: number;
  falseAlerts: number;
  unlabelled: number;
  alertRate: number;
  falseRate: number;
}
export function measure(edits: Edit[], labels: Labels, t: Thresholds): Point {
  let alerts = 0;
  let editsAlerting = 0;
  let falseAlerts = 0;
  let unlabelled = 0;
  for (const e of edits) {
    const ks = findingsFor(e, t);
    if (ks.length > 0) editsAlerting++;
    alerts += ks.length;
    for (const k of ks) {
      const l = labels[k];
      if (l === undefined) unlabelled++;
      else if (!l) falseAlerts++;
    }
  }
  return {
    ...t,
    edits: edits.length,
    alerts,
    editsAlerting,
    falseAlerts,
    unlabelled,
    alertRate: edits.length === 0 ? 0 : editsAlerting / edits.length,
    falseRate: alerts === 0 ? 0 : falseAlerts / alerts,
  };
}

/** Seeded cases found at the thresholds: `product` = what the shipped tools can do, `withDraftVector` adds the draft's code cosine. */
export function seededRecall(
  rs: SeededResult[],
  t: Thresholds,
): { product: number; withDraftVector: number; misleadingProduct: number; misleadingWithDraft: number } {
  const hookOrCode = (r: SeededResult): boolean => {
    const ok = (f: { found: boolean; tier: string | null; score: number | null }): boolean =>
      f.found && (f.tier !== "near" || (f.score ?? 0) >= t.nearJaccard || f.score === 1);
    return ok(r.hook) || ok(r.code);
  };
  const prod = (r: SeededResult): boolean =>
    (hookOrCode(r) || r.query.found) && r.situation === r.expectedSituation;
  const draft = (r: SeededResult): boolean =>
    (prod(r) || (r.draftCodeCosine !== null && r.draftCodeCosine >= t.codeVector)) &&
    r.situation === r.expectedSituation;
  const mis = rs.filter((r) => r.misleading);
  return {
    product: rs.filter(prod).length,
    withDraftVector: rs.filter(draft).length,
    misleadingProduct: mis.filter(prod).length,
    misleadingWithDraft: mis.filter(draft).length,
  };
}

const range = (from: number, to: number, step = 0.01): number[] => {
  const out: number[] = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 100) / 100);
  return out;
};

export function runSweep(): {
  rows: (Point & ReturnType<typeof seededRecall>)[];
  semantic: { t: number; recall: number; falseHits: number }[];
} {
  const edits = loadEdits();
  const labels = readPrivate<Labels>("labels.json");
  const seeded = readPrivate<SeededResult[]>("seeded-results.json");
  const rows = [];
  for (const nj of range(0.8, 0.9)) {
    for (const cv of range(0.91, 1.0)) {
      const t = { nearJaccard: nj, codeVector: cv };
      rows.push({ ...measure(edits, labels, t), ...seededRecall(seeded, t) });
    }
  }
  const semantic = range(0.55, 0.65).map((t) => ({
    t,
    recall: seeded.filter((r) => (r.queryDescCosine ?? 0) >= t).length,
    falseHits: seeded.filter((r) => (r.queryBestOtherCosine ?? 0) >= t).length,
  }));
  return { rows, semantic };
}

if (process.argv[1]?.endsWith("sweep.ts")) {
  const { rows, semantic } = runSweep();
  const meets = rows.filter((r) => r.alertRate < 0.05 && r.falseRate < 0.1 && r.unlabelled === 0);
  process.stdout.write(
    `${table(
      [
        "nearJaccard",
        "codeVector",
        "alerts",
        "edits alerting",
        "alert rate",
        "false",
        "false rate",
        "seeded (product)",
        "seeded (+draft vec)",
      ],
      rows
        .filter((r) => r.nearJaccard === 0.85 || r.codeVector === 0.96)
        .map((r) => [
          r.nearJaccard,
          r.codeVector,
          r.alerts,
          r.editsAlerting,
          pct(r.editsAlerting, r.edits),
          r.falseAlerts,
          pct(r.falseAlerts, r.alerts),
          r.product,
          r.withDraftVector,
        ]),
    )}\n\nChosen codeVector against the current one, at nearJaccard 0.85:\n${table(
      ["variant", "alerts", "edits alerting", "alert rate", "false", "false rate"],
      [
        ["codeVector 0.96 (current)", { nearJaccard: 0.85, codeVector: 0.96 }],
        ["codeVector 0.99", { nearJaccard: 0.85, codeVector: 0.99 }],
      ].map(([name, t]) => {
        const p = measure(loadEdits(), readPrivate<Labels>("labels.json"), t as Thresholds);
        return [
          name as string,
          p.alerts,
          p.editsAlerting,
          pct(p.editsAlerting, p.edits),
          p.falseAlerts,
          pct(p.falseAlerts, p.alerts),
        ];
      }),
    )}\n\nsettings meeting both budgets: ${meets.length} of ${rows.length}\n\n${table(
      ["semantic", "seeded queries at/above", "queries whose best other description is at/above"],
      semantic.map((s) => [s.t, s.recall, s.falseHits]),
    )}\n`,
  );
}
