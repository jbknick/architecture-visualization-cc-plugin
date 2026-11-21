/**
 * Times the walk behind the reachable tier on an indexed repo and, on request, checks it against a per-node
 * reference walk (#293). Not part of `pnpm check`: a large repo takes minutes.
 *
 *   CLAUDE_PLUGIN_DATA=<dir> node --max-old-space-size=6144 --import tsx scripts/reachable-bench.ts <repo dir> time
 *   CLAUDE_PLUGIN_DATA=<dir> node --max-old-space-size=6144 --import tsx scripts/reachable-bench.ts <repo dir> check
 *
 * The repo must be indexed (`gantry init`) with the same `CLAUDE_PLUGIN_DATA` and `HOME`. Seeds are the ten exported
 * functions with the most hop-1 consumers (the spike's rule). `time` runs `computeImpact` on each seed three times
 * (the one query that loads every consumer edge is inside every run) and prints the median of three per seed, the
 * median over seeds and the slowest seed. `check` walks each seed with one store query per node, the way the walk
 * worked before the in-memory read, and compares nodes and hops with the shipped walk at the node cap.
 */

import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  CONSUMER_KINDS,
  ConsumerGraph,
  computeImpact,
  directConsumerUses,
  modifiedChanges,
  openStore,
  REACHABLE_NODE_CAP,
  reachableTier,
  resolvePaths,
  type Store,
} from "../packages/core/src/index.js";
import { walkToEnd } from "../packages/core/src/review/reachable.js";

const FUNCTION_LIKE = new Set(["function", "method", "component", "hook"]);
const SEEDS = 10;

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

function pickSeeds(store: Store): string[] {
  const g = new ConsumerGraph(store);
  g.preload();
  return store
    .effectiveSymbols({ exported: true })
    .filter((s) => FUNCTION_LIKE.has(s.kind))
    .map((s) => ({ id: s.id, n: g.fanIn(s.id) }))
    .sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1))
    .slice(0, SEEDS)
    .map((s) => s.id);
}

/** One store query per node, as before the in-memory read. Same rules, nothing shared with `walkToEnd`. */
function referenceWalk(store: Store, seeds: Set<string>, direct: string[], cap: number): Map<string, number> {
  const hops = new Map<string, number>();
  let frontier: string[] = [];
  for (const d of [...direct].sort()) {
    if (seeds.has(d)) continue;
    if (hops.size >= cap) return hops;
    hops.set(d, 1);
    frontier.push(d);
  }
  for (let hop = 2; frontier.length > 0; hop++) {
    const found = new Set<string>();
    for (const node of frontier) {
      const kinds = node.startsWith("file:") ? [...CONSUMER_KINDS, "imports" as const] : [...CONSUMER_KINDS];
      for (const e of store.effectiveEdges({ dst: node, kind: kinds })) {
        if (e.src.startsWith("ext:") || e.src === node || seeds.has(e.src) || hops.has(e.src)) continue;
        if (e.kind === "imports" && !node.startsWith("file:")) continue;
        found.add(e.src);
      }
    }
    frontier = [];
    for (const id of [...found].sort()) {
      if (hops.size >= cap) return hops;
      hops.set(id, hop);
      frontier.push(id);
    }
  }
  return hops;
}

async function main(): Promise<void> {
  const [repoDir, mode] = process.argv.slice(2);
  if (repoDir === undefined || (mode !== "time" && mode !== "check")) {
    process.stderr.write("usage: reachable-bench.ts <repo dir> time|check\n");
    process.exitCode = 2;
    return;
  }
  const paths = resolvePaths(resolve(repoDir), process.env);
  const store = openStore(paths.dbPath);
  try {
    const seeds = pickSeeds(store);
    process.stdout.write(
      `${store.effectiveFiles().length} files, ${seeds.length} seeds, cap ${REACHABLE_NODE_CAP}\n`,
    );
    const medians: number[] = [];
    const walkMedians: number[] = [];
    let equal = 0;
    for (const seed of seeds) {
      const changes = modifiedChanges(store, [seed]);
      if (mode === "time") {
        const runs: number[] = [];
        const walks: number[] = [];
        let inTiers = 0;
        let reached = 0;
        let deep = 0;
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          const impact = computeImpact(store, changes);
          runs.push(performance.now() - t0);
          deep = impact.reachable.total;
          inTiers = impact.callersByHop.reduce((n, h) => n + h.ids.length, 0);
          // The walk to the end on its own, whatever the 500-node stop of the first tiers did: a fresh graph, the one
          // query that loads every edge, the walk and the ranked tier.
          const t1 = performance.now();
          const g = new ConsumerGraph(store);
          g.preload();
          const change = changes[0];
          if (!change) continue;
          const walk = walkToEnd(g, directConsumerUses(g, change), new Set([seed]), REACHABLE_NODE_CAP);
          reachableTier(g, "", walk.rows);
          walks.push(performance.now() - t1);
          reached = walk.rows.length;
        }
        medians.push(median(runs));
        walkMedians.push(median(walks));
        process.stdout.write(
          `${seed}  first tiers ${inTiers}  reachable via computeImpact ${deep}  walk reached ${reached}  computeImpact ${runs.map((r) => r.toFixed(0)).join("/")} ms (median ${median(runs).toFixed(0)})  walk to the end ${walks.map((r) => r.toFixed(0)).join("/")} ms (median ${median(walks).toFixed(0)})\n`,
        );
        continue;
      }
      // check: the shipped walk (in memory) against the per-node reference, both at the cap.
      const perNode = new ConsumerGraph(store);
      const change = changes[0];
      if (!change) continue;
      const direct = directConsumerUses(perNode, change);
      const t0 = performance.now();
      const expected = referenceWalk(store, new Set([seed]), [...direct.keys()], REACHABLE_NODE_CAP);
      const refMs = performance.now() - t0;
      const loaded = new ConsumerGraph(store);
      loaded.preload();
      const mine = walkToEnd(loaded, directConsumerUses(loaded, change), new Set([seed]), REACHABLE_NODE_CAP);
      const got = new Map(mine.rows.map((r) => [r.id, r.hop]));
      const same = got.size === expected.size && [...expected].every(([id, hop]) => got.get(id) === hop);
      // And the whole of computeImpact agrees with the reference on the reachable counts.
      const impact = computeImpact(store, changes);
      const deep = [...expected].filter(([, hop]) => hop >= 4);
      const sameImpact =
        impact.reachable.total === deep.length && impact.consumers[0]?.reachableTotal === deep.length;
      if (same && sameImpact) equal++;
      process.stdout.write(
        `${seed}  nodes ${expected.size}  hops ${Math.max(0, ...expected.values())}  reachable ${deep.length}  capped ${mine.capped}  reference ${(refMs / 1000).toFixed(0)} s  ${same && sameImpact ? "EQUAL" : "DIFFERENT"}\n`,
      );
    }
    if (mode === "time") {
      process.stdout.write(
        `computeImpact: median of seed medians ${median(medians).toFixed(0)} ms, slowest seed ${Math.max(...medians).toFixed(0)} ms (bar 2000 ms)\nwalk to the end (ungated, to the cap): median of seed medians ${median(walkMedians).toFixed(0)} ms, slowest seed ${Math.max(...walkMedians).toFixed(0)} ms (bar 2000 ms)\n`,
      );
    } else {
      process.stdout.write(`equal on ${equal} of ${seeds.length} seeds\n`);
    }
  } finally {
    store.close();
  }
}

await main();
