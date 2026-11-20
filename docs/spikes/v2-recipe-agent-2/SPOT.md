# Spot test: recipe agent runner on the real engine

Part of #350. This is not the measurement. It proves the runner works on the real engine and gives a first look. Two single runs are not held to the bar and decide nothing.

## What was run

- Runner: `docs/spikes/v2-recipe-agent-2/run.ts` (`--repos <names> --runs <n> --jobs <n>`; the full set runs unchanged with all 12 tuning repos and `--runs 3`).
- Agent: Claude Code headless (`claude -p`, no API key), agent definition `agent.md` with `model: sonnet`, `effort: medium`, `maxTurns: 80`, as in the first spike. Model id reported by the run: `claude-sonnet-5-5`.
- Tools: `Read`, `Grep`, `Glob`, `Write` for `.gantry/recipe.json` only, and one command, the product's own `node plugin/dist/cli.js recipe check`, run in a copy of the pinned clone (with `.git`, without `node_modules`). The prompt (`prompt.md`) carries the recipe format copied from `docs/SPEC.md` section 5 at run time.
- Scoring: `eval:score <name> --recipe <recipe>` against the committed labels in `evals/oss/labels/`.
- Repos: `fastify-typescript` and `express-mongodb-rest-api-boilerplate`, both pinned in `evals/oss/repos.json`; 1 run each. No run was repeated.

## Results beside the fixed reference recipe

Recall / precision per kind. The labels of both repos score `table`, `read` and `write` only.

| repo                                 | kind  | labelled | reference recipe | agent run 1               |
| ------------------------------------ | ----- | -------- | ---------------- | ------------------------- |
| fastify-typescript                   | table | 2        | 1.00 / 1.00      | 1.00 / 1.00               |
| fastify-typescript                   | read  | 2        | 1.00 / 1.00      | 0.00 / 1.00 (predicted 0) |
| fastify-typescript                   | write | 2        | 1.00 / 1.00      | 0.00 / 1.00 (predicted 0) |
| express-mongodb-rest-api-boilerplate | table | 7        | 1.00 / 1.00      | 1.00 / 1.00               |
| express-mongodb-rest-api-boilerplate | read  | 12       | 0.50 / 1.00      | 0.00 / 1.00 (predicted 0) |
| express-mongodb-rest-api-boilerplate | write | 11       | 0.82 / 1.00      | 0.00 / 1.00 (predicted 0) |

Reference recipe: `fastify-typescript` passes; `express-mongodb-rest-api-boilerplate` fails `read` and `write` (the database index and migrate commands are not matched). Agent: both runs score 1.00 on `table` and fail `read` and `write`.

Why the agent has no reads or writes: the prompt (carried over from the first spike) asks for routes, endpoints and tables only, and the agent did exactly that. The labels for these two repos score `read` and `write`, so the zero is a prompt gap, not evidence about the agent. The issue's bar names routes, endpoints and tables.

## Per run

| repo                                 | turns | check runs | input tokens (uncached + cache read + cache write) | output tokens | wall time | reported cost | recipe sha256          |
| ------------------------------------ | ----- | ---------- | -------------------------------------------------- | ------------- | --------- | ------------- | ---------------------- |
| fastify-typescript                   | 10    | 4          | 110,741 (14 + 91,467 + 19,260)                     | 3,811         | 31.0 s    | $0.124        | `cb6c4bb4...ce5ac84b`  |
| express-mongodb-rest-api-boilerplate | 8     | 2          | 118,042 (14 + 109,092 + 8,936)                     | 2,460         | 26.2 s    | $0.071        | `db0e0229...56ad74125` |

Recipes and full hashes: `runs/<repo>/run1/`; all numbers: `results.json`.

## Estimate for the full set (12 repos x 3 runs = 36 runs)

From these two runs (mean 114k input tokens, 3.1k output tokens, 28.6 s per run):

- about 4.1M input tokens (almost all cache reads), about 0.11M output tokens;
- about 17 minutes of agent time if the runs go one after another, about 5 minutes at `--jobs 4`.

Treat this as a floor. Both repos are small and the agent stopped after 8 and 10 turns. The first spike's larger repos (Next.js, NestJS, Go) will need more turns, and the first spike measured about 7M input tokens per round of 12 runs, which is a better planning figure for the full set (about 21M for three rounds) than this extrapolation.

## What would make the full run fail or mislead

1. Prompt gap: reads and writes are scored but not asked for. Add them to the prompt (the format already has `read`/`write` emits) before the full run, or score only the kinds the bar names.
2. The check command prints per-rule match counts only. The agent cannot see the routes, endpoints and paths the recipe produces; on the Express repo it saw 22 endpoint matches against its own count of about 17 and did not resolve it. Prefixes are only checked by reading code.
3. Next.js file-system routes (`fs-routes` helper) and other stacks were not exercised; the prompt's route guidance is from the first spike and may not match the engine's route emits.
4. `docs/SPEC.md` section 5 is read at run time; if that section moves, the runner stops with a message.
5. Each run needs a pinned clone in `GANTRY_OSS_DIR` at its SHA and a built `plugin/dist/cli.js`.
6. Quota: the full set is far larger than this spot test.
