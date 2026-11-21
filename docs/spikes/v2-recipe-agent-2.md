# Spike: the recipe agent, re-measured on the real engine (#350)

## Result against the Bar

**The Bar is missed: 2 of 12 repos pass on the worst of 3 runs; the Bar needs at least 10.**

The Bar is the one in `docs/spikes/v2-recipe-agent.md` (#245), unchanged: a repo passes when every scored kind among routes, endpoints and tables reaches at least 90% recall at 95% precision in each of its three runs. The two passing repos are `express-mongodb-rest-api-boilerplate` (tables only, 7 labelled) and `next-js-boilerplate` (tables 1, plus reads and writes). If reads and writes are scored as well, which the Bar does not ask for, only `next-js-boilerplate` passes: 1 of 12. By run, 9 of the 36 runs pass the Bar (3 of 36 with reads and writes).

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

Recall/precision in percent. r routes, e endpoints, t tables, rd reads, wr writes. Only kinds the repo's labels contain are scored. A kind with 0 predicted shows as 0/100 (the scorer's precision for no predictions).

| Repo@sha7                                    | Labels            | Run 1                             | Run 2                             | Run 3                             | Worst of 3                        | Bar | Bar incl. rd/wr |
| -------------------------------------------- | ----------------- | --------------------------------- | --------------------------------- | --------------------------------- | --------------------------------- | --- | --------------- |
| bulletproof-react@9506629                    | r 10              | r 0/100                           | r 0/100                           | r 10/100                          | r 0/100                           | no  | no              |
| bun-fastify-starter-turbo-monorepo@774fcfe   | t 2, rd 1, wr 2   | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | no  | no              |
| epic-stack@893610d                           | r 30, e 18, t 11  | r 0/100, e 0/100, t 100/100       | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | no  | no              |
| express-mongodb-rest-api-boilerplate@0ed1f89 | t 7, rd 12, wr 11 | t 100/100, rd 42/100, wr 64/100   | t 100/100, rd 42/100, wr 64/100   | t 100/100, rd 42/100, wr 64/100   | t 100/100, rd 42/100, wr 64/100   | yes | no              |
| fastify-typescript@3e195bf                   | t 2, rd 2, wr 2   | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | no  | no              |
| go-base@5f852fd                              | e 19, t 3         | e 0/100, t 0/100                  | e 0/100, t 0/100                  | e 0/100, t 0/100                  | e 0/100, t 0/100                  | no  | no              |
| golang-gin-realworld-example-app@a41289b     | e 20, t 7         | e 0/100, t 0/100                  | e 0/100, t 0/100                  | e 0/100, t 0/100                  | e 0/100, t 0/100                  | no  | no              |
| nestjs-boilerplate@9620f15                   | t 5, rd 6, wr 6   | t 100/100, rd 0/100, wr 0/100     | t 100/63, rd 100/60, wr 100/75    | t 0/100, rd 0/100, wr 0/100       | t 0/63, rd 0/60, wr 0/75          | no  | no              |
| nethttp@63ead0d                              | e 5               | e 0/100                           | e 0/100                           | e 0/100                           | e 0/100                           | no  | no              |
| next-js-boilerplate@b83157a                  | t 1, rd 1, wr 1   | t 100/100, rd 100/100, wr 100/100 | t 100/100, rd 100/100, wr 100/100 | t 100/100, rd 100/100, wr 100/100 | t 100/100, rd 100/100, wr 100/100 | yes | yes             |
| saasfly@49f7e28                              | r 14, e 5, t 6    | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | r 0/100, e 0/100, t 0/100         | no  | no              |
| simplebank@97f000f                           | t 6, rd 5, wr 6   | t 100/100, rd 0/100, wr 0/100     | t 100/100, rd 0/100, wr 0/100     | t 0/100, rd 0/100, wr 0/100       | t 0/100, rd 0/100, wr 0/100       | no  | no              |

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

## What the misses are

Read from the agents' final messages and the recipe files in `runs/`.

1. **Go repos cannot be expressed (go-base, golang-gin-realworld-example-app, nethttp, and simplebank's endpoints, reads and writes).** The recipe format has rules for `typescript` and `text` only. In all 9 runs on go-base, gin and nethttp the agent said so and wrote either an empty recipe or tables from `CREATE TABLE` text. The tables written this way (go-base 3, gin 7) still scored 0 predicted, see 2. This is a missing capability of the engine's recipe format, not a prompt gap.
2. **Text rules need the `text-rules` helper, and `recipe check` does not say so.** 13 of the 19 recipes that use a `text` rule do not list `text-rules` in `helpers`; the check counted their matches, the index did not use them, and the tables scored 0 predicted. As a diagnostic only (not a run, not counted): adding `text-rules` and `method-classes` to the helpers of the fastify-typescript run 1 recipe, unchanged otherwise, scores tables, reads and writes 100/100 on that repo, against 0 in the run. The same shape (a rule that the check accepts and counts, an index that produces nothing) explains bun-fastify-starter-turbo-monorepo, saasfly's tables and most 0/100 table scores. `method-classes` is missing in 6 of the 20 recipes with `read`/`write` emits that name a method.
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
