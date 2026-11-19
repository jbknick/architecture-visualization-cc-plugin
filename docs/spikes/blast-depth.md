# Spike #292: how far a blast radius reaches, where hubs start and whether ranking finds what mattered

Status: done on macOS arm64 (one machine, heavily loaded; see "Machine").

Verdict: NO-GO

The Bar is missed as written. The walk as the prototype reads it (one store query per node) is hundreds of times over 2 s at 24,968 files (projected from 82 ms per query; the walk itself was stopped at 25 nodes). The same walk over a one-query in-memory adjacency stays under 2 s (median 966 ms, slowest seed 1,999 ms wall, 1,111 ms CPU), but that is a different implementation than the one the issue describes, and the wall number clears the line by 1 ms on a loaded machine. Per the issue, a miss stops M18 until the maintainer decides; the constants below are fitted anyway so the decision can be made with them in hand.

## Tables

### Corpus

| repo       | URL                                                                                  | SHA                                        | files indexed | PRs used           | follow-up pairs |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------ | ------------- | ------------------ | --------------- |
| cal.com    | [https://github.com/calcom/cal.com](https://github.com/calcom/cal.com)               | `ae027bb70e694e2d2c44569f398d6cbcee0389b1` | 5,075         | 35                 | 60 (13 PRs)     |
| formbricks | [https://github.com/formbricks/formbricks](https://github.com/formbricks/formbricks) | `b52ebf833e92c1205d95492dc43567760ef56706` | 6,054         | 35                 | 410 (17 PRs)    |
| n8n        | [https://github.com/n8n-io/n8n](https://github.com/n8n-io/n8n)                       | `bac26db0ff582aa01916e4d1467cf4632b2440e4` | 24,968        | 0 (walk time only) | 0               |

"Files indexed" is the number of files in the store after `init` (`store.effectiveFiles()`). `gantry init` prints a smaller "Indexed" count (cal.com 4,974, formbricks 6,033, n8n 24,864); cal.com is under 10,000 by either count, so the walk time is measured on n8n as step 1 says. 70 PRs in all, none failed to index; 58 have a non-empty radius (29 per repo). 470 pairs over 30 PRs: pairs of one PR share a radius, and formbricks has 410 of them because a few PRs touch widely used files that many later `fix` PRs edit. All the pair statistics below are per pair, as the issue defines them.

### Radius per hop

The walk to the end (no hop limit, no node cap) over the 70 PRs. Radius size over all 70 PRs: median 9, p90 1,121, p99 2,369, max 2,369 (with 70 PRs, p99 is the maximum). The longest chain is 16 hops.

| hop | PRs reaching it | median nodes | p90 nodes | max nodes |
| --- | --------------- | ------------ | --------- | --------- |
| 1   | 58              | 6            | 112       | 729       |
| 2   | 47              | 7            | 348       | 637       |
| 3   | 38              | 17           | 657       | 948       |
| 4   | 32              | 18           | 212       | 423       |
| 5   | 27              | 61           | 190       | 582       |
| 6   | 22              | 18           | 210       | 287       |
| 7   | 18              | 10           | 222       | 247       |
| 8   | 16              | 3.5          | 140       | 277       |
| 9   | 10              | 13.5         | 78        | 387       |
| 10  | 9               | 7            | 225       | 225       |
| 11  | 5               | 11           | 208       | 208       |
| 12  | 4               | 39           | 114       | 114       |
| 13  | 3               | 25           | 54        | 54        |
| 14  | 3               | 4            | 12        | 12        |
| 15  | 3               | 1            | 1         | 1         |
| 16  | 2               | 2            | 2         | 2         |

Medians and p90 are over the PRs that reach the hop. Today's walk stops at hop 3, so 32 of 58 PRs (55%) have nodes the shipped walk never shows.

### Walk time

n8n at the pinned SHA, 24,968 files, 10 seeds (the 10 exported functions with the most hop-1 consumers; their radii are 688 to 15,431 nodes and up to 12 hops). Each seed is timed 3 times and the row gives the median of the 10 seed medians and the slowest seed's median. Machine: see below.

| repo                 | files  | seeds | median of 3 (ms) | slowest seed (ms) | machine               |
| -------------------- | ------ | ----- | ---------------- | ----------------- | --------------------- |
| n8n (A, 25-node cap) | 24,968 | 10    | 5,682            | 16,997            | M3 Pro, load 30 to 48 |
| n8n (B, wall clock)  | 24,968 | 10    | 966              | 1,999             | M3 Pro, load 30 to 48 |
| n8n (B, CPU time)    | 24,968 | 10    | 1,029            | 1,111             | M3 Pro, load 30 to 48 |
| n8n (B, walk only)   | 24,968 | 10    | 24               | 60                | M3 Pro, load 30 to 48 |

- (A) is the walk as the prototype reads it: one `effectiveEdges` query per node. It is stopped at 25 nodes; the full walk is far longer (median 82 ms per query, so about 1,265 s projected for the 15,431-node seed).
- (B) makes one `effectiveEdges` query for all consumer edges, then walks in memory; the load is included in every run. "Walk only" times just the walk on an already loaded adjacency.

(A) and (B) return the same nodes and hops on the 5 small-radius seeds checked (5 of 5). The cost is the store read: `effectiveEdges({ dst })` rebuilds the effective-files view for every call (82 to 310 ms here, depending on load), so a per-node walk costs radius times that. Loading all consumer edges once takes 0.6 to 2 s here; the walk over them takes 60 ms or less for a 15,000-node radius.

### Ranking

Rank of the first follow-up-edited consumer within the whole radius (1 is best), over 470 pairs.

| ordering                                                  | pairs | median rank | share in top 10 | share in top 20 |
| --------------------------------------------------------- | ----- | ----------- | --------------- | --------------- |
| (a) today: workspace, path, name, id                      | 470   | 413.5       | 25 of 470 (5%)  | 39 of 470 (8%)  |
| (b) hop, then today's order                               | 470   | 288         | 35 of 470 (7%)  | 49 of 470 (10%) |
| (c) hop, path confidence, fan-in descending, then today's | 470   | 177         | 60 of 470 (13%) | 87 of 470 (19%) |
| (c') hop, path confidence, fan-in ascending, then today's | 470   | 259.5       | 35 of 470 (7%)  | 57 of 470 (12%) |

Ranking by hop, confidence and fan-in helps (median rank 413.5 to 177) but does not put what mattered near the top: 13% of pairs have an edited consumer in the top 10 and 19% in the top 20. In 211 of 470 pairs an edited consumer is already at hop 1; the rest sit at hops 2 to 6, which a flat list buries.

### Decisions

Read by GH-293 and GH-294.

| key                 | value                                                                                                                                                                                                       | how chosen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node_cap            | 2500                                                                                                                                                                                                        | The p99 radius size of the 70 PRs is 2,369; rounded up to a multiple of 500 is 2,500. The step 5 condition (walk at 2 s or less with this cap) holds for (B), whose uncapped walk is 60 ms or less; it does not hold for (A) at any cap, because a node costs one store query. Five of the ten n8n seeds reach 10,510 to 15,431 nodes, so the cap will truncate hubs of that size.                                                                                                                                                 |
| hub_threshold       | 608                                                                                                                                                                                                         | A node is a hub when its fan-in is above T; a node at hop 2 or later is collapsed when every predecessor is a hub or collapsed (hop-1 nodes are always listed). Rule: the smallest T for which every follow-up-edited consumer is still listed in at least 90% of pairs (439 of 470 pairs at T = 608). At that T the collapse removes 1,482 of 21,505 listed entries (6.9%). Fan-in over all radius nodes: p50 1, p90 3, p99 21, max 659. See "Hub threshold" below: the rule only allows a threshold close to the maximum fan-in. |
| fan_in_order        | desc                                                                                                                                                                                                        | Median rank of the first edited consumer is 177 with fan-in descending against 259.5 ascending (ordering c against c').                                                                                                                                                                                                                                                                                                                                                                                                            |
| fan_in_definition   | The number of distinct sources of incoming consumer edges of a node (`CONSUMER_KINDS`, plus `imports` for a `file:` node), without `ext:` sources and self edges, as `ConsumerGraph.incoming` returns them. | The prototype computes it per node from that reader; the batched walk computes the same set from the loaded edges.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| reachable_risk_rule | none (hops 4+ size separates the groups, but only by tracking radius size; M18 adds no risk rule)                                                                                                           | Nodes at hop 4 or later: median 62 for PRs with a follow-up fix (n = 30) against 0 for PRs without (n = 28). Nodes at hops 1 to 3 separate just as strongly (median 73 against 4.5), and the total radius does too (161.5 against 4.5), so hops 4+ adds no signal beyond the radius the shipped tiers already show. A follow-up pair also needs a non-empty radius to exist, which biases the comparison toward large radii.                                                                                                       |

## Hub threshold

| T                | listed entries removed (of 21,505) | pairs with every edited consumer listed |
| ---------------- | ---------------------------------- | --------------------------------------- |
| 1                | 18,002 (83.7%)                     | 93 of 470                               |
| 5                | 16,644 (77.4%)                     | 143 of 470                              |
| 21 (p99 fan-in)  | 13,562 (63.1%)                     | 178 of 470                              |
| 100              | 8,477 (39.4%)                      | 225 of 470                              |
| 500              | 5,815 (27.0%)                      | 277 of 470                              |
| 608 (picked)     | 1,482 (6.9%)                       | 439 of 470                              |
| 659 (max fan-in) | 0 (0%)                             | 470 of 470                              |

Collapsing hubs as the rule defines them is not useful on this corpus. Most nodes have a fan-in of 1 to 3, so a low threshold would remove most of the list (84% at T = 1), but the consumers that follow-up fixes edit sit behind high fan-in nodes: with a threshold below about 600 a majority of pairs lose an edited consumer. Counting a pair as kept when at least one of its edited consumers is listed gives T = 593, nearly the same. GH-294 should treat 608 as "collapse only the largest hubs" and not as a way to shrink the list; the ranking in the previous table is the better lever.

## Method

- Corpus: the 300 most recent merged PRs of each repo (`gh pr list --state merged --limit 300`, each read in full with `gh pr view`, because one list request asking for files and bodies is too large for the API). Kept: merge commit is an ancestor of the pinned SHA, changes at least one non-test `.ts`/`.tsx` file, and the merge commit's first-parent diff names the same source files as the PR (this drops rebase-merged and squash-split PRs; 2 of 207 for cal.com, 57 of 191 for formbricks). 205 and 134 PRs qualify; 35 per repo are taken at even steps through the list in merge order.
- Radius: for each PR a `git worktree` of a copy of the clone at the PR's base, `node plugin/dist/cli.js init` with a fresh `CLAUDE_PLUGIN_DATA`, `reviewDiff(paths, base, merge)`, then the walk in `walk.ts`: breadth-first from the direct consumers (`directConsumers`) over `CONSUMER_KINDS`, a `file:` node also through its importers, no hop limit and no node cap. Each node keeps its first hop, its path confidence (`high` when some path of hop-many edges to the change has only `high` edges) and its fan-in.
- Follow-up fixes: a later merged PR within 30 days whose title starts with `fix` (any case) or whose body names the PR number, and that edits a file holding a consumer in the radius.
- Reproduce: `pnpm exec tsx docs/spikes/blast-depth/run.ts --check` recomputes every radius and compares the result with `results.json` (about 45 minutes); `--report` prints the tables above from `results.json`; `--time n8n` prints the walk time rows.

## Machine

MacBook with Apple M3 Pro (11 cores), 18 GB, macOS (Darwin 27.2.0), Node v26.13.0. The machine was shared with other builds and test runs during every measurement: the load average was 30 to 57 on 11 cores. Wall-clock timings are therefore inflated and vary run to run (an earlier (B) run on the same data gave a median of 1,747 ms and a slowest seed of 3,197 ms; the figures in the table are from the last run, load 48 falling to 30). CPU time is the steadier figure and is given beside the wall clock.

## Deviations from the steps

- The Bar is judged on (A), the walk as the issue describes it, which misses. (B) is an addition of this spike, not in the steps; it is shown because it decides what GH-293 can ship.
- (A) is timed with a 25-node cap, not to the end, because an uncapped run on the large seeds takes tens of minutes. The full cost is projected from the measured per-query time.
- `run.ts` and `walk.ts` import `packages/core/src` by relative path, not `@gantry/core`: a script under `docs/` does not resolve workspace packages. Nothing under `packages/` is changed.
- The work directory holds its own copies of the clones (the shared clones in `~/Dev/gantry-oss/` are not touched); the PR copies are made with `git clone` from them and a worktree per PR.
- 35 PRs per repo (70 in all), not "all that qualify".
- The timing seeds are chosen by hop-1 consumer count among all exported functions, so three of the ten are test helpers in `packages/@n8n/typeorm/test/utils/test-utils.ts`. Their radii are small (about 690 nodes); excluding them would raise the median.
- In the n8n timing, hop 1 includes the importers of the seed's file, as `directConsumers` reads them; that is why radii are larger than the number of hop-1 consumers of the symbol alone.
- The `hub_threshold` rule counts a pair as kept only when every edited consumer of the pair is listed (the stricter of two readings of the issue); the other reading gives 593.
- The `reachable_risk_rule` separation test (median of the group with a fix above the p75 of the group without, at least 5 PRs in each) is this spike's choice; the issue gives no test.
- Files indexed uses the store's file count; `gantry init` prints a slightly smaller number (see Corpus).

## Spec check

No conflict with `docs/SPEC.md` found. The walk to the end, the hub threshold and the ranking are not in the spec today (section 11 has 3 hops, 500 nodes); the spike changes no contract.
