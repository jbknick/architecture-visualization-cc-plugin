// Scoring of the plan-estimates spike (#304): deterministic over a committed run file.
//   pnpm tsx docs/spikes/plan-estimates/score.ts docs/spikes/plan-estimates/runs/full.json
// Actual set = the indexable files the pull request changed (`reviewDiff(base, merge)`, read from the history
// clone). Estimated set = the files of the area's nodes (a `dir:` or `ws:` node counts all its files).
// Per PR: recall = |est and actual| / |actual|, precision = |est and actual| / |est| (0 for an empty area).
// Prints one JSON object: per repo and overall, the medians, P25 and P75 of recall and precision, the empty
// estimates, the radius ratio (estimated hop-1 consumers of the area over the actual hop-1 consumers of the
// changed symbols; no bar), and, from the run's meta file, the model ids, the cost and the description coverage.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { actualFiles, areaFiles } from "./area.js";
import { corpusRepos, loadPrs, median, type Pr, prKey, quantile, readJson, round4, stable } from "./lib.js";

interface RunFile {
  runs: { key: string; area: { id: string; confidence: number }[] }[];
}
interface Meta {
  runs: {
    key: string;
    status: string;
    model: string | null;
    turns: number | null;
    tokens: { input: number; cacheCreate: number; cacheRead: number; output: number } | null;
    wallMs: number;
    radius: { estimated: number; actual: number } | null;
  }[];
  prs: {
    key: string;
    coverage: { functionLike: number; model: number; template: number; fallback: number } | null;
  }[];
}

const stats = (xs: number[]) => ({
  n: xs.length,
  median: round4(median(xs)),
  p25: round4(quantile(xs, 0.25)),
  p75: round4(quantile(xs, 0.75)),
  min: round4(xs.length ? Math.min(...xs) : Number.NaN),
});

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: score.ts <run file>");
  const run = readJson<RunFile>(resolve(file));
  const metaPath = resolve(file).replace(/\.json$/, ".meta.json");
  const meta = existsSync(metaPath) ? readJson<Meta>(metaPath) : null;
  const prs = new Map<string, Pr>(loadPrs().map((p) => [prKey(p), p]));
  const slugs = new Map(corpusRepos().map((r) => [r.name, r.slug]));

  const rows: {
    key: string;
    repo: string;
    actual: number;
    estimated: number;
    recall: number;
    precision: number;
  }[] = [];
  for (const r of [...run.runs].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const pr = prs.get(r.key);
    if (!pr) throw new Error(`${r.key} is not in prs.json`);
    const { files: actual } = await actualFiles(pr, slugs.get(pr.repo) as string);
    const est = areaFiles(pr.repo, pr.base, r.area);
    let hit = 0;
    for (const f of est) if (actual.has(f)) hit++;
    rows.push({
      key: r.key,
      repo: pr.repo,
      actual: actual.size,
      estimated: est.size,
      recall: actual.size === 0 ? 0 : round4(hit / actual.size),
      precision: est.size === 0 ? 0 : round4(hit / est.size),
    });
  }

  const radiusOf = (repo?: string) =>
    (meta?.runs ?? [])
      .filter((m) => m.radius && m.radius.actual > 0 && (!repo || m.key.startsWith(`${repo}#`)))
      .map((m) => round4((m.radius?.estimated as number) / (m.radius?.actual as number)));
  const coverageOf = (repo?: string) =>
    (meta?.prs ?? [])
      .filter((p) => p.coverage && p.coverage.functionLike > 0 && (!repo || p.key.startsWith(`${repo}#`)))
      .map((p) => {
        const c = p.coverage as NonNullable<typeof p.coverage>;
        return { any: (c.model + c.template + c.fallback) / c.functionLike, model: c.model / c.functionLike };
      });

  const group = (repo?: string) => {
    const rs = rows.filter((r) => !repo || r.repo === repo);
    const cov = coverageOf(repo);
    return {
      prs: rs.length,
      recall: stats(rs.map((r) => r.recall)),
      precision: stats(rs.map((r) => r.precision)),
      empty: rs.filter((r) => r.estimated === 0).length,
      radiusRatio: stats(radiusOf(repo)),
      coverageAny: stats(cov.map((c) => c.any)),
      coverageModel: stats(cov.map((c) => c.model)),
    };
  };
  const sum = (f: (m: Meta["runs"][number]) => number) => (meta?.runs ?? []).reduce((a, m) => a + f(m), 0);
  const out = {
    run: basename(file, ".json"),
    models: [...new Set((meta?.runs ?? []).map((m) => m.model))].sort(),
    overall: group(),
    byRepo: Object.fromEntries([...new Set(rows.map((r) => r.repo))].sort().map((r) => [r, group(r)])),
    cost: meta
      ? {
          calls: meta.runs.length,
          failed: meta.runs.filter((m) => m.status !== "ok").length,
          turns: sum((m) => m.turns ?? 0),
          inputTokens: sum((m) => m.tokens?.input ?? 0),
          cacheCreateTokens: sum((m) => m.tokens?.cacheCreate ?? 0),
          cacheReadTokens: sum((m) => m.tokens?.cacheRead ?? 0),
          outputTokens: sum((m) => m.tokens?.output ?? 0),
          wallSeconds: round4(sum((m) => m.wallMs) / 1000),
        }
      : null,
    perPr: rows,
  };
  process.stdout.write(stable(out));
}

await main();
