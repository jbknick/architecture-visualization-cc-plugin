// Prints Tables 1 to 3 and the summary numbers of the report from results.json, rerun.json and the committed recipes.
//   pnpm tsx docs/spikes/v2-recipe-agent/report.ts > tables.md
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
type Kind = "route" | "endpoint" | "table";
interface KS {
  labelled: number;
  predicted: number;
  matched: number;
  precision: number;
  recall: number;
  pass: boolean;
}
interface Run {
  run: number;
  status: string;
  failure?: string;
  model: string | null;
  turns: number | null;
  tokens: { input: number; cacheRead: number; cacheCreate: number; output: number } | null;
  costUsdReported: number | null;
  wallMs: number;
  recipeSha256: string | null;
  graphSha256: string | null;
  dryRuns: number;
  score: { kinds: Record<string, KS>; pass: boolean } | null;
}
interface Repo {
  name: string;
  sha: string;
  stack: string[];
  files: number;
  labels: Record<Kind, number>;
  kinds: string[];
  runs: Run[];
}
const results = JSON.parse(readFileSync(path.join(here, arg("--results") ?? "results.json"), "utf8")) as {
  jobs: number;
  repos: Repo[];
};
const pct = (x: number) => `${Math.round(x * 100)}`;
const letter: Record<Kind, string> = { route: "r", endpoint: "e", table: "t" };
const kindsOf = (r: Repo) => r.kinds.filter((k): k is Kind => k in letter);
const cell = (r: Repo, run: Run | undefined): string => {
  if (!run) return "no run";
  if (!run.score) return "failed";
  return kindsOf(r)
    .map((k) => {
      const s = run.score?.kinds[k];
      return s ? `${letter[k]} ${pct(s.recall)}/${pct(s.precision)}` : `${letter[k]} n/a`;
    })
    .join(", ");
};
const worst = (r: Repo): string => {
  const parts = kindsOf(r).map((k) => {
    const ss = r.runs.map((x) => x.score?.kinds[k]).filter((s): s is KS => Boolean(s));
    const rec = Math.min(...ss.map((s) => s.recall), 1);
    const pre = Math.min(...ss.map((s) => s.precision), 1);
    return `${letter[k]} ${pct(rec)}/${pct(pre)}`;
  });
  return parts.join(", ");
};
const repoPass = (r: Repo) => r.runs.length === 3 && r.runs.every((x) => x.score?.pass === true);
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const inTokens = (x: Run) => (x.tokens ? x.tokens.input + x.tokens.cacheRead + x.tokens.cacheCreate : 0);
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

console.log(
  "### Table 1: scores per repo (recall/precision in percent per kind: r routes, e endpoints, t tables)\n",
);
console.log(
  "| Repo@sha7 | Stack | Files | Labels r/e/t | Run 1 | Run 2 | Run 3 | Worst of 3 | Pass | Turns | Tokens in / out | Wall |",
);
console.log("| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of results.repos) {
  const rs = [1, 2, 3].map((k) => r.runs.find((x) => x.run === k));
  const turns = rs.map((x) => x?.turns ?? "-").join(" / ");
  const tin = rs.map((x) => (x ? fmtTok(inTokens(x)) : "-")).join(" / ");
  const tout = rs.map((x) => (x?.tokens ? fmtTok(x.tokens.output) : "-")).join(" / ");
  const wall = rs.map((x) => (x ? secs(x.wallMs) : "-")).join(" / ");
  console.log(
    `| ${r.name}@${r.sha.slice(0, 7)} | ${r.stack.join(", ")} | ${r.files} | ${r.labels.route}/${r.labels.endpoint}/${r.labels.table} | ${cell(r, rs[0])} | ${cell(r, rs[1])} | ${cell(r, rs[2])} | ${worst(r)} | ${repoPass(r) ? "yes" : "no"} | ${turns} | ${tin} in; ${tout} out | ${wall} |`,
  );
}
const passN = results.repos.filter(repoPass).length;
console.log(`\nRepos passing on the worst of 3 runs: ${passN} of ${results.repos.length}.`);
const all = results.repos.flatMap((r) => r.runs);
const sum = (f: (x: Run) => number) => all.reduce((a, x) => a + f(x), 0);
console.log(
  `Runs: ${all.length}; failed runs (no accepted recipe or error): ${all.filter((x) => x.status === "failed").length}; turns ${sum((x) => x.turns ?? 0)}; input tokens ${sum(inTokens)} (of which cache reads ${sum((x) => x.tokens?.cacheRead ?? 0)}); output tokens ${sum((x) => x.tokens?.output ?? 0)}; wall ${Math.round(sum((x) => x.wallMs) / 1000)} s summed (concurrency ${results.jobs}); models: ${[...new Set(all.map((x) => x.model))].join(", ")}.`,
);

// ---- Table 2 ----
interface RecipeJson {
  helpers?: string[];
  rules?: { id: string; language: string; rule: unknown; constraints?: unknown; emit?: unknown }[];
}
const load = (name: string, k: number): RecipeJson | null => {
  const f = path.join(here, arg("--runs-dir") ?? "runs", name, `run${k}`, "recipe.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as RecipeJson) : null;
};
console.log("\n### Table 2: stability per repo\n");
console.log("| Repo | Recipes identical | Graphs identical | What differed |");
console.log("| --- | --- | --- | --- |");
for (const r of results.repos) {
  const recs = [1, 2, 3].map((k) => load(r.name, k));
  const shas = r.runs.map((x) => x.recipeSha256);
  const gshas = r.runs.map((x) => x.graphSha256);
  const same = (xs: (string | null)[]) => xs.length === 3 && xs.every((x) => x !== null && x === xs[0]);
  const diffs: string[] = [];
  const ids = recs.map((x) =>
    (x?.rules ?? [])
      .map((q) => q.id)
      .sort()
      .join(","),
  );
  if (new Set(ids).size > 1)
    diffs.push(`rule ids (${recs.map((x) => x?.rules?.length ?? 0).join("/")} rules)`);
  const hs = recs.map((x) => [...(x?.helpers ?? [])].sort().join(","));
  if (new Set(hs).size > 1) diffs.push("helpers");
  const pats = recs.map((x) =>
    JSON.stringify((x?.rules ?? []).map((q) => [q.language, q.rule, q.constraints, q.emit]).sort()),
  );
  if (new Set(pats).size > 1) diffs.push("patterns or emits");
  const counts = r.runs.map((x) => x.score?.kinds);
  const nodeCounts = r.runs
    .map((x) =>
      kindsOf(r)
        .map((k) => x.score?.kinds[k]?.predicted ?? 0)
        .join("+"),
    )
    .join(" / ");
  console.log(
    `| ${r.name} | ${same(shas) ? "yes" : "no"} | ${same(gshas) ? "yes" : "no"} | ${diffs.length ? diffs.join("; ") : same(shas) ? "nothing" : "formatting or example text only"}; predicted nodes per run ${nodeCounts} |`,
  );
  void counts;
}
const idRecipes = results.repos.filter(
  (r) => r.runs.length === 3 && new Set(r.runs.map((x) => x.recipeSha256)).size === 1,
).length;
const idGraphs = results.repos.filter(
  (r) => r.runs.length === 3 && new Set(r.runs.map((x) => x.graphSha256)).size === 1,
).length;
console.log(
  `\nRepos with three identical recipe files: ${idRecipes} of ${results.repos.length}. Repos with three identical graphs: ${idGraphs} of ${results.repos.length}.`,
);

// ---- Table 3 ----
const rf = path.join(here, "rerun.json");
if (existsSync(rf)) {
  const rr = JSON.parse(readFileSync(rf, "utf8")) as { reps: Record<string, unknown>[] };
  console.log("\n### Table 3: on-request re-run on a copy of `fixtures/pnpm-turbo`\n");
  console.log(
    "| Rep | Nodes before | Added | Lost | New found / expected | Gaps given (dep / route-site / sql-site) | Gaps left (dep / route-site / sql-site) | Notes |",
  );
  console.log("| --- | ---: | ---: | ---: | --- | --- | --- | --- |");
  const g = (x: unknown) => {
    const o = x as
      | { total: number; dependency: number; "route-site": number; "sql-site": number }
      | undefined;
    return o ? `${o.total} (${o.dependency} / ${o["route-site"]} / ${o["sql-site"]})` : "-";
  };
  for (const x of rr.reps) {
    console.log(
      `| ${x.rep} | ${x.nodesBefore ?? "-"} | ${x.added ?? "-"} | ${x.lost ?? "-"} | ${x.newFound ?? "-"} / ${x.newExpected ?? "-"} | ${g(x.gapsGiven)} | ${g(x.gapsLeft)} | ${x.failed ?? ((x.lostKeys as string[] | undefined)?.length ? `lost: ${(x.lostKeys as string[]).join("; ")}` : "")} |`,
    );
  }
}
