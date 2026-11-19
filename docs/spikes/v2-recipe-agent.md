# Spike: does the recipe agent write working recipes unaided across stacks?

V2 plan, M9 "Recipes by agent". Question: given a recipe engine, the generic helpers and a discovery prompt, does a real Claude Code subagent write working recipes unaided on 12 public repos (8 TypeScript, 4 Go), how stable are its recipes across three runs, what does a run cost, and does an on-request re-run extend a recipe without losing nodes?

## Result against the Bar

**The Bar is not met: 2 of 12 repos pass, the Bar needs at least 10.** A repo passes when every scored kind (routes, endpoints, tables) reaches at least 90% recall at 95% precision in each of its three runs. Measured on the final prompt (v2): bun-fastify-starter-turbo-monorepo and next-js-boilerplate pass; the other 10 miss on their worst run. On the first prompt (v1, the baseline) 1 of 12 passed (golang-gin-realworld-example-app). Per run, 12 of the 36 v2 runs pass (9 of 36 for v1).

**The on-request re-run loses 0 existing nodes in 3 of 3 repetitions** and finds all 7 new nodes (5 Express endpoints, 2 Prisma tables) each time. That half of the Bar is met, on one synthetic fixture.

The spike's own rule applies: on a miss the orchestrator stops M9 and asks the maintainer. The verdict is at the end.

## Setup

- Model of every agent run: `claude-sonnet-5-5` (read from the stream of each run; the agent definition says `model: sonnet`, effort `medium`). Claude Code 2.1.328, headless `claude -p`, no API key (the logged-in account). Machine: Apple M3 Pro, macOS arm64, Node v26.13.0, pnpm 10.31.0. Four runs in parallel, so wall times include contention (load average 6 to 13 while running).
- Code base: branch `gantry/245-spike-recipe-agent` on `origin/main` at `7ce5568`. Engine dependencies: `@ast-grep/napi` 0.51.3 and `@ast-grep/lang-go` 0.0.6, exact pins, installed with `npm install --no-audit --no-fund` in `docs/spikes/v2-recipe-agent/` (own `package.json`, not in the pnpm workspace).
- Repos: the 12 pinned in `evals/oss/repos.json` with role `tuning`, cloned by `pnpm eval:clone` into `~/Dev/gantry-oss/<name>@<sha7>`. All 12 listed SHAs were available and each repo uses the stack listed for it; none was replaced.
- Labels: `evals/oss/labels/<name>.json`, 12 files, written by labeller subagents (not the recipe agent) by `rg` enumeration and reading each site, and committed before the first agent run (commit `d5cb5fc`; the first `runs` directory comes in a later commit). The labels were not changed after any run. Labelling conventions: a route is a frontend page URL; an endpoint is method + full path (`ALL` when no method is restricted); a table is the explicit name in code, else the model or class name; tests, mocks, generated code and tRPC/GraphQL procedures are excluded. Label counts are in Table 1 (routes/endpoints/tables).
- Files in the pipeline:
  - `engine.ts`: `docs/spikes/v2-recipes/engine.ts` copied and extended with per-rule `examples: { match, noMatch }` (checked before a recipe is accepted), zero-match warnings, `text` (regex) rules for `.prisma` and `.sql`, a `table` emit, `pathFromFile` (file-system routes and Next.js route handlers), `ancestorPrefix` (decorator prefix of the enclosing class), `prefix`, `splitMethod` (`"GET /x"` strings), named functions as mount scopes, and `$$$` children of a mount. `check.ts` validates structure and examples, `cli.ts` is the agent's dry-run (`dry-run`) and the runner's `index`.
  - `prompt.md` and `agent.md`: the discovery prompt and the agent definition in the describer's frontmatter format (`model`, `effort`, `tools`, `background`, `maxTurns`). The runner fills the prompt and the dry-run command into `agent.md` and writes it to `.claude/agents/recipe-agent.md` in a fresh copy of the clone (without `.git`).
  - `run.ts`: per repo three runs, each `claude -p --agent recipe-agent --output-format stream-json` in the fresh copy; records model id, turns, tokens, wall time, recipe sha256, graph sha256; scores with `pnpm eval:score`-equivalent (`scripts/eval-score.ts <name> --dump <dump> --labels <labels>`); writes `results.json`. `rerun.ts`, `gaps.ts`: the on-request re-run. `report.ts`: generates Tables 1 to 3 from `results.json` and `rerun.json`.
- Permissions of a run: tools `Read`, `Grep`, `Glob`, `Write` limited to `.gantry/recipe.json`, and `Bash` limited to the dry-run command (permission rules passed by the runner, `--strict-mcp-config`, `--setting-sources project`, slash commands off).
- Tokens: "in" is input tokens as the CLI reports them summed (uncached + cache creation + cache reads; cache reads are about 91% of it); "out" is output tokens. The CLI's own cost estimate is stored per run in `results.json` and is not used for any number below.

## How the runs went

- Prompt v1 (baseline): 36 runs, results in `results-baseline.json` and `runs-baseline/`. Prompt v2 plus engine v2 (below): 36 runs, results in `results.json` and `runs/`. On-request re-run: 3 repetitions, 6 agent runs, `rerun.json` and `runs-rerun/`. Pilot runs of the mechanics on `fixtures/pnpm-turbo` before the baseline: 4 runs (3 were blocked by a permission-rule mistake of mine and wrote nothing, the fourth wrote an accepted recipe); not scored, not counted in the tables.
- **Interrupted runs.** The first attempt at the 36 v2 runs hit the account's 5-hour usage limit after the 12 first runs had finished. 24 runs (runs 2 and 3 of all 12 repos, listed in `interrupted-round2.txt`) ended after one turn with "You've hit your 5-hour limit"; they produced nothing, were recorded as interrupted, their folders were removed and exactly those 24 were re-run after the limit reset. No finished run was redone. They are not agent failures and are not in the tables.
- **Failed runs.** One of the 72 scored runs failed: saasfly run 1 under v2 (the agent's final recipe had no `helpers` array, the engine rejected it; it scores 0 on every kind). Under v1 no run failed. No run hit the turn limit.

## Table 1 (prompt v2, the final result)

Recall/precision in percent per kind (r routes, e endpoints, t tables). "Worst of 3" is the minimum recall and the minimum precision over the three runs, per kind. Turns, tokens and wall time are run 1 / run 2 / run 3.

| Repo@sha7                                    | Stack                         | Files | Labels r/e/t | Run 1                           | Run 2                           | Run 3                           | Worst of 3                      | Pass | Turns        | Tokens in / out                                        | Wall              |
| -------------------------------------------- | ----------------------------- | ----: | ------------ | ------------------------------- | ------------------------------- | ------------------------------- | ------------------------------- | ---- | ------------ | ------------------------------------------------------ | ----------------- |
| bulletproof-react@9506629                    | react-router, nextjs          |   415 | 10/0/0       | r 100/100                       | r 100/91                        | r 100/91                        | r 100/91                        | no   | 13 / 10 / 13 | 193.7k / 123.4k / 142.7k in; 8.2k / 5.5k / 7.0k out    | 65s / 48s / 52s   |
| bun-fastify-starter-turbo-monorepo@774fcfe   | fastify, kysely               |    70 | 0/2/2        | e 100/100, t 100/100            | e 100/100, t 100/100            | e 100/100, t 100/100            | e 100/100, t 100/100            | yes  | 10 / 17 / 19 | 139.6k / 265.5k / 182.3k in; 5.8k / 7.6k / 7.1k out    | 45s / 70s / 56s   |
| epic-stack@893610d                           | react-router, express, prisma |   155 | 30/18/11     | r 100/100, e 83/100, t 100/100  | r 100/100, e 78/100, t 100/100  | r 100/100, e 78/100, t 100/100  | r 100/100, e 78/100, t 100/100  | no   | 14 / 12 / 13 | 217.8k / 145.0k / 170.7k in; 9.2k / 7.7k / 9.8k out    | 78s / 62s / 76s   |
| express-mongodb-rest-api-boilerplate@0ed1f89 | express, mongoose             |   126 | 0/26/7       | e 81/100, t 100/100             | e 88/88, t 100/100              | e 88/100, t 100/100             | e 81/88, t 100/100              | no   | 27 / 16 / 22 | 509.6k / 270.4k / 350.9k in; 15.2k / 9.2k / 11.8k out  | 125s / 76s / 98s  |
| fastify-typescript@3e195bf                   | fastify, prisma               |    15 | 0/5/2        | e 100/100, t 100/100            | e 100/100, t 100/100            | e 100/100, t 50/50              | e 100/100, t 50/50              | no   | 15 / 16 / 9  | 179.6k / 174.4k / 97.5k in; 8.1k / 6.8k / 4.5k out     | 61s / 62s / 45s   |
| go-base@5f852fd                              | chi                           |    42 | 0/19/3       | e 11/13, t 100/100              | e 11/13, t 100/100              | e 11/13, t 100/100              | e 11/13, t 100/100              | no   | 7 / 9 / 9    | 84.4k / 97.1k / 106.9k in; 2.9k / 3.9k / 3.2k out      | 31s / 40s / 34s   |
| golang-gin-realworld-example-app@a41289b     | gin, gorm                     |    21 | 0/20/7       | e 100/100, t 100/100            | e 100/100, t 100/100            | e 100/100, t 86/100             | e 100/100, t 86/100             | no   | 18 / 21 / 26 | 287.5k / 317.6k / 470.3k in; 13.4k / 13.7k / 18.2k out | 102s / 97s / 127s |
| nestjs-boilerplate@9620f15                   | nestjs, typeorm, mongoose     |   184 | 0/22/8       | e 0/0, t 100/100                | e 100/100, t 100/100            | e 100/96, t 100/80              | e 0/0, t 100/80                 | no   | 20 / 16 / 34 | 286.3k / 191.6k / 619.3k in; 11.7k / 9.2k / 18.1k out  | 93s / 69s / 147s  |
| nethttp@63ead0d                              | net-http                      |    11 | 0/5/0        | e 100/83                        | e 100/83                        | e 100/83                        | e 100/83                        | no   | 12 / 12 / 9  | 100.8k / 98.9k / 68.7k in; 4.5k / 3.9k / 2.9k out      | 38s / 39s / 29s   |
| next-js-boilerplate@b83157a                  | nextjs, drizzle               |    62 | 9/1/1        | r 100/100, e 100/100, t 100/100 | r 100/100, e 100/100, t 100/100 | r 100/100, e 100/100, t 100/100 | r 100/100, e 100/100, t 100/100 | yes  | 11 / 10 / 7  | 99.1k / 81.7k / 58.5k in; 4.1k / 3.4k / 3.1k out       | 41s / 31s / 25s   |
| saasfly@49f7e28                              | nextjs, kysely, prisma        |   202 | 14/5/6       | r 0/100, e 0/100, t 0/100       | r 100/100, e 80/67, t 100/100   | r 100/100, e 100/71, t 100/100  | r 0/100, e 0/67, t 0/100        | no   | 15 / 12 / 13 | 137.8k / 106.2k / 148.5k in; 5.0k / 4.3k / 5.7k out    | 47s / 38s / 49s   |
| simplebank@97f000f                           | gin, sqlc, database-sql       |    77 | 0/8/6        | e 38/100, t 100/100             | e 88/100, t 100/100             | e 88/100, t 100/100             | e 38/100, t 100/100             | no   | 8 / 14 / 15  | 58.5k / 163.9k / 162.4k in; 2.2k / 6.7k / 6.1k out     | 23s / 58s / 60s   |

Repos passing on the worst of 3 runs: 2 of 12.
Runs: 36; failed runs (no accepted recipe or error): 1; turns 524; input tokens 6909516 (of which cache reads 6286990); output tokens 269736; wall 2237 s summed (concurrency 4); models: claude-sonnet-5-5.

### Table 2: stability per repo

| Repo                                 | Recipes identical | Graphs identical | What differed                                                                                     |
| ------------------------------------ | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| bulletproof-react                    | no                | no               | rule ids (11/3/3 rules); patterns or emits; predicted nodes per run 10 / 11 / 11                  |
| bun-fastify-starter-turbo-monorepo   | no                | yes              | rule ids (6/3/6 rules); helpers; patterns or emits; predicted nodes per run 2+2 / 2+2 / 2+2       |
| epic-stack                           | no                | no               | rule ids (3/3/3 rules); patterns or emits; predicted nodes per run 30+15+11 / 30+14+11 / 30+14+11 |
| express-mongodb-rest-api-boilerplate | no                | no               | rule ids (7/7/7 rules); patterns or emits; predicted nodes per run 21+7 / 26+7 / 23+7             |
| fastify-typescript                   | no                | no               | rule ids (5/5/4 rules); patterns or emits; predicted nodes per run 5+2 / 5+2 / 5+2                |
| go-base                              | no                | yes              | rule ids (6/6/6 rules); helpers; patterns or emits; predicted nodes per run 15+3 / 15+3 / 15+3    |
| golang-gin-realworld-example-app     | no                | no               | rule ids (9/9/9 rules); patterns or emits; predicted nodes per run 20+7 / 20+7 / 20+6             |
| nestjs-boilerplate                   | no                | no               | rule ids (4/5/5 rules); patterns or emits; predicted nodes per run 19+8 / 22+8 / 23+10            |
| nethttp                              | no                | yes              | rule ids (4/3/2 rules); helpers; patterns or emits; predicted nodes per run 6 / 6 / 6             |
| next-js-boilerplate                  | no                | yes              | patterns or emits; predicted nodes per run 9+1+1 / 9+1+1 / 9+1+1                                  |
| saasfly                              | no                | no               | rule ids (3/3/4 rules); patterns or emits; predicted nodes per run 0+0+0 / 14+6+6 / 14+7+6        |
| simplebank                           | no                | no               | rule ids (3/4/4 rules); patterns or emits; predicted nodes per run 3+6 / 7+6 / 7+6                |

Repos with three identical recipe files: 0 of 12. Repos with three identical graphs: 4 of 12.

### Table 3: on-request re-run on a copy of `fixtures/pnpm-turbo`

| Rep | Nodes before | Added | Lost | New found / expected | Gaps given (dep / route-site / sql-site) | Gaps left (dep / route-site / sql-site) | Notes |
| --- | -----------: | ----: | ---: | -------------------- | ---------------------------------------- | --------------------------------------- | ----- |
| 1   |            7 |     7 |    0 | 7 / 7                | 14 (7 / 6 / 1)                           | 1 (0 / 1 / 0)                           |       |
| 2   |            7 |     7 |    0 | 7 / 7                | 13 (6 / 6 / 1)                           | 1 (0 / 1 / 0)                           |       |
| 3   |            7 |     7 |    0 | 7 / 7                | 14 (7 / 6 / 1)                           | 1 (0 / 1 / 0)                           |       |

Table 2 reads: "recipes identical" compares the three recipe files byte for byte (sha256); "graphs identical" compares the sha256 of the sorted route, endpoint and table nodes each run produced. Table 3 is the on-request re-run on a copy of `fixtures/pnpm-turbo`: "nodes before" is what the agent's own first recipe finds on the original fixture (3 routes, 2 endpoints, 2 tables), "added" is what the second run's recipe finds that the first did not, "lost" is nodes of the first set that the second recipe no longer finds, "gaps given" is what the deterministic detector listed after the Express app and the Prisma schema were added, and "gaps left" is what it lists after the second run (a gap the agent dismisses in the recipe is not listed).

## Cost of a run

Measured means over the 36 scored runs of each prompt version (all four runs in parallel):

|           | Turns | Input tokens | Output tokens | Wall time |
| --------- | ----: | -----------: | ------------: | --------: |
| Prompt v1 |  15.9 |       199.6k |          8.3k |    66.6 s |
| Prompt v2 |  14.6 |       191.9k |          7.5k |    62.1 s |

Totals: v1 571 turns, 7,185,417 input tokens (6,581,116 cache reads), 298,587 output tokens; v2 524 turns, 6,909,516 input tokens (6,286,990 cache reads), 269,736 output tokens; the six re-run agent runs 61 turns, 577,861 input, 26,930 output. Together 14,672,794 input and 595,253 output tokens over 78 measured runs, all on `claude-sonnet-5-5`. The 4 pilot runs are not in these totals. A run is about a minute of wall time and 7 to 34 turns; the agent called the dry-run 177 times in 36 v2 runs (200 in v1).

## What changed between the runs, with before and after

The v1 result (1 of 12) was analysed, and four generic changes were made before the v2 runs; no change was made after seeing v2 scores. The engine and prompt changes went in together, so their effects are not separable.

Prompt v2 (diff in git, `prompt.md`):

1. A catch-all segment (`[...slug]`, `[[...slug]]`, `$`, `*`) is written `*`, with a `rewrite` example; the scorer treats `:param` and `*` as different. Cause in v1: next-js-boilerplate, saasfly, epic-stack (routes) wrote `:param` where the labels have `*`.
2. Table naming: take the name from the code definition, not from a migration; Kysely interface keys win. Cause in v1: bun-fastify (`user_providers` for `userProviders`), fastify-typescript (`user` for `users`), nestjs.
3. TypeScript pitfalls: `@Get($P)` does not match `@Get()`; decorators before `export class` belong to the export statement; tsconfig aliases resolve; `.js` imports resolve to `.ts`.
4. `child: "$$$C"` mounts every captured argument.

Engine v2: tsconfig `paths` and `baseUrl` in the import resolver (no `extends`), `.js` to `.ts` resolution, `$$$` mount children, `ancestorPrefix` also searches the export statement.

Before and after, worst of 3 runs (v1 table is in the appendix below):

| Repo                                                                | v1 worst run                  | v2 worst run                                                 |
| ------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------ |
| next-js-boilerplate                                                 | r 67/67, e 100/100, t 100/100 | all 100/100 (pass)                                           |
| bun-fastify-starter-turbo-monorepo                                  | e 50/50, t 50/50              | e 100/100, t 100/100 (pass)                                  |
| golang-gin-realworld-example-app                                    | all 100/100 (pass)            | t 86/100 (fail; run 3 left out `UserModel`)                  |
| nestjs-boilerplate                                                  | e 100/100, t 63/100           | e 0/0, t 100/80 (fail; run 1 lacked the `/api/v1` prefix)    |
| go-base                                                             | e 11/13                       | e 11/13                                                      |
| saasfly                                                             | r 79/79, e 40/33              | r 0/100, e 0/67 (run 1 failed; runs 2 and 3: routes 100/100) |
| fastify-typescript                                                  | t 50/50                       | t 50/50 (a different run each time)                          |
| bulletproof-react, epic-stack, express-mongodb, nethttp, simplebank | fail                          | fail                                                         |

Net effect: repos at the Bar 1 to 2 of 12; passing runs 9 to 12 of 36. The catch-all convention fixed next-js-boilerplate and the saasfly routes in the runs that completed. The table rule fixed bun-fastify but not fastify-typescript. One repo regressed (gin, in one of three runs), which shows the run-to-run spread of the agent, not an effect of the prompt.

## What the agent got wrong, per repo (v2, from the miss and extra lists in `runs/*/run*/result.json`)

- **bulletproof-react** (r 100/100 in run 1; runs 2 and 3: precision 91%): the agent also listed `/404`, the Next.js not-found page. The labeller did not count it. Everything labelled was found.
- **bun-fastify-starter-turbo-monorepo**: passes in all 3 runs. In v1 it composed no `/users` prefix in one run (`POST /email`), (cause not confirmed; the agent guessed an import alias or a plugin wrapper, the v2 engine resolves aliases).
- **epic-stack**: endpoints 78 to 83% recall in all 3 runs. Missed in every run: `GET /*`, `GET /img/*`, `GET /favicons/*`, which Express registers with a regex and an array of regexes as the path; missed in two runs: `ALL /admin/cache/sqlite`. Routes (30) and tables (11) were complete in every run, including the React Router file routes through `pathFromFile`.
- **express-mongodb-rest-api-boilerplate**: endpoints 81 to 88% recall. Missed in every run: the `express.static` mount (label `ALL /storage/public/conversions`) and two Swagger asset routes registered in a loop with a computed path. Run 1 also missed `GET` and `POST /auth/sign-out` (a `router.route(p).post(a).get(b)` chain). Run 2 listed `/`, `/config.json` and `/initializer.js` without the `/docs` prefix.
- **fastify-typescript**: run 3 named a table `user` where the Prisma `@@map` gives `users`. Runs 1 and 2 pass.
- **go-base**: endpoint recall 11% in all 3 runs (2 of 19 found; the others listed with the prefix missing, for example `GET /` for `GET /api/account`). The chi sub-routers are built by methods on struct fields (`a.Account.router()`, `NewResource(...).Router()`), which `call-return` cannot follow. In v1, one run found all 19.
- **golang-gin-realworld-example-app**: runs 1 and 2 pass; run 3 left out the table `UserModel`.
- **nestjs-boilerplate**: run 1 listed the endpoints without the global `/api/v1` prefix (recall 0%); run 2 passes; run 3 listed `GET /api/v1` and two plain classes, `RoleSchema` and `StatusSchema`, as tables (precision 80% for tables). `ancestorPrefix` for `@Controller()` worked in runs 2 and 3.
- **nethttp**: 100% recall and 83% precision in every run: the agent lists `mux.Handle("dreamsofcode.foo/", ...)` (a host pattern) as `ALL /dreamsofcode.foo`; the label has only `ALL /` for it. A labelling judgement, not a code misreading.
- **next-js-boilerplate**: passes in all 3 runs.
- **saasfly**: run 1 failed (no `helpers` array). Runs 2 and 3 listed the tRPC fetch adapter `route.ts` (`GET`/`POST /api/trpc/edge/:param`); the labeller excluded tRPC. Run 2 also missed the Nitro catch-all `ALL /*` of the auth proxy.
- **simplebank**: `ALL /swagger` (a `mux.Handle("/swagger/", ...)` registration in `main.go`) missed in every run; run 1 also missed 4 routes (`GET`/`POST /accounts`, `GET /accounts/:id`, `POST /transfers`). Causes not examined.

For four repos (bulletproof-react, nethttp, saasfly, fastify-typescript) the gap to the Bar is one or two nodes on which the label and the agent disagree on convention or on a different run's naming; that is a fact about the misses, not a claim that they would pass: the Bar counts them as fails, and the labels were not changed.

## Missing helpers

The helper set of `v2-recipes` plus the extensions of this spike was enough to express the stacks in the 2 passing repos and most of the others. The agent or the misses point at these missing or weak capabilities:

1. **Method and field resolution that follows types** (go-base): a mounted `x.Field.method()` or `NewT(...).Router()`. Generic, belongs to the Go language module's resolver.
2. **Non-literal registration paths**: regex and array paths (Express), static-file mounts, paths computed in a loop. They should be reported as unresolved sites with a reason (the engine does this only for non-literal strings).
3. **Chained registration on a route** (`router.route(p).post(a).get(b)`): `pathFromChain` covers `.get(p, a).post(b)` only.
4. **Global prefix and versioning as a recipe value** (NestJS `setGlobalPrefix`, URI versioning): the agent can write them as a literal `prefix`; one run did not.
5. **Table naming**: a recipe-stated rule from model name to table name (explicit map, snake case, plural), as the plan's data-access helpers list it. This spike scored only names stated in code.
6. **Authoring the file-system routes**: no framework-specific helper was needed. `pathFromFile` with `rewrite` expressed Next.js app routes and route handlers and React Router auto-routes (routes 100% recall in every v2 run that finished), but the agent has to write the segment rewrites itself.

Not built here and so not measured: SQL text and read/write edges, `requests` edges, any route kind other than the three scored.

## Plan assumptions checked

| Assumption                                                    | Verdict                 | Evidence                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 / M8.5: an agent can write the recipes unaided             | Not met against the Bar | 2 of 12 repos at the Bar (≥10 needed) on the worst of 3 runs; 12 of 36 runs pass. Per kind most runs are close, and the misses are listed above                                                                                                                                                                 |
| M8.4: the agent runs as a Claude Code subagent, no API key    | Confirmed               | 78 `claude -p` runs with the agent definition, no API key, model `claude-sonnet-5-5`; needs `Write` for the recipe file and one `Bash` command in the permission rules                                                                                                                                          |
| M8.6: examples must pass, zero matches are a warning          | Confirmed as workable   | The agent wrote examples for every rule and revised on the dry-run's failures; 71 of 72 scored recipes were accepted; 3 of the 72 recipes had zero-match rules, all shown as warnings. This does not show that examples catch wrong patterns (a pattern that matches its own example but the wrong site passes) |
| M8.2: same repo and same recipe give the same graph           | Not tested here         | No repeated engine runs on one recipe were made in this spike                                                                                                                                                                                                                                                   |
| The recipe is stable across agent runs                        | Refuted                 | 0 of 12 repos with three identical recipe files (v1 and v2); identical graphs in 4 of 12 (v2) and 6 of 12 (v1); rule counts differ between runs of one repo (for example 11, 3, 3 rules for bulletproof-react)                                                                                                  |
| An on-request re-run extends a recipe without losing nodes    | Confirmed, small sample | 0 nodes lost and 7 of 7 new nodes found in 3 of 3 repetitions on one fixture with 5 endpoints and 2 tables added; 13 to 14 gaps given, 1 left (`app.use` mount, not dismissed)                                                                                                                                  |
| M8.9: re-run only when manifest framework dependencies change | Unchanged               | The re-run started from the gaps; the detector's dependency gaps (6 or 7 per repetition) were all classified or dismissed by the agent                                                                                                                                                                          |
| M8.11: evals for Next.js, Fastify, NestJS, net/http           | Run now                 | Next.js (3 repos), Fastify (2), NestJS, net/http, chi, gin, Express and React Router are scored; echo and fiber are not                                                                                                                                                                                         |

## Deviations from the issue

- **Prompt and engine were changed once after the baseline**, with both result sets reported (the issue asks for every prompt change with before and after scores). The v2 result is the one the Bar is read from. If the baseline were used instead, the result is 1 of 12.
- **The agent has `Write`, limited to `.gantry/recipe.json`**, besides `Read`, `Grep`, `Glob` and the dry-run: read-only file tools alone cannot return a recipe file. The runner states the limit as permission rules rather than in the agent file's `tools` line.
- **`tanstack-file-routes`** is in the engine's helper type but unavailable here (it wraps `core` code); the prompt tells the agent to ignore it.
- **Tables** are found by text rules and AST rules only; the data-access prototype of the other spike had not landed. SQL text and read/write edges were not built.
- **Labelling:** by subagents under written conventions, not by the spike author; tRPC and GraphQL procedures and mocks excluded; trailing-slash variants, `/docs` and `/docs/`, and `Group("/")` variants labelled once because the scorer treats them as one key; where migrations and models both exist the labeller chose one source (go-base and simplebank: migrations; fastify and the bun repo: the Kysely interface and `@@map`). These choices decided some scores (see nethttp, saasfly, bulletproof-react above).
- **Gap detection** (`gaps.ts`) is a spike approximation of the plan's three gap types; the "client call with no matching endpoint" type was not built (the issue lists three gap types, and these are the three used: dependency, route site, SQL site).
- **Eval scoring** is `scripts/eval-score.ts` called by the runner with `--dump` and `--labels`, the same entry `pnpm eval:score` runs.
- **Wall times** are under four parallel runs on one machine and are noisy.
- A scratch directory with run transcripts was cleaned up by the machine after the round-2 interruption; transcripts are not committed in any case (they contain third-party code). Committed per run: recipe, dump, result, the agent's final message.

## Verdict

**No-go against the Bar as written: 2 of 12 repos pass on the worst of 3 runs (the Bar needs 10), on the final prompt, and 1 of 12 on the first.** The on-request half passes (0 nodes lost, 3 of 3). Following the issue, the orchestrator stops M9 and asks the maintainer.

What the measurements say for that decision, without extrapolating: the agent finds the stack and writes accepted recipes in nearly every run (71 of 72 scored recipes accepted) and it gets file-system routes, route handlers, decorator-based controllers and most tables right; it fails the Bar mostly through single-run variance (one run in three differs: gin, fastify-typescript, nestjs, saasfly, bulletproof-react), through weak helper coverage (go-base's chi struct-method routers; Express regex, static and loop registrations; chained `route()`), and through label conventions on which the agent and the labeller disagree (nethttp host pattern, `/404`, tRPC). The recipes are never identical across runs (0 of 12), the graphs only sometimes (4 of 12). Whether to continue with changed helpers, a stricter scoring convention, a best-of-three or a repair loop, or to change the plan, is the maintainer's call.

## Appendix: Table 1 for prompt v1 (baseline)

### Table 1: scores per repo (recall/precision in percent per kind: r routes, e endpoints, t tables)

| Repo@sha7                                    | Stack                         | Files | Labels r/e/t | Run 1                         | Run 2                         | Run 3                         | Worst of 3                    | Pass | Turns        | Tokens in / out                                        | Wall               |
| -------------------------------------------- | ----------------------------- | ----: | ------------ | ----------------------------- | ----------------------------- | ----------------------------- | ----------------------------- | ---- | ------------ | ------------------------------------------------------ | ------------------ |
| bulletproof-react@9506629                    | react-router, nextjs          |   415 | 10/0/0       | r 100/100                     | r 100/91                      | r 100/91                      | r 100/91                      | no   | 8 / 17 / 18  | 69.2k / 220.3k / 240.1k in; 3.8k / 8.6k / 9.7k out     | 35s / 69s / 75s    |
| bun-fastify-starter-turbo-monorepo@774fcfe   | fastify, kysely               |    70 | 0/2/2        | e 50/50, t 100/100            | e 100/100, t 50/50            | e 100/100, t 100/100          | e 50/50, t 50/50              | no   | 15 / 26 / 19 | 212.2k / 331.7k / 285.0k in; 8.8k / 13.9k / 12.8k out  | 72s / 104s / 102s  |
| epic-stack@893610d                           | react-router, express, prisma |   155 | 30/18/11     | r 97/97, e 78/100, t 100/100  | r 97/97, e 78/100, t 100/100  | r 97/97, e 78/100, t 100/100  | r 97/97, e 78/100, t 100/100  | no   | 15 / 16 / 23 | 188.3k / 230.0k / 288.6k in; 6.6k / 8.2k / 12.1k out   | 62s / 74s / 103s   |
| express-mongodb-rest-api-boilerplate@0ed1f89 | express, mongoose             |   126 | 0/26/7       | e 88/100, t 100/100           | e 88/100, t 100/100           | e 88/100, t 100/100           | e 88/100, t 100/100           | no   | 12 / 15 / 21 | 168.2k / 209.6k / 341.2k in; 6.5k / 7.9k / 12.1k out   | 52s / 62s / 90s    |
| fastify-typescript@3e195bf                   | fastify, prisma               |    15 | 0/5/2        | e 100/100, t 100/100          | e 100/100, t 50/50            | e 100/100, t 100/100          | e 100/100, t 50/50            | no   | 9 / 9 / 29   | 94.4k / 93.2k / 440.9k in; 5.0k / 4.3k / 17.3k out     | 40s / 35s / 128s   |
| go-base@5f852fd                              | chi                           |    42 | 0/19/3       | e 11/13, t 100/100            | e 11/13, t 100/100            | e 100/100, t 100/100          | e 11/13, t 100/100            | no   | 8 / 13 / 10  | 103.3k / 115.8k / 133.8k in; 4.1k / 4.4k / 7.2k out    | 36s / 42s / 56s    |
| golang-gin-realworld-example-app@a41289b     | gin, gorm                     |    21 | 0/20/7       | e 100/100, t 100/100          | e 100/100, t 100/100          | e 100/100, t 100/100          | e 100/100, t 100/100          | yes  | 23 / 20 / 21 | 351.2k / 295.7k / 408.4k in; 15.1k / 14.4k / 14.0k out | 108s / 106s / 104s |
| nestjs-boilerplate@9620f15                   | nestjs, typeorm, mongoose     |   184 | 0/22/8       | e 100/100, t 100/100          | e 100/100, t 63/100           | e 100/100, t 63/100           | e 100/100, t 63/100           | no   | 25 / 24 / 20 | 368.1k / 324.6k / 279.5k in; 17.8k / 13.6k / 12.5k out | 126s / 98s / 94s   |
| nethttp@63ead0d                              | net-http                      |    11 | 0/5/0        | e 100/83                      | e 100/83                      | e 100/83                      | e 100/83                      | no   | 20 / 7 / 14  | 161.4k / 54.9k / 122.9k in; 7.5k / 2.1k / 5.0k out     | 64s / 22s / 45s    |
| next-js-boilerplate@b83157a                  | nextjs, drizzle               |    62 | 9/1/1        | r 67/67, e 100/100, t 100/100 | r 67/67, e 100/100, t 100/100 | r 67/67, e 100/100, t 100/100 | r 67/67, e 100/100, t 100/100 | no   | 8 / 12 / 11  | 52.3k / 101.9k / 91.1k in; 2.3k / 4.1k / 3.6k out      | 22s / 37s / 32s    |
| saasfly@49f7e28                              | nextjs, kysely, prisma        |   202 | 14/5/6       | r 79/79, e 40/33, t 100/100   | r 79/79, e 40/33, t 100/100   | r 79/79, e 40/33, t 100/100   | r 79/79, e 40/33, t 100/100   | no   | 15 / 12 / 18 | 135.2k / 117.0k / 147.3k in; 5.6k / 4.2k / 6.0k out    | 51s / 39s / 51s    |
| simplebank@97f000f                           | gin, sqlc, database-sql       |    77 | 0/8/6        | e 88/64, t 100/100            | e 88/100, t 100/100           | e 88/100, t 100/100           | e 88/64, t 100/100            | no   | 13 / 11 / 14 | 137.2k / 110.8k / 160.2k in; 6.6k / 5.0k / 6.1k out    | 57s / 46s / 59s    |

Repos passing on the worst of 3 runs: 1 of 12.
Runs: 36; failed runs (no accepted recipe or error): 0; turns 571; input tokens 7185417 (of which cache reads 6581116); output tokens 298587; wall 2398 s summed (concurrency 4); models: claude-sonnet-5-5.
