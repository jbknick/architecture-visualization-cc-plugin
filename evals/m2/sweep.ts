/**
 * Threshold sweep (issue #32, step 3) over the private replay candidates, the Sonnet labels and the seeded results.
 * nearJaccard 0.80..0.90 and codeVector 0.91..1.00 in 0.01 steps (at the configured nearTokenJaccard), nearTokenJaccard
 * 0.50..0.95 on its own, semantic 0.55..0.65 on its own (the hook and find_similar never apply it to a draft: it only
 * gates the description-to-description tier). Candidates and imports the double-check dropped (`verified: false`,
 * #131) are never shown. A replay from before #131 has no token scores or verdicts: they pass. Prints aggregates only.
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
  /** Shape and token MinHash Jaccard (#131); absent in a replay from before it. */
  shapeScore?: number | null;
  tokenScore?: number | null;
  sameShape: boolean;
  inline: boolean;
  /** The double-check against disk kept it (#131). */
  verified?: boolean;
}
export interface Edit {
  commit: string;
  status: string;
  path: string;
  changed: number;
  shipped: string | null;
  hookMs: number;
  cands: Cand[];
  imports: { line: number; action: string; verified?: boolean }[];
}
export interface Thresholds {
  nearJaccard: number;
  codeVector: number;
  nearTokenJaccard?: number;
  codeVectorTokenJaccard?: number;
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
  const nearOk = (c: Cand): boolean =>
    (c.sameShape || (c.shapeScore ?? c.score) >= t.nearJaccard) &&
    (c.tokenScore === undefined || c.tokenScore === null || c.tokenScore >= (t.nearTokenJaccard ?? 0));
  const passes = (c: Cand): boolean =>
    c.verified !== false &&
    (c.tier === "exact" ||
      (c.tier === "near" && nearOk(c)) ||
      (c.tier === "code_vector" &&
        c.score >= t.codeVector &&
        (c.tokenScore === undefined ||
          c.tokenScore === null ||
          c.tokenScore >= (t.codeVectorTokenJaccard ?? 0))));
  const bySym = new Map<string, Cand[]>();
  for (const c of e.cands.filter(passes)) bySym.set(c.sym, [...(bySym.get(c.sym) ?? []), c]);
  const keys: string[] = [];
  for (const list of bySym.values()) {
    list.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score);
    const top = list.slice(0, 2);
    const shown = top.some((c) => c.inline) ? top.filter((c) => c.inline) : top;
    for (const c of shown) keys.push(dupKey(e, c));
  }
  for (const i of e.imports) if (i.verified !== false) keys.push(importKey(e, i));
  return keys;
}

export interface Point {
  nearJaccard: number;
  codeVector: number;
  nearTokenJaccard?: number;
  codeVectorTokenJaccard?: number;
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

/** The token gates of #131; a replay from before them has no token scores, so they do not change its numbers. */
export type TokenGates = Pick<Thresholds, "nearTokenJaccard" | "codeVectorTokenJaccard">;

export function runSweep(gates: TokenGates = {}): {
  rows: (Point & ReturnType<typeof seededRecall>)[];
  tokens: Point[];
  cvTokens: Point[];
  semantic: { t: number; recall: number; falseHits: number }[];
} {
  const edits = loadEdits();
  const labels = readPrivate<Labels>("labels.json");
  const seeded = readPrivate<SeededResult[]>("seeded-results.json");
  const rows = [];
  for (const nj of range(0.8, 0.9)) {
    for (const cv of range(0.91, 1.0)) {
      const t = { nearJaccard: nj, codeVector: cv, ...gates };
      rows.push({ ...measure(edits, labels, t), ...seededRecall(seeded, t) });
    }
  }
  const semantic = range(0.55, 0.65).map((t) => ({
    t,
    recall: seeded.filter((r) => (r.queryDescCosine ?? 0) >= t).length,
    falseHits: seeded.filter((r) => (r.queryBestOtherCosine ?? 0) >= t).length,
  }));
  const steps = [0, 0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
  const base = { nearJaccard: 0.85, codeVector: 0.98, ...gates };
  const tokens = steps.map((x) => measure(edits, labels, { ...base, nearTokenJaccard: x }));
  const cvTokens = steps.map((x) => measure(edits, labels, { ...base, codeVectorTokenJaccard: x }));
  return { rows, tokens, cvTokens, semantic };
}

if (process.argv[1]?.endsWith("sweep.ts")) {
  const gates = { nearTokenJaccard: 0.75, codeVectorTokenJaccard: 0.5 };
  const { rows, tokens, cvTokens, semantic } = runSweep(gates);
  const meets = rows.filter((r) => r.alertRate < 0.05 && r.falseRate < 0.1 && r.unlabelled === 0);
  const gateTable = (name: string, key: keyof TokenGates, ps: Point[]): string =>
    `${name} at nearJaccard 0.85, codeVector 0.98 (the other gate at its default):\n${table(
      [name, "alerts", "edits alerting", "alert rate", "false", "false rate"],
      ps.map((p) => [
        p[key] ?? 0,
        p.alerts,
        p.editsAlerting,
        pct(p.editsAlerting, p.edits),
        p.falseAlerts,
        pct(p.falseAlerts, p.alerts),
      ]),
    )}`;
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
    )}\n\n${gateTable("nearTokenJaccard", "nearTokenJaccard", tokens)}\n\n${gateTable(
      "codeVectorTokenJaccard",
      "codeVectorTokenJaccard",
      cvTokens,
    )}\n\nsettings meeting both budgets: ${meets.length} of ${rows.length}\n\n${table(
      ["semantic", "seeded queries at/above", "queries whose best other description is at/above"],
      semantic.map((s) => [s.t, s.recall, s.falseHits]),
    )}\n`,
  );
}
