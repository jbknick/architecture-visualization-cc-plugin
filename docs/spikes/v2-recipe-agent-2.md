# Spike: the recipe agent, re-measured on the real engine (#350)

## Result against the Bar

**The Bar is missed: 2 of 12 repos pass on the worst of 3 runs; the Bar needs at least 10.**

The Bar is the one in `docs/spikes/v2-recipe-agent.md` (#245), unchanged: a repo passes when every scored kind among routes, endpoints and tables reaches at least 90% recall at 95% precision in each of its three runs. The two passing repos are `express-mongodb-rest-api-boilerplate` (tables only, 7 labelled) and `next-js-boilerplate` (tables 1, plus reads and writes). If reads and writes are scored as well, which the Bar does not ask for, only `next-js-boilerplate` passes: 1 of 12. By run, 9 of the 36 runs pass the Bar (3 of 36 with reads and writes).

**Next to it, the fixed-recipe baseline: 5 of the 12 repos have a committed reference recipe, and all 5 meet the Bar on the kinds the Bar scores (tables: 100/100 each); the other 7 have none.** So the baseline is 5 of 12 on the repos where a recipe exists, 5 of 5 of those, and 7 of 12 are unmeasured, not failed. If reads and writes are scored as well, 4 of the 5 meet it (express-mongodb-rest-api-boilerplate: reads 50, writes 82 recall). The agent, on the same 12 repos: 2 of 12. On the 5 repos that have a fixed recipe the agent reaches the Bar on 2 (express-mongodb-rest-api-boilerplate and next-js-boilerplate), against the baseline's 5. Source: `pnpm eval:recipes` (output summary: 8 cases, 7 passed; the other 3 cases, express-ts-example-app, nestjs-sequelize-typescript and pg-boss, are not among the 12 repos; the one that did not pass is express-mongodb-rest-api-boilerplate on reads and writes, and the command exits 1 for it).

For comparison, the first spike on the prototype engine reached 2 of 12 as well (1 of 12 on its first prompt). The real engine and this prompt did not change the count.

Nothing under `packages/` or `plugin/` changed, `recipe check` is as it was, and the Bar and the labels are unchanged.

## Setup

- Runner: `docs/spikes/v2-recipe-agent-2/run.ts`, 12 repos x 3 runs, 4 at a time, one go, none repeated. Repos: the 12 of the first spike, all pinned in `evals/oss/repos.json` at their listed SHAs (none replaced): bulletproof-react, bun-fastify-starter-turbo-monorepo, epic-stack, express-mongodb-rest-api-boilerplate, fastify-typescript, go-base, golang-gin-realworld-example-app, nestjs-boilerplate, nethttp, next-js-boilerplate, saasfly, simplebank.
- Agent: Claude Code 2.1.328 headless (`claude -p --agent recipe-agent`, no API key), `agent.md` with `model: sonnet`, `effort: medium`, `maxTurns: 80`. **Model id of every run: `claude-sonnet-5-5`** (read from each run's stream).
- Tools: `Read`, `Grep`, `Glob`, `Write` for `.gantry/recipe.json` only, and one command, the product's `node plugin/dist/cli.js recipe check`, in a copy of the pinned clone. The prompt (`prompt.md`) carries the recipe format from `docs/SPEC.md` section 5 at run time and asks for routes, endpoints, tables, reads and writes (the prompt was changed from the spot test for this, before any of these runs).
- Scoring: `pnpm eval:score <name> --recipe <recipe>` against the committed labels, which were written before the runs; their conventions are in `evals/oss/labels/README.md`. No label was changed.
- Repair or best-of-N: none. Each run is one attempt, scored as it ended.
- Fixed-recipe baseline: reference recipes (`evals/oss/recipes/`, `pnpm eval:recipes`) exist for 5 of the 12 repos: bun-fastify-starter-turbo-monorepo, express-mongodb-rest-api-boilerplate, fastify-typescript, nestjs-boilerplate, next-js-boilerplate. All five score 100/100 on tables; reads and writes also 100/100 except express-mongodb-rest-api-boilerplate (read recall 50, write recall 82). The other 7 repos have no fixed recipe, so they have no baseline here.

## Table 1: scores per run

Recall/precision in percent. r routes, e endpoints, t tables, rd reads, wr writes. The baseline column is the reference recipe in `evals/oss/recipes/` scored by `pnpm eval:recipes` on the real engine (no model call; one run, since the engine is deterministic: the command also fails if two dumps differ, and none did); "no recipe committed" means `evals/oss/recipes/<repo>.recipe.json` does not exist, and none was written for this report. Only kinds the repo's labels contain are scored. A kind with 0 predicted shows as 0/100 (the scorer's precision for no predictions).

| Repo@sha7                                    | Labels            | Run 1                             | Run 2                             | Run 3                             | Worst of 3                        | Fixed-recipe baseline             | Bar | Bar incl. rd/wr |
| -------------------------------------------- | ----------------- | --------------------------------- | --------------------------------- | --------------------------------- | --------------------------------- | --------------------------------- | --- | --------------- |
| bulletproof-react@9506629                    | r 10              | r 0/100                           | r 0/100                           | r 10/100                          | r 0/100                           | no recipe committed               | no  | no              |
| bun-fastify-starter-turbo-monorepo@774fcfe   | t 2, rd 1, wr 2   | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 100/100, rd 100/100, wr 100/100 | no  | no              |
| epic-stack@893610d                           | r 30, e 18, t 11  | r 0/100, e 0/100, t 100/100       | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | no recipe committed               | no  | no              |
| express-mongodb-rest-api-boilerplate@0ed1f89 | t 7, rd 12, wr 11 | t 100/100, rd 42/100, wr 64/100   | t 100/100, rd 42/100, wr 64/100   | t 100/100, rd 42/100, wr 64/100   | t 100/100, rd 42/100, wr 64/100   | t 100/100, rd 50/100, wr 82/100   | yes | no              |
| fastify-typescript@3e195bf                   | t 2, rd 2, wr 2   | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 100/100, rd 100/100, wr 100/100 | no  | no              |
| go-base@5f852fd                              | e 19, t 3         | e 0/100, t 0/100                  | e 0/100, t 0/100                  | e 0/100, t 0/100                  | e 0/100, t 0/100                  | no recipe committed               | no  | no              |
| golang-gin-realworld-example-app@a41289b     | e 20, t 7         | e 0/100, t 0/100                  | e 0/100, t 0/100                  | e 0/100, t 0/100                  | e 0/100, t 0/100                  | no recipe committed               | no  | no              |
| nestjs-boilerplate@9620f15                   | t 5, rd 6, wr 6   | t 100/100, rd 0/100, wr 0/100     | t 100/63, rd 100/60, wr 100/75    | t 0/100, rd 0/100, wr 0/100       | t 0/63, rd 0/60, wr 0/75          | t 100/100, rd 100/100, wr 100/100 | no  | no              |
| nethttp@63ead0d                              | e 5               | e 0/100                           | e 0/100                           | e 0/100                           | e 0/100                           | no recipe committed               | no  | no              |
| next-js-boilerplate@b83157a                  | t 1, rd 1, wr 1   | t 100/100, rd 100/100, wr 100/100 | t 100/100, rd 100/100, wr 100/100 | t 100/100, rd 100/100, wr 100/100 | t 100/100, rd 100/100, wr 100/100 | t 100/100, rd 100/100, wr 100/100 | yes | yes             |
| saasfly@49f7e28                              | r 14, e 5, t 6    | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | no recipe committed               | no  | no              |
| simplebank@97f000f                           | t 6, rd 5, wr 6   | t 100/100, rd 0/100, wr 0/100     | t 100/100, rd 0/100, wr 0/100     | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | no recipe committed               | no  | no              |

Repos passing the Bar on the worst of 3 runs: **2 of 12**. Including reads and writes: 1 of 12. Per kind over the 36 runs: tables reach the Bar in 10 runs (express-mongodb 3, next-js 3, simplebank 2, nestjs-boilerplate 1, epic-stack 1) and 90% recall in 11 (adding nestjs run 2, at precision 63); reads or writes have nonzero recall in 14 runs and reach the Bar only in the 3 next-js runs. Routes and endpoints: no run reached more than 10% recall on any repo (bulletproof-react run 3, 1 of 10 routes). Full per-run data, with the missed and extra lists, is in `docs/spikes/v2-recipe-agent-2/results.json` and `runs/<repo>/run<k>/`.

## Table 2: cost per run (run 1 / run 2 / run 3)

Input tokens are uncached + cache read + cache write as the CLI reports them.

| Repo                                 | Turns        | Check runs | Input tokens       | Output tokens      | Wall time       |
| ------------------------------------ | ------------ | ---------- | ------------------ | ------------------ | --------------- |
| bulletproof-react                    | 17 / 14 / 10 | 7 / 6 / 4  | 252k / 208k / 133k | 4099 / 3582 / 2662 | 38s / 33s / 24s |
| bun-fastify-starter-turbo-monorepo   | 23 / 7 / 16  | 6 / 2 / 7  | 336k / 103k / 281k | 8184 / 3175 / 9255 | 61s / 28s / 66s |
| epic-stack                           | 13 / 9 / 7   | 6 / 3 / 3  | 171k / 111k / 93k  | 4349 / 2538 / 2703 | 36s / 25s / 25s |
| express-mongodb-rest-api-boilerplate | 12 / 12 / 10 | 4 / 3 / 2  | 194k / 197k / 174k | 5563 / 5543 / 3883 | 41s / 42s / 35s |
| fastify-typescript                   | 8 / 8 / 12   | 4 / 3 / 5  | 118k / 115k / 161k | 4608 / 3798 / 6669 | 34s / 30s / 44s |
| go-base                              | 7 / 7 / 7    | 2 / 3 / 3  | 71k / 86k / 87k    | 1297 / 1518 / 1496 | 16s / 18s / 18s |
| golang-gin-realworld-example-app     | 8 / 6 / 6    | 2 / 2 / 2  | 103k / 73k / 74k   | 1633 / 946 / 1093  | 17s / 16s / 14s |
| nestjs-boilerplate                   | 6 / 18 / 11  | 2 / 6 / 4  | 76k / 299k / 173k  | 1772 / 8799 / 5169 | 18s / 61s / 42s |
| nethttp                              | 7 / 6 / 5    | 2 / 2 / 2  | 78k / 65k / 53k    | 1076 / 1022 / 817  | 17s / 16s / 13s |
| next-js-boilerplate                  | 7 / 18 / 17  | 2 / 7 / 6  | 96k / 234k / 212k  | 2177 / 6277 / 4612 | 22s / 50s / 43s |
| saasfly                              | 10 / 11 / 15 | 2 / 2 / 4  | 123k / 134k / 143k | 2905 / 3226 / 3836 | 26s / 29s / 34s |
| simplebank                           | 7 / 9 / 9    | 2 / 3 / 3  | 87k / 120k / 122k  | 1319 / 1864 / 2095 | 16s / 20s / 23s |

Totals for the 36 runs: 375 turns; **5,158,038 input tokens** (579 uncached, 4,840,999 cache read, 316,460 cache write); 125,560 output tokens; 1,094 s of agent time summed (4 at a time, so contention is in the wall times); the CLI's own cost estimate $3.01. This is about a quarter of the 21M input tokens budgeted from the first spike, because the runs ended after 5 to 23 turns. The spot test's two runs are not included (they used the old prompt).

## What changed since the first measurement

Stated from the two reports and the repository history only. The first measurement is `docs/spikes/v2-recipe-agent.md` (#245, merged as #327); this one is #350 (#356).

|                                       | First measurement (#245)                                                                                                                                       | This measurement (#350)                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine                                | A prototype copied from the recipes spike into `docs/spikes/v2-recipe-agent/engine.ts` and extended there; the runner indexed with the spike's own `cli.ts`.   | The product's engine: the index applies a recipe on every run (#352), driven by `node plugin/dist/cli.js`.                                                                                 |
| Helpers                               | The helper set of the recipes spike plus the extensions made in the first spike; tables from text and AST rules only; SQL text and read/write edges not built. | The helpers the product ships, including `text-rules` and `method-classes`; reads and writes are scored.                                                                                   |
| Dry-run tool                          | The spike's own `cli.ts` `dry-run`.                                                                                                                            | `recipe check`, which shows match counts per rule only (a known gap, not changed).                                                                                                         |
| What the agent is asked for           | Routes, endpoints and tables.                                                                                                                                  | Routes, endpoints, tables, reads and writes (the prompt was changed from the spot test before these runs).                                                                                 |
| Prompt revisions                      | Two (v1 baseline, v2); the Bar is read from v2.                                                                                                                | One; no change after seeing any score.                                                                                                                                                     |
| Runner defect                         | None recorded.                                                                                                                                                 | The runner told the agent to run `recipe check .gantry/recipe.json .`; the check takes one file argument and rejects the extra `.`. Agents dropped it and carried on; no run was repeated. |
| Language support in the recipe format | The prototype engine had Go rules (`@ast-grep/lang-go`); go-base endpoints reached 11% in 3 runs and gin 100% in 2 of 3.                                       | None: the recipe format has `typescript` and `text` rules only, so the Go repos could not be expressed.                                                                                    |
| Labels                                | Written before the runs; six repos' table lists differ from the data-access spike's.                                                                           | Written before the runs, conventions in `evals/oss/labels/README.md`; none changed.                                                                                                        |
| Runs                                  | 36 per prompt, 4 at a time, 24 interrupted by a usage limit and re-run, 1 failed run (saasfly run 1).                                                          | 36, 4 at a time, one go, none repeated, none failed (36 of 36 produced a scored recipe).                                                                                                   |
| Result on the worst of 3 runs         | 2 of 12 (v2 prompt; 1 of 12 on v1).                                                                                                                            | 2 of 12 (the same count, not the same repos).                                                                                                                                              |

Repos at the Bar: the first measurement passed bun-fastify-starter-turbo-monorepo and next-js-boilerplate; this one passes express-mongodb-rest-api-boilerplate (tables only) and next-js-boilerplate. Per run, 12 of 36 passed then (v2) and 9 of 36 now. What moved, from the two Table 1s: routes and endpoints fell from high recall in the first measurement (epic-stack routes 100% in all runs, bulletproof-react routes 100%) to 0 to 10% recall here, and the reads and writes the first measurement did not ask for score 0 on most repos. Two things changed at once (the engine and its dry-run output, and the prompt), so their effects are not separable.

## Tables of the first report

The first report has three result tables (scores per repo, stability, the on-request re-run), the cost means, the per-repo list of what the agent got wrong, the missing helpers, the plan assumptions and the deviations. Table 1 and the cost table are above (Tables 1 and 2). The rest follow, filled from `results.json` and `runs/<repo>/run<k>/`.

### Stability per repo (the first report's Table 2)

Recipes identical: the three `recipe.json` files of a repo have one distinct `recipeSha256` in `results.json`. Graphs identical: the first report compared the sha256 of the produced route, endpoint and table nodes of each run; **this run set did not record a graph hash, so "graphs identical" cannot be filled from committed data.** In its place the table gives the number of nodes each run's recipe produced per kind (the `predicted` count in each run's `score`), which is a count, not a comparison of the nodes. Rules is the length of `rules` in each run's recipe.

| Repo                                 | Recipes identical         | Rules per run | Predicted nodes per run (kind: run 1 / 2 / 3) |
| ------------------------------------ | ------------------------- | ------------- | --------------------------------------------- |
| bulletproof-react                    | no                        | 1 / 1 / 1     | r 0 / 0 / 1                                   |
| bun-fastify-starter-turbo-monorepo   | no                        | 6 / 7 / 7     | t 0, rd 0, wr 0 in all three                  |
| epic-stack                           | no                        | 3 / 3 / 3     | r 0 / 0 / 0, e 0 / 0 / 0, t 11 / 0 / 0        |
| express-mongodb-rest-api-boilerplate | no                        | 6 / 6 / 6     | t 7 / 7 / 7, rd 5 / 5 / 5, wr 7 / 7 / 7       |
| fastify-typescript                   | no                        | 8 / 6 / 7     | t 0, rd 0, wr 0 in all three                  |
| go-base                              | no                        | 1 / 1 / 1     | e 0, t 0 in all three                         |
| golang-gin-realworld-example-app     | no                        | 1 / 0 / 0     | e 0, t 0 in all three                         |
| nestjs-boilerplate                   | no                        | 1 / 4 / 3     | t 5 / 8 / 0, rd 0 / 10 / 0, wr 0 / 8 / 0      |
| nethttp                              | yes (three empty recipes) | 0 / 0 / 0     | e 0 in all three                              |
| next-js-boilerplate                  | no                        | 4 / 3 / 3     | t 1, rd 1, wr 1 in all three                  |
| saasfly                              | no                        | 5 / 5 / 3     | r 0, e 0, t 0 in all three                    |
| simplebank                           | no                        | 1 / 1 / 1     | t 6 / 6 / 0, rd 0, wr 0 in all three          |

Repos with three identical recipe files: 1 of 12 (nethttp, and only because the agent wrote an empty recipe each time). The predicted counts are the same in all three runs for 8 of 12 repos, but for 5 of those 8 the count is 0 in every run. Graph identity: not recorded here.

### Cost of a run (the first report's cost means)

Means over the 36 runs, from the totals under Table 2: 10.4 turns (375 / 36), 143.3k input tokens (5,158,038 / 36), 3.5k output tokens (125,560 / 36), 30.4 s of agent time (1,094 / 36). The first report's means were 14.6 turns, 191.9k input, 7.5k output and 62.1 s (prompt v2). Turns are about 70% of the first report's mean and wall time about half; this report does not claim a cause for the difference, and the wall times of the two sets were measured under different load.

### The on-request re-run (the first report's Table 3)

Not repeated: #350 asks for the 12 repos x 3 runs and does not ask for the re-run, and no re-run was made, so there is no row to fill. The first report's result (0 nodes lost, 7 of 7 new nodes, 3 of 3 repetitions, one synthetic fixture) is unchanged and was not re-measured on the real engine.

### What the agent got wrong, per repo

Missed and extra nodes per run, as counts from `runs/<repo>/run<k>/result.json` (the lists themselves are there). "None extra" means the `extra` list is empty in all three runs. The causes the agents and the recipes show are under "What the misses are" below; where a cause is not in the committed data it is not given here.

| Repo                                 | Missed per run (run 1 / 2 / 3)          | Extra                       |
| ------------------------------------ | --------------------------------------- | --------------------------- |
| bulletproof-react                    | r 10 / 10 / 9                           | none                        |
| bun-fastify-starter-turbo-monorepo   | t 2, rd 1, wr 2 in all three            | none                        |
| epic-stack                           | r 30, e 18 in all three; t 0 / 11 / 11  | none                        |
| express-mongodb-rest-api-boilerplate | rd 7, wr 4 in all three                 | none                        |
| fastify-typescript                   | t 2, rd 2, wr 2 in all three            | none                        |
| go-base                              | e 19, t 3 in all three                  | none                        |
| golang-gin-realworld-example-app     | e 20, t 7 in all three                  | none                        |
| nestjs-boilerplate                   | rd 6 / 0 / 6, wr 6 / 0 / 6, t 0 / 0 / 5 | run 2 only: rd 4, t 3, wr 2 |
| nethttp                              | e 5 in all three                        | none                        |
| next-js-boilerplate                  | none                                    | none                        |
| saasfly                              | r 14, e 5, t 6 in all three             | none                        |
| simplebank                           | rd 5, wr 6 in all three; t 0 / 0 / 6    | none                        |

Extra nodes occur in one run of 36 (nestjs-boilerplate run 2). Every other loss in this report is a loss of recall.

### Missing helpers

From the recipes and the final messages, not from a new run:

1. **Go rules.** The recipe format has none; 9 of 9 runs on go-base, gin and nethttp scored 0 predicted endpoints. Counted: `runs/{go-base,golang-gin-realworld-example-app,nethttp}/run*/result.json`.
2. **A check that names the helpers a rule needs.** 13 of the 19 recipes with a `text` rule do not list `text-rules` in `helpers`, and 3 of the 12 recipes whose read/write emits carry a `method` do not list `method-classes` (see "What the misses are", 2).
3. **A way to show the nodes a recipe produces.** `recipe check` gives match counts only; agents wrote that they could not see the produced nodes (see 3 below).
4. **File-system routes beyond the helper's conventions** (epic-stack's auto-routes), see 4 below.

The first report's other entries (method resolution that follows types in go-base, non-literal registration paths, chained `route()` registration, global prefixes, table naming rules) are not measured in this run set: these runs scored 0 on go-base and 0 or near 0 on every repo that depends on them, so the data cannot separate those causes from the ones above. Not filled.

### Plan assumptions

Only rows that these runs can check:

| Assumption                                                                                                                               | Verdict                         | Evidence                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| An agent can write the recipes unaided                                                                                                   | Not met against the Bar         | 2 of 12 repos at the Bar on the worst of 3 runs (10 needed); 9 of 36 runs pass                           |
| The agent runs as a Claude Code subagent, no API key                                                                                     | Confirmed again                 | 36 `claude -p --agent recipe-agent` runs, model `claude-sonnet-5-5` in every run of `results.json`       |
| The recipe is stable across agent runs                                                                                                   | Refuted again                   | 1 of 12 repos with three identical recipe files, and that one is an empty recipe                         |
| Same repo and same recipe give the same graph                                                                                            | Holds for the reference recipes | `pnpm eval:recipes` dumps each recipe twice from fresh data dirs and fails if they differ; none differed |
| An on-request re-run extends a recipe without losing nodes; re-run only when manifest framework dependencies change; evals per framework | Not re-measured                 | See the re-run heading above                                                                             |

### Deviations from the issue

- The runs used one prompt revision (reads and writes added after the spot test), no repair step and no best-of-N.
- The fixed-recipe baseline uses only the recipes already committed in `evals/oss/recipes/`; none was written for this issue. 7 of the 12 repos have none.
- Transcripts are not committed (they contain third-party code). Committed per run: the recipe, the score, the agent's final message.
- Stack and file-count columns of the first report's Table 1 are not repeated; the stacks are in `evals/oss/repos.json`.

## What the misses are

Read from the agents' final messages and the recipe files in `runs/`.

1. **Go repos cannot be expressed (go-base, golang-gin-realworld-example-app, nethttp, and simplebank's endpoints, reads and writes).** The recipe format has rules for `typescript` and `text` only. In all 9 runs on go-base, gin and nethttp the agent said so and wrote either an empty recipe or tables from `CREATE TABLE` text. The tables written this way (go-base 3, gin 7) still scored 0 predicted, see 2. This is a missing capability of the engine's recipe format, not a prompt gap.
2. **Text rules need the `text-rules` helper, and `recipe check` does not say so.** 13 of the 19 recipes that use a `text` rule do not list `text-rules` in `helpers`; the check counted their matches, the index did not use them, and the tables scored 0 predicted. As a diagnostic only (not a run, not counted): adding `text-rules` and `method-classes` to the helpers of the fastify-typescript run 1 recipe, unchanged otherwise, scores tables, reads and writes 100/100 on that repo, against 0 in the run. The same shape (a rule that the check accepts and counts, an index that produces nothing) explains bun-fastify-starter-turbo-monorepo, saasfly's tables and most 0/100 table scores. `method-classes` is missing in 3 of the 12 recipes whose `read`/`write` emits carry a `method` field (fastify-typescript runs 1 and 3, next-js-boilerplate run 3); counted with `jq` over `runs/*/run*/recipe.json`, and the 13 of 19 above the same way (19 recipes have a rule with `"language": "text"`, 13 of them lack `text-rules` in `helpers`).
3. **`recipe check` shows match counts only (a known gap, confirmed).** Agents repeatedly wrote that they had not seen the nodes the recipe produces ("I didn't run the engine to list the produced nodes", "I couldn't confirm that without the engine's output"). Both failures in 2 and the bulletproof-react rule that matched nothing (`files` globs the agent could not debug) were invisible or opaque to them.
4. **File-system routes (epic-stack, saasfly, bulletproof-react).** Routes were 0 in 8 of 9 runs on these three; the one exception scored 1 of 10. The agent listed `fs-routes` but, as it wrote, never saw what it produced; epic-stack's `react-router-auto-routes` is not a convention the helper knows. Endpoints on epic-stack: 0 of 18 in all three runs. Next.js is exercised only by next-js-boilerplate (no routes labelled) and saasfly (routes, endpoints and tables all 0).
5. **NestJS (nestjs-boilerplate).** The decorator controllers were not expressed in any run (0 endpoint, no endpoint labels in that repo), reads and writes through `@InjectRepository` and `@InjectModel` were not found in two of three runs, and the one run that produced them (run 2) had precision 60 to 75 and tables at 63.
6. **Express with Mongoose (express-mongodb-rest-api-boilerplate).** Stable in all three runs: tables 100/100; reads 42 and writes 64 recall (the fixed recipe gets 50 and 82), so the Bar passes on tables only.
7. **Variance.** Table scores for simplebank (2 of 3 runs), nestjs-boilerplate and epic-stack changed between runs of the same repo, which is what the Bar's worst-of-3 reading charges for; the only repo identical across all runs with nonzero scores is express-mongodb-rest-api-boilerplate.
8. **A runner prompt defect.** The runner told the agent to run `recipe check .gantry/recipe.json .`; the check takes one file argument and rejects the extra `.` ("too many arguments"). The agents (seen in the nethttp and simplebank final messages) dropped it and carried on. No run was repeated, since the runs are as made; it cost turns, not scores, as far as the transcripts show.

## Known gaps stated in the brief, with what the runs show

- **Routes and endpoints** were not exercised by the spot test. Here: routes 0 to 10% recall and endpoints 0% recall on every run of every repo that labels them (bulletproof-react, epic-stack, saasfly, go-base, gin, nethttp). Neither kind reached the Bar in any run.
- **Next.js, NestJS and Go** were not exercised by the spot test. Here: next-js-boilerplate passes (3 of 3, but its labels hold only 1 table, 1 read and 1 write); saasfly scores 0; NestJS passes tables in 2 of 3 runs but never reads and writes at the Bar; Go scores 0 in every run.
- **`recipe check` shows the agent only match counts.** Confirmed as a cause of the misses in 2 and 3 above. It was not changed.

## Verdict

**Bar missed: 2 of 12 repos on the worst of 3 runs (10 needed).** The decision in the issue stands: agent-written recipes stay on hold, and the agent issues (#204, #205, #210, #213) and the built-in adapters stay as they are. What the numbers say, without extrapolating: the agent writes recipes the check accepts in nearly every run (36 of 36 produced a recipe file that was scored), but accepting a recipe and the index using it are not the same thing today; the largest losses are the Go repos (no Go rules), recipes whose text rules the index ignores, and file-system routes. Whether to give the check a way to show produced nodes, list the helpers a rule needs, or add Go rules is for the maintainer; none of it was tried here.

## Files

- `docs/spikes/v2-recipe-agent-2/`: `run.ts`, `agent.md`, `prompt.md`, `results.json` (all 36 runs, sorted keys, no timestamps), `runs/<repo>/run<k>/{recipe.json,result.json,final.txt}`. The stream-json transcripts stay out of the repository.
- `evals/oss/labels/README.md`: label conventions, written before the runs.
