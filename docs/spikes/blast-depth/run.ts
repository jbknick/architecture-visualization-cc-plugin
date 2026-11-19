/**
 * Blast-depth spike. Usage (from the repo root, after `pnpm build && pnpm eval:clone`):
 *   pnpm exec tsx docs/spikes/blast-depth/run.ts --corpus            pick the PRs (needs `gh`), write prs.json
 *   pnpm exec tsx docs/spikes/blast-depth/run.ts --radius            walk every PR's radius (slow; cached in the work dir)
 *   pnpm exec tsx docs/spikes/blast-depth/run.ts --followups         write followups.json from the cached radii
 *   pnpm exec tsx docs/spikes/blast-depth/run.ts --results           write results.json from the cached radii
 *   pnpm exec tsx docs/spikes/blast-depth/run.ts --check             recompute every radius, exit 0 only if results.json matches
 *   pnpm exec tsx docs/spikes/blast-depth/run.ts --report            print the report tables computed from results.json
 *   pnpm exec tsx docs/spikes/blast-depth/run.ts --time <repo> [--cap N]   walk time on a repo (rows for the table)
 * The work dir (BLAST_WORK, default <tmpdir>/gantry-blast-depth) holds this spike's own copies of the pinned clones
 * (the shared clones in GANTRY_OSS_DIR are never touched), the worktrees, fresh data dirs and the caches.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isSymId, pathOfSymId } from "../../../packages/core/src/ids.js";
import { resolvePaths } from "../../../packages/core/src/paths/index.js";
import { CONSUMER_KINDS } from "../../../packages/core/src/review/consumers.js";
import { reviewDiff, type SymbolChange } from "../../../packages/core/src/review/diff.js";
import { openStore } from "../../../packages/core/src/store/index.js";
import { type Repo, readRepos, targetDir } from "../../../scripts/eval-lib.js";
import { loadConsumerMap, visibleFrom, walkBatched, walkRadius } from "./walk.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const CLI = join(repoRoot, "plugin/dist/cli.js");
const WORK = process.env.BLAST_WORK || join(tmpdir(), "gantry-blast-depth");
const PRS_PER_REPO = 35;
const GH_LIMIT = 300;
const FIX_WINDOW_MS = 30 * 24 * 3600 * 1000;
const POOL = 3;
/** The corpus repos in the order of the corpus table. */
const CORPUS_REPOS = ["cal.com", "formbricks"];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 29,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => cmp(a, b))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
}
const stringify = (v: unknown): string => `${JSON.stringify(sortKeys(v), null, 2)}\n`;
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

interface PrEntry {
  repo: string;
  number: number;
  base: string;
  merge: string;
  files: string[];
}
interface Followup {
  repo: string;
  pr: number;
  fix: number;
  editedConsumers: string[];
}
interface GhPr {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  mergeCommit: { oid: string } | null;
  files: { path: string }[];
}
/** One node of a radius, as cached and ranked. */
interface RNode {
  id: string;
  hop: number;
  high: boolean;
  fanIn: number;
  v: number;
  workspace: string | null;
  path: string;
  name: string;
}
interface Radius {
  repo: string;
  number: number;
  seeds: number;
  nodes: RNode[];
  failed?: string;
}

const prsPath = join(here, "prs.json");
const followupsPath = join(here, "followups.json");
const resultsPath = join(here, "results.json");
const repoByName = (name: string): Repo => {
  const r = readRepos().find((x) => x.name === name);
  if (!r) throw new Error(`${name} is not in evals/oss/repos.json`);
  return r;
};

// ---- the work dir's own copy of a pinned clone ----

function ensureCopy(r: Repo): string {
  const dir = join(WORK, "repos", r.name);
  if (!existsSync(dir)) {
    mkdirSync(join(WORK, "repos"), { recursive: true });
    const src = targetDir(r);
    if (!existsSync(src)) throw new Error(`${src} is missing; run pnpm eval:clone first`);
    execFileSync("git", ["clone", "-q", "--no-checkout", src, dir], { stdio: "ignore" });
  }
  // The repo part of every id comes from origin, so it must be the pinned URL (not the shared clone's path).
  sh(dir, "remote", "set-url", "origin", r.url);
  if (sh(dir, "rev-parse", "--is-shallow-repository") === "true")
    sh(dir, "fetch", "-q", "--unshallow", "origin");
  if (sh(dir, "rev-parse", "HEAD^{commit}") === "" || sh(dir, "cat-file", "-t", r.sha) !== "commit")
    throw new Error(`${r.name}: pinned ${r.sha} is not in the copy`);
  return dir;
}

// ---- corpus ----

const TEST_RE =
  /(^|\/)(__tests__|__mocks__|tests?|e2e|playwright|cypress)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/;
const isSourceTs = (p: string): boolean =>
  /\.tsx?$/.test(p) && !p.endsWith(".d.ts") && !TEST_RE.test(p) && !p.includes("node_modules/");

const gh = (...args: string[]): string => {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("gh", args, {
        encoding: "utf8",
        maxBuffer: 1 << 29,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
};

/**
 * The GH_LIMIT merged PRs `gh pr list --state merged --limit 300` names, each read in full with `gh pr view`
 * (one `pr list` request that also asks for files and bodies is too large for the GraphQL API).
 */
function fetchMerged(slug: string): GhPr[] {
  const numbers = (
    JSON.parse(
      gh("pr", "list", "-R", slug, "--state", "merged", "--limit", String(GH_LIMIT), "--json", "number"),
    ) as { number: number }[]
  ).map((p) => p.number);
  const fields = "number,title,body,mergeCommit,mergedAt,files";
  return numbers
    .sort((a, b) => a - b)
    .map((n) => JSON.parse(gh("pr", "view", String(n), "-R", slug, "--json", fields)) as GhPr);
}

function corpus(): void {
  const out: PrEntry[] = [];
  for (const name of CORPUS_REPOS) {
    const r = repoByName(name);
    const dir = ensureCopy(r);
    const slug = r.url.replace("https://github.com/", "").replace(/\.git$/, "");
    const rawPath = join(WORK, `gh-${name}.json`);
    if (!existsSync(rawPath)) writeFileSync(rawPath, JSON.stringify(fetchMerged(slug)));
    const all = readJson<GhPr[]>(rawPath).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
    const ok: PrEntry[] = [];
    let skipped = 0;
    for (const p of all) {
      const merge = p.mergeCommit?.oid;
      const files = p.files
        .map((f) => f.path)
        .filter(isSourceTs)
        .sort(cmp);
      if (!merge || files.length === 0) continue;
      try {
        sh(dir, "merge-base", "--is-ancestor", merge, r.sha);
        const base = sh(dir, "rev-parse", `${merge}^1`);
        // A rebase-merged PR has no commit holding all of it: require the diff to name the same source files.
        const diff = sh(dir, "diff", "--name-only", base, merge).split("\n").filter(isSourceTs).sort(cmp);
        if (p.files.length < 100 && diff.join("\n") !== files.join("\n")) {
          skipped++;
          continue;
        }
        ok.push({ repo: name, number: p.number, base, merge, files });
      } catch {
        skipped++;
      }
    }
    const picked = Array.from(
      { length: Math.min(PRS_PER_REPO, ok.length) },
      (_, i) => ok[Math.floor((i * ok.length) / PRS_PER_REPO)] as PrEntry,
    );
    console.log(
      `${name}: ${all.length} merged listed, ${ok.length} qualify (${skipped} skipped), ${picked.length} picked`,
    );
    out.push(...picked);
  }
  out.sort((a, b) => cmp(a.repo, b.repo) || a.number - b.number);
  writeFileSync(prsPath, stringify(out));
}

// ---- radius of one PR ----

function runInit(cwd: string, data: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("node", [CLI, "init"], {
      cwd,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`init exited ${code}: ${err.slice(-200)}`)),
    );
  });
}

async function radiusOf(pr: PrEntry): Promise<Radius> {
  const r = repoByName(pr.repo);
  const copy = ensureCopy(r);
  const wt = join(WORK, "wt", `${pr.repo}-${pr.number}`);
  const data = join(WORK, "data", `${pr.repo}-${pr.number}`);
  rmSync(wt, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  mkdirSync(join(WORK, "wt"), { recursive: true });
  try {
    sh(copy, "worktree", "prune");
    sh(copy, "worktree", "add", "-q", "--detach", wt, pr.base);
    await runInit(wt, data);
    const paths = resolvePaths(wt, { ...process.env, CLAUDE_PLUGIN_DATA: data });
    const diff = await reviewDiff(paths, pr.base, pr.merge);
    const store = openStore(paths.dbPath);
    try {
      const seeds = diff.changes.filter((c: SymbolChange) => c.kind !== "added");
      const { nodes, graph } = walkRadius(store, diff.changes);
      const v = visibleFrom(nodes);
      const list: RNode[] = [...nodes.values()]
        .map((n) => {
          const info = graph.info(n.id);
          return {
            id: n.id,
            hop: n.hop,
            high: n.high,
            fanIn: n.fanIn,
            v: v.get(n.id) ?? Number.POSITIVE_INFINITY,
            workspace: info.workspace,
            path: info.path,
            name: info.name,
          };
        })
        .sort((a, b) => a.hop - b.hop || cmp(a.id, b.id));
      return { repo: pr.repo, number: pr.number, seeds: seeds.length, nodes: list };
    } finally {
      store.close();
    }
  } catch (e) {
    return {
      repo: pr.repo,
      number: pr.number,
      seeds: 0,
      nodes: [],
      failed:
        String((e as Error).message)
          .split("\n")[0]
          ?.slice(0, 160) ?? "failed",
    };
  } finally {
    try {
      sh(copy, "worktree", "remove", "--force", wt);
    } catch {
      rmSync(wt, { recursive: true, force: true });
    }
    rmSync(data, { recursive: true, force: true });
  }
}

const cachePath = (pr: { repo: string; number: number }): string =>
  join(WORK, "radius", `${pr.repo}-${pr.number}.json`);

async function radiusAll(useCache: boolean): Promise<Radius[]> {
  const prs = readJson<PrEntry[]>(prsPath);
  mkdirSync(join(WORK, "radius"), { recursive: true });
  const out = new Map<string, Radius>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const pr = prs[next++];
      if (!pr) return;
      const cp = cachePath(pr);
      let rad: Radius;
      if (useCache && existsSync(cp)) rad = readJson<Radius>(cp);
      else {
        const t0 = performance.now();
        rad = await radiusOf(pr);
        if (useCache) writeFileSync(cp, JSON.stringify(rad));
        console.log(
          `${pr.repo}#${pr.number}: ${rad.failed ? `FAILED ${rad.failed}` : `${rad.nodes.length} nodes`} (${Math.round((performance.now() - t0) / 1000)} s)`,
        );
      }
      out.set(`${pr.repo}#${pr.number}`, rad);
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));
  return prs.map((p) => out.get(`${p.repo}#${p.number}`) as Radius);
}

// ---- follow-up fixes ----

function followups(radii: Radius[]): Followup[] {
  const out: Followup[] = [];
  for (const name of CORPUS_REPOS) {
    const raw = readJson<GhPr[]>(join(WORK, `gh-${name}.json`));
    const when = new Map(raw.map((p) => [p.number, Date.parse(p.mergedAt)]));
    for (const rad of radii.filter((x) => x.repo === name && !x.failed && x.nodes.length > 0)) {
      const t = when.get(rad.number) as number;
      const mention = new RegExp(`(^|[^\\w/])#${rad.number}(?!\\d)`);
      for (const f of raw) {
        const ft = Date.parse(f.mergedAt);
        if (f.number === rad.number || !(ft > t && ft - t <= FIX_WINDOW_MS)) continue;
        if (!/^fix/i.test(f.title) && !mention.test(f.body ?? "")) continue;
        const files = new Set(f.files.map((x) => x.path));
        const edited = rad.nodes
          .filter((n) => files.has(n.path))
          .map((n) => n.id)
          .sort(cmp);
        if (edited.length > 0)
          out.push({ repo: name, pr: rad.number, fix: f.number, editedConsumers: edited });
      }
    }
  }
  return out.sort((a, b) => cmp(a.repo, b.repo) || a.pr - b.pr || a.fix - b.fix);
}

// ---- results ----

type Order = "a" | "b" | "cAsc" | "cDesc";
const wsKey = (n: RNode): string => n.workspace ?? "￿";
const today = (a: RNode, b: RNode): number =>
  cmp(wsKey(a), wsKey(b)) || cmp(a.path, b.path) || cmp(a.name, b.name) || cmp(a.id, b.id);
const orders: Record<Order, (a: RNode, b: RNode) => number> = {
  a: today,
  b: (a, b) => a.hop - b.hop || today(a, b),
  cAsc: (a, b) => a.hop - b.hop || Number(b.high) - Number(a.high) || a.fanIn - b.fanIn || today(a, b),
  cDesc: (a, b) => a.hop - b.hop || Number(b.high) - Number(a.high) || b.fanIn - a.fanIn || today(a, b),
};

const histogram = (xs: number[]): [number, number][] => {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((p, q) => p[0] - q[0]);
};
const INF = 1e9; // a node whose every path crosses an unbounded hub never becomes visible: v is capped here

function buildResults(radii: Radius[], fups: Followup[]): unknown {
  const byKey = new Map(radii.map((r) => [`${r.repo}#${r.number}`, r]));
  const prs = radii
    .filter((r) => !r.failed)
    .map((r) => {
      const perHop: Record<string, number> = {};
      for (const n of r.nodes) perHop[String(n.hop)] = (perHop[String(n.hop)] ?? 0) + 1;
      return {
        repo: r.repo,
        number: r.number,
        seeds: r.seeds,
        nodes: r.nodes.length,
        perHop,
        maxFanIn: r.nodes.reduce((m, n) => Math.max(m, n.fanIn), 0),
        fanIn: histogram(r.nodes.map((n) => n.fanIn)),
        visibleFrom: histogram(r.nodes.map((n) => Math.min(n.v, INF))),
      };
    })
    .sort((a, b) => cmp(a.repo, b.repo) || a.number - b.number);
  const sorted = new Map<string, Record<Order, string[]>>();
  const pairs = fups.map((f) => {
    const rad = byKey.get(`${f.repo}#${f.pr}`) as Radius;
    let ranks = sorted.get(`${f.repo}#${f.pr}`);
    if (!ranks) {
      ranks = Object.fromEntries(
        (Object.keys(orders) as Order[]).map((o) => [o, [...rad.nodes].sort(orders[o]).map((n) => n.id)]),
      ) as Record<Order, string[]>;
      sorted.set(`${f.repo}#${f.pr}`, ranks);
    }
    const idx = (o: Order, id: string): number => (ranks as Record<Order, string[]>)[o].indexOf(id) + 1;
    const nodes = new Map(rad.nodes.map((n) => [n.id, n]));
    const edited = f.editedConsumers.map((id) => {
      const n = nodes.get(id) as RNode;
      return {
        id,
        hop: n.hop,
        fanIn: n.fanIn,
        high: n.high,
        v: Math.min(n.v, INF),
        a: idx("a", id),
        b: idx("b", id),
        cAsc: idx("cAsc", id),
        cDesc: idx("cDesc", id),
      };
    });
    const first = (o: Order): number => Math.min(...edited.map((e) => e[o]));
    return {
      repo: f.repo,
      pr: f.pr,
      fix: f.fix,
      radius: rad.nodes.length,
      first: { a: first("a"), b: first("b"), cAsc: first("cAsc"), cDesc: first("cDesc") },
      edited,
    };
  });
  const failed = radii
    .filter((r) => r.failed)
    .map((r) => ({ repo: r.repo, number: r.number, reason: r.failed }));
  return { prs, pairs, failed };
}

// ---- report tables ----

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const nearest = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0
    ? Number.NaN
    : (s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number);
};

interface ResultsShape {
  prs: {
    repo: string;
    number: number;
    nodes: number;
    perHop: Record<string, number>;
    maxFanIn: number;
    fanIn: [number, number][];
    visibleFrom: [number, number][];
  }[];
  pairs: {
    repo: string;
    pr: number;
    fix: number;
    radius: number;
    first: Record<Order, number>;
    edited: { v: number; hop: number }[];
  }[];
  failed: unknown[];
}

function report(): void {
  const res = readJson<ResultsShape>(resultsPath);
  const nonEmpty = res.prs.filter((p) => p.nodes > 0);
  console.log(
    `PRs measured ${res.prs.length}, non-empty radius ${nonEmpty.length}, failed ${res.failed.length}, pairs ${res.pairs.length}`,
  );
  console.log(
    "\n| hop | PRs reaching it | median nodes | p90 nodes | max nodes |\n| --- | --- | --- | --- | --- |",
  );
  const maxHop = Math.max(...res.prs.flatMap((p) => Object.keys(p.perHop).map(Number)));
  for (let h = 1; h <= maxHop; h++) {
    const xs = res.prs.map((p) => p.perHop[String(h)] ?? 0).filter((x) => x > 0);
    console.log(`| ${h} | ${xs.length} | ${median(xs)} | ${nearest(xs, 0.9)} | ${Math.max(...xs)} |`);
  }
  const sizes = res.prs.map((p) => p.nodes);
  const deep = (p: (typeof res.prs)[number]): number =>
    Object.entries(p.perHop)
      .filter(([h]) => Number(h) >= 4)
      .reduce((s, [, c]) => s + c, 0);
  console.log(
    `\nradius size over all PRs: median ${median(sizes)}, p90 ${nearest(sizes, 0.9)}, p99 ${nearest(sizes, 0.99)}, max ${Math.max(...sizes)}`,
  );
  console.log(
    `node_cap: p99 ${nearest(sizes, 0.99)} rounded up to a multiple of 500 = ${Math.max(500, Math.ceil(nearest(sizes, 0.99) / 500) * 500)}`,
  );

  console.log("\n| ordering | pairs | median rank | top 10 | top 20 |\n| --- | --- | --- | --- | --- |");
  const medians: Record<string, number> = {};
  for (const o of ["a", "b", "cDesc", "cAsc"] as Order[]) {
    const ranks = res.pairs.map((p) => p.first[o]);
    medians[o] = median(ranks);
    const share = (k: number): string =>
      `${ranks.filter((r) => r <= k).length}/${ranks.length} (${((100 * ranks.filter((r) => r <= k).length) / (ranks.length || 1)).toFixed(0)}%)`;
    console.log(`| ${o} | ${ranks.length} | ${medians[o]} | ${share(10)} | ${share(20)} |`);
  }
  console.log(
    `fan_in_order: ${(medians.cAsc as number) < (medians.cDesc as number) ? "asc" : "desc"} (median rank asc ${medians.cAsc}, desc ${medians.cDesc})`,
  );

  // Fan-in distribution of nodes inside radii, pooled over PRs.
  const pooled = new Map<number, number>();
  for (const p of res.prs) for (const [v, c] of p.fanIn) pooled.set(v, (pooled.get(v) ?? 0) + c);
  const expand = [...pooled.entries()].sort((a, b) => a[0] - b[0]);
  const total = expand.reduce((s, [, c]) => s + c, 0);
  const pct = (p: number): number => {
    let acc = 0;
    for (const [v, c] of expand) {
      acc += c;
      if (acc >= Math.ceil(p * total)) return v;
    }
    return Number.NaN;
  };
  console.log(
    `\nfan-in over ${total} radius nodes: p50 ${pct(0.5)}, p90 ${pct(0.9)}, p99 ${pct(0.99)}, max ${expand.at(-1)?.[0]}`,
  );

  // Hub threshold: the smallest T that keeps every edited consumer of >= 90% of pairs listed.
  const pairMax = res.pairs.map((p) => Math.max(...p.edited.map((e) => e.v)));
  const removedAt = (t: number): number =>
    res.prs.reduce((s, p) => s + p.visibleFrom.filter(([v]) => v > t).reduce((x, [, c]) => x + c, 0), 0);
  const visAt = (t: number): number => pairMax.filter((m) => m <= t).length;
  const maxT = Math.max(...res.prs.map((p) => p.maxFanIn), 0);
  let pick = -1;
  for (let t = 0; t <= maxT; t++) {
    if (pairMax.length > 0 && visAt(t) / pairMax.length >= 0.9) {
      pick = t;
      break;
    }
  }
  console.log(
    `\n| T | listed entries removed (of ${total}) | pairs with every edited consumer listed |\n| --- | --- | --- |`,
  );
  const ts = [
    ...new Set([pick, 1, 2, 5, 10, 20, 50, 100, 200, 500, pct(0.9), pct(0.99), maxT].filter((t) => t >= 0)),
  ].sort((a, b) => a - b);
  for (const t of ts)
    console.log(
      `| ${t}${t === pick ? " (picked)" : ""} | ${removedAt(t)} (${((100 * removedAt(t)) / total).toFixed(1)}%) | ${visAt(t)}/${pairMax.length} |`,
    );
  console.log(`hub_threshold: ${pick}`);
  // Not the rule: the same fit when a pair counts as kept if at least one of its edited consumers is listed, and the
  // pairs and PRs the numbers rest on (pairs of one PR share a radius).
  const pairMin = res.pairs.map((p) => Math.min(...p.edited.map((e) => e.v)));
  const lenient = [...new Set(pairMin)]
    .sort((a, b) => a - b)
    .find((t) => pairMin.filter((m) => m <= t).length / pairMin.length >= 0.9);
  console.log(
    `(not the rule) smallest T with at least one edited consumer listed in 90% of pairs: ${lenient}`,
  );
  console.log(
    `pairs ${res.pairs.length} over ${new Set(res.pairs.map((p) => `${p.repo}#${p.pr}`)).size} PRs and ${new Set(res.pairs.map((p) => `${p.repo}#${p.fix}`)).size} fix PRs; edited consumers per pair: median ${median(res.pairs.map((p) => p.edited.length))}`,
  );

  // Does the size of hops 4+ separate PRs with a follow-up fix from those without?
  const withFix = new Set(res.pairs.map((p) => `${p.repo}#${p.pr}`));
  const g1 = nonEmpty.filter((p) => withFix.has(`${p.repo}#${p.number}`)).map(deep);
  const g0 = nonEmpty.filter((p) => !withFix.has(`${p.repo}#${p.number}`)).map(deep);
  const sep = g1.length >= 5 && g0.length >= 5 && median(g1) > nearest(g0, 0.75);
  console.log(
    `\nhops 4+ nodes: with follow-up fix n=${g1.length} median ${median(g1)}; without n=${g0.length} median ${median(g0)}, p75 ${nearest(g0, 0.75)}; separates=${sep}`,
  );
}

// ---- walk time ----

function timeWalk(name: string, cap: number): void {
  const r = repoByName(name);
  ensureCopy(r);
  const wt = join(WORK, `wt-${name}-head`);
  const data = join(WORK, `data-${name}`);
  const dir = resolve(wt);
  const paths = resolvePaths(dir, { ...process.env, CLAUDE_PLUGIN_DATA: data });
  const store = openStore(paths.dbPath);
  try {
    const head = sh(dir, "rev-parse", "HEAD");
    if (head !== r.sha) throw new Error(`${wt} is at ${head}, not ${r.sha}`);
    // Seeds: the 10 exported functions with the most hop-1 consumers (the PRs of the corpus do not include this repo).
    const fan = new Map<string, Set<string>>();
    for (const e of store.effectiveEdges({ kind: [...CONSUMER_KINDS] })) {
      if (!isSymId(e.dst) || e.src.startsWith("ext:") || e.src === e.dst) continue;
      const s = fan.get(e.dst) ?? new Set<string>();
      s.add(e.src);
      fan.set(e.dst, s);
    }
    const seeds = [...fan.entries()]
      .map(([id, srcs]) => ({ id, n: srcs.size, sym: store.getSymbol(id) }))
      .filter((x) => x.sym?.exported === true && x.sym.kind === "function")
      .sort((a, b) => b.n - a.n || cmp(a.id, b.id))
      .slice(0, 10);
    const changeOf = (id: string): SymbolChange => {
      const s = store.getSymbol(id) as NonNullable<ReturnType<typeof store.getSymbol>>;
      const side = {
        id,
        path: pathOfSymId(id) as string,
        line: s.startLine,
        signature: s.signature ?? "",
        exactHash: "",
        kind: s.kind,
        exported: true,
        complexity: 0,
      };
      return {
        id,
        kind: "modified",
        before: side,
        after: side,
        signatureChanged: false,
        exportedChanged: false,
        locDelta: 0,
      };
    };
    const files = store.effectiveFiles().length;
    console.log(`${name}: ${files} files indexed at ${r.sha}`);
    const capped = cap < Number.POSITIVE_INFINITY;
    // (A) The walk as the prototype above reads it: one store query per node (`walkRadius`). Each query rebuilds the
    // effective-files view, so a node costs one such query; the walk is timed with `cap` nodes and projected without.
    const q: number[] = [];
    for (const [i, s] of seeds.entries()) {
      const t0 = performance.now();
      store.effectiveEdges({ dst: s.id });
      q.push(performance.now() - t0);
      if (i >= 29) break;
    }
    for (let i = q.length; i < 30; i++) {
      const t0 = performance.now();
      store.effectiveEdges({ dst: seeds[i % seeds.length]?.id as string });
      q.push(performance.now() - t0);
    }
    console.log(
      `(A) one store query per node: median ${Math.round(median(q))} ms per effectiveEdges({ dst }) over 30 queries`,
    );
    const medA: number[] = [];
    const medCold: number[] = [];
    const medCpu: number[] = [];
    const medWarm: number[] = [];
    let loadMs = 0;
    for (const s of seeds) {
      const timesA: number[] = [];
      for (let i = 0; i < 3 && capped; i++) {
        const t0 = performance.now();
        walkRadius(store, [changeOf(s.id)], cap);
        timesA.push(performance.now() - t0);
      }
      const cold: number[] = [];
      const cpu: number[] = [];
      const warm: number[] = [];
      let size = 0;
      let maxHop = 0;
      for (let i = 0; i < 3; i++) {
        const c0 = process.cpuUsage();
        const t0 = performance.now();
        const map = loadConsumerMap(store);
        const t1 = performance.now();
        const nodes = walkBatched(map, [s.id]);
        const t2 = performance.now();
        loadMs = t1 - t0;
        cold.push(t2 - t0);
        const c = process.cpuUsage(c0);
        cpu.push((c.user + c.system) / 1000);
        warm.push(t2 - t1);
        size = nodes.size;
        maxHop = Math.max(0, ...[...nodes.values()].map((n) => n.hop));
      }
      if (capped) medA.push(median(timesA));
      medCold.push(median(cold));
      medCpu.push(median(cpu));
      medWarm.push(median(warm));
      console.log(
        `  seed ${s.id}: hop-1 ${s.n}, radius ${size}, max hop ${maxHop}; (A) ${capped ? `${cap} nodes ${Math.round(median(timesA))} ms` : "skipped"}; (B) load+walk ${Math.round(median(cold))} ms (load ${Math.round(loadMs)} ms, walk ${Math.round(median(warm))} ms, cpu ${Math.round(median(cpu))} ms)`,
      );
    }
    // Same nodes and hops from (A) and (B) on the seeds with a small radius.
    let same = 0;
    let checked = 0;
    const map = loadConsumerMap(store);
    for (const [id, srcs] of fan) {
      if (checked >= 5) break;
      if (srcs.size !== 1 || store.getSymbol(id)?.exported !== true) continue;
      const b = walkBatched(map, [id]);
      if (b.size > 40) continue;
      const a = walkRadius(store, [changeOf(id)]).nodes;
      checked++;
      if (a.size === b.size && [...a.values()].every((n) => b.get(n.id)?.hop === n.hop)) same++;
    }
    console.log(`(A) and (B) agree on nodes and hops for ${same} of ${checked} small seeds`);
    if (capped)
      console.log(
        `| ${name} (A, ${cap}-node cap) | ${files} | ${seeds.length} | ${Math.round(median(medA))} | ${Math.round(Math.max(...medA))} | <machine> |`,
      );
    console.log(
      `| ${name} (B, load + walk) | ${files} | ${seeds.length} | ${Math.round(median(medCold))} | ${Math.round(Math.max(...medCold))} | <machine> |`,
    );
    console.log(
      `| ${name} (B, load + walk, CPU time) | ${files} | ${seeds.length} | ${Math.round(median(medCpu))} | ${Math.round(Math.max(...medCpu))} | <machine> |`,
    );
    console.log(
      `| ${name} (B, walk on a loaded graph) | ${files} | ${seeds.length} | ${Math.round(median(medWarm))} | ${Math.round(Math.max(...medWarm))} | <machine> |`,
    );
  } finally {
    store.close();
  }
}

// ---- main ----

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--corpus")) corpus();
  else if (args.includes("--radius")) await radiusAll(true);
  else if (args.includes("--followups")) {
    const radii = await radiusAll(true);
    writeFileSync(followupsPath, stringify(followups(radii)));
  } else if (args.includes("--results")) {
    const radii = await radiusAll(true);
    writeFileSync(resultsPath, stringify(buildResults(radii, readJson<Followup[]>(followupsPath))));
  } else if (args.includes("--check")) {
    const radii = await radiusAll(false);
    const now = stringify(buildResults(radii, readJson<Followup[]>(followupsPath)));
    // The committed file is formatted by biome, so compare it after the same key sorting.
    const ok = now === stringify(readJson(resultsPath));
    console.log(ok ? "results.json reproduced exactly" : "results.json differs from a fresh run");
    return ok ? 0 : 1;
  } else if (args.includes("--report")) report();
  else if (args.includes("--time")) {
    const cap = args.includes("--cap") ? Number(args[args.indexOf("--cap") + 1]) : 25;
    timeWalk(args[args.indexOf("--time") + 1] ?? "", cap);
  } else {
    console.error(
      "usage: run.ts --corpus | --radius | --followups | --results | --check | --report | --time <repo> [--cap N]",
    );
    return 2;
  }
  return 0;
}

process.exitCode = await main();
