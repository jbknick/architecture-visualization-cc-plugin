# Spike: how much of a change an estimate from its plan finds (#304)

**Status: pilot only.** This report covers a pilot of 40 estimator runs on 10 pull requests, which the maintainer approved before the full measurement. It is not the spike's verdict. The Bar is defined over at least 100 pull requests; the pilot has 10. The issue stays open until the maintainer rules on the full run.

**Verdict line: pilot: 10 pull requests, 40 runs. No GO or NO-GO is given.**

## Result against the Bar

The Bar (from the plan's "Spike first" table): median recall of changed files at least 60% at median precision at least 50%, over at least 100 merged public pull requests pinned by SHA; three runs on a 20-pull-request subset, the worst run reported and held to the same bar.

| Run (10 PRs each)                         | Model id          | Median recall | Median precision | Recall at least 60%? | Precision at least 50%? |
| ----------------------------------------- | ----------------- | ------------- | ---------------- | -------------------- | ----------------------- |
| pilot-1 (worst run: lowest median recall) | claude-sonnet-5-5 | 39.2%         | 91.7%            | below                | above                   |
| pilot-3                                   | claude-sonnet-5-5 | 53.3%         | 100.0%           | below                | above                   |
| pilot-2                                   | claude-sonnet-5-5 | 73.3%         | 100.0%           | above                | above                   |
| pilot-kw (keyword only, one run)          | claude-sonnet-5-5 | 66.7%         | 100.0%           | above                | above                   |

- Of the three runs with stored descriptions, the worst run (pilot-1) has a median recall of 39.2% at a median precision of 91.7%: **recall below the Bar's 60% threshold, precision above its 50% threshold.** The best run (pilot-2) is above both. The spread of median recall (max minus min) is 34.1 points.
- The pilot cannot meet the Bar, because the Bar needs at least 100 pull requests and 20-pull-request subset runs. The pilot numbers neither pass nor fail it; they show a wide run-to-run spread on 10 pull requests, with the worst run below the recall threshold.
- The worst single case: `cal.com#27634` (10 changed files) and `cal.com#29346` (2 changed files) score recall 0 and precision 0 in all four runs (the estimates were empty or named wrong files; for `cal.com#29346` three of the four runs were empty and one named a single wrong file). An empty estimate counts as precision 0, and with areas of a few files precision is shaped by the area size: one wrong file in an area of two halves it, so the precision medians of 91.7% to 100% say little on their own.

**Limits of the pilot.**

- The plan text (the pull request title and body) names changed files in most of the pilot pull requests: 7 of 10 by an independent count of changed indexable files (full paths in 5); the stripping rule of the full run, which counts every changed file and path suffix, finds 8 of 10 (6 with a path). Recall in the pilot was therefore measured on text that was partly written after the change and says where it landed. The full run strips those names (see the full report).
- The pilot runs could reach the answer through one channel: `gantry_impact` accepts a `range` of git refs, and the pilot worktrees sat on a clone that holds the merge commits. No transcript was kept, so whether any run used it is unknown. The estimator prompt now forbids `range`, and `run.ts` now runs the estimator in an isolated repository (below) and fails a run when the merge commit is reachable from it. The pilot numbers predate both changes.
- "Stored descriptions" here means the descriptions Gantry writes without a model (provenance `template`, 28.6% to 35.2% of function-like symbols). No model-written descriptions exist for the pilot (see "Differences from the plan"), so the description row of the Bar's design is not measured; the pilot-1/2/3 rows are the stored-template condition and pilot-kw is the same index with every description removed.

## Pilot cases

Chosen before any run: `pilot.json` is the first 10 entries of the seeded shuffle (seed 1) of `prs.json`, and `subset.json` (the first 20 of the same shuffle) contains it. Five per repository.

| Repo       | Pull requests                     | Indexable files changed (actual set) |
| ---------- | --------------------------------- | ------------------------------------ |
| formbricks | 9569, 10018, 10031, 10061, 10090  | 13, 3, 5, 16, 6                      |
| cal.com    | 27634, 29346, 29541, 29558, 29708 | 10, 2, 2, 3, 3                       |

## Corpus and selection rule

`prs.json` lists 110 merged public pull requests (55 per repository) as `{ repo, number, base, merge }`. The rule is applied by `select.ts`, per repository, newest first:

1. merged into `main` before the repository's pinned SHA (formbricks `b52ebf8`, cal.com `ae027bb`, both in `evals/oss/repos.json`), and the merge commit is an ancestor of the pinned SHA;
2. author is not a bot (`is_bot`, or a login ending in `[bot]` or starting with dependabot, renovate, github-actions, copilot);
3. title is not a dependency bump (`chore(deps`, `build(deps`, `bump`, `update dependency`, dependabot, renovate);
4. 2 to 40 indexable files changed (`git diff --name-only --no-renames` of `base` against `merge`, filtered by the indexer's `isIndexable`);
5. the description has at least 200 characters, or, when it is shorter, the body of the issue it closes (`Closes #n` and the like) does.

`base` is the first parent of the merge commit (the pull requests are squash or merge commits on `main`). Dropped on the way to the 55 per repository: formbricks 33 under 2 files, 13 over 40 files, 6 bot authors, 9 dependency bumps; cal.com 91 under 2 files, 1 over 40 files, 5 short descriptions, 1 bot author, 2 dependency bumps. PR text is fetched with `gh` into the git-ignored `evals/oss/cache/plan-estimates/` and is not committed.

## Method

- `estimator.md` is the prompt. `run.ts` puts the tree of `base` in a repository (in the pilot, a worktree of a blob-less history clone of each corpus repository under `~/Dev/gantry-oss/plan-estimates/`; since the fix below, an isolated one), runs `gantry heal` (or `init` the first time), and runs the prompt headless with the plan in a field `untrusted_plan` of the stdin JSON. Allowed tools: the MCP tools `gantry_search`, `gantry_node` and `gantry_impact` only (no built-in tools: `--tools ""`; the other eight Gantry tools are disallowed). Output is forced with `--json-schema` to `{ area: [{ id, confidence }] }` (at most 40 nodes, confidence 0 to 1). Model `sonnet`, effort `low`; the resolved model id (`claude-sonnet-5-5`) is read from the run's `modelUsage` and recorded per run in `runs/<name>.meta.json`.
- `score.ts` is deterministic over a committed run file and the history clone. Actual set: the indexable files changed by the pull request (`reviewDiff(base, merge)`). Estimated set: the files of the area's nodes (a `dir:` or `ws:` node counts all its files at `base`). The short ids the model sometimes writes (`file:<path>`, `sym:<path>#<name>`, which the tools accept too) count as the file they name. Recall = |est and actual| / |actual|; precision = |est and actual| / |est|, 0 for an empty area.
- Radius: estimated radius = hop-1 consumers (sum of `directTotal` over symbols) of the symbols in the area's files; actual radius = the same over the changed symbols (`computeImpact` on the `base` index). Ratio = estimated over actual, for pull requests whose actual radius is above 0 (9 of 10). No bar.

## Table 1: first run over the pilot pull requests (pilot-1), and the keyword-only run

Description coverage is the share of function-like symbols with a stored description at each pull request's base (median, minimum); all of it is `template`, none model-written.

| Repo                        | PRs | Description coverage (median, min) | Median recall | Median precision | P25 recall | P25 precision |
| --------------------------- | --- | ---------------------------------- | ------------- | ---------------- | ---------- | ------------- |
| formbricks                  | 5   | 35.2%, 33.3%                       | 38.5%         | 100.0%           | 33.3%      | 83.3%         |
| cal.com                     | 5   | 28.6%, 28.6%                       | 66.7%         | 66.7%            | 0.0%       | 0.0%          |
| all pilot PRs               | 10  | 30.9%, 28.6%                       | 39.2%         | 91.7%            | 22.4%      | 54.2%         |
| formbricks, keyword only    | 5   | descriptions removed               | 66.7%         | 100.0%           | 38.5%      | 100.0%        |
| cal.com, keyword only       | 5   | descriptions removed               | 66.7%         | 66.7%            | 0.0%       | 0.0%          |
| all pilot PRs, keyword only | 10  | descriptions removed               | 66.7%         | 100.0%           | 33.1%      | 70.8%         |

The keyword-only index is a copy of the healed index with the `descriptions` table emptied and the description columns of `fts_symbols` blanked.

## Table 2: the three runs with stored descriptions

| Run     | Model id          | Median recall | Median precision | Empty estimates |
| ------- | ----------------- | ------------- | ---------------- | --------------- |
| pilot-1 | claude-sonnet-5-5 | 39.2%         | 91.7%            | 1               |
| pilot-2 | claude-sonnet-5-5 | 73.3%         | 100.0%           | 0               |
| pilot-3 | claude-sonnet-5-5 | 53.3%         | 100.0%           | 1               |

Worst run: pilot-1 (lowest median recall; precision breaks no tie). Spread of median recall: 34.1 points. What differs between the runs: per-pull-request recall (recall/precision) of the three runs:

| Pull request     | pilot-1   | pilot-2   | pilot-3 | keyword only |
| ---------------- | --------- | --------- | ------- | ------------ |
| cal.com#27634    | 0/0       | 0/0       | 0/0     | 0/0          |
| cal.com#29346    | 0/0       | 0/0       | 0/0     | 0/0          |
| cal.com#29541    | 1/1       | 1/1       | 1/1     | 1/1          |
| cal.com#29558    | 0.67/0.67 | 0.67/1    | 0.67/1  | 0.67/0.67    |
| cal.com#29708    | 1/1       | 1/1       | 1/1     | 1/1          |
| formbricks#10018 | 0.33/0.5  | 1/1       | 1/1     | 0.67/1       |
| formbricks#10031 | 0.4/1     | 0.8/1     | 0.4/1   | 0.8/1        |
| formbricks#10061 | 0.19/1    | 0.19/1    | 0.19/1  | 0.31/1       |
| formbricks#10090 | 0.83/1    | 0.83/1    | 0.83/1  | 0.83/1       |
| formbricks#9569  | 0.38/0.83 | 0.38/0.83 | 0.31/1  | 0.38/0.83    |

Seven of ten pull requests give nearly the same result in every run; the three that move (`formbricks#10018`, `formbricks#10031`, and to a lesser extent `formbricks#9569`) decide the median. Medians over 10 pull requests move a lot when two or three of them change, which is why the pilot cannot rank the keyword-only and stored-description rows.

## Table 3: radius ratio (estimated over actual hop-1 consumers), no bar

| Run      | Repo       | PRs with actual radius above 0 | Median | P25  | P75   |
| -------- | ---------- | ------------------------------ | ------ | ---- | ----- |
| pilot-1  | formbricks | 5                              | 4.75   | 2.95 | 6.67  |
| pilot-1  | cal.com    | 4                              | 3.14   | 2.10 | 13.44 |
| pilot-1  | all        | 9                              | 4.00   | 2.28 | 6.67  |
| pilot-2  | formbricks | 5                              | 2.95   | 2.00 | 4.75  |
| pilot-2  | cal.com    | 4                              | 2.64   | 2.10 | 12.69 |
| pilot-2  | all        | 9                              | 2.95   | 2.00 | 4.75  |
| pilot-3  | formbricks | 5                              | 2.95   | 2.00 | 4.75  |
| pilot-3  | cal.com    | 4                              | 2.64   | 1.82 | 12.69 |
| pilot-3  | all        | 9                              | 2.95   | 2.00 | 4.75  |
| pilot-kw | formbricks | 5                              | 3.81   | 2.00 | 4.75  |
| pilot-kw | cal.com    | 4                              | 3.14   | 1.76 | 13.44 |
| pilot-kw | all        | 9                              | 3.81   | 2.00 | 4.75  |

## Cost and timing (from the 40 runs)

Machine: the maintainer's Mac (18 GB, macOS, Claude Code 2.1.328), with several other agents running; the load average was between 94 and 129 during the runs, so wall times are higher than on a quiet machine. Estimator calls ran one at a time.

| Run      | Calls | Turns | Uncached input | Cache creation | Cache read | Output | Wall (sum) |
| -------- | ----- | ----- | -------------- | -------------- | ---------- | ------ | ---------- |
| pilot-1  | 10    | 47    | 48             | 261,250        | 452,193    | 4,518  | 108 s      |
| pilot-2  | 10    | 42    | 40             | 31,805         | 526,714    | 4,212  | 98 s       |
| pilot-3  | 10    | 46    | 48             | 36,466         | 682,606    | 4,586  | 106 s      |
| pilot-kw | 10    | 50    | 54             | 44,000         | 861,637    | 5,065  | 112 s      |
| total    | 40    | 185   | 190            | 373,521        | 2,523,150  | 18,381 | 424 s      |

- Input-side tokens in total (uncached input plus cache creation plus cache read, the conservative count): 2,896,861, under the pilot's 4,000,000 budget. Output tokens: 18,381. Every call returned a structured answer; none failed.
- Per call: 4 to 7 turns (median 5), wall 6.1 to 18.4 s (median 9.7 s). Tokens per call: formbricks about 22,000, cal.com about 123,000 (larger search results).
- Index work per pull request base (`heal`, or `init` for the first one in a repository): 2 s to 203 s (the long ones move the worktree across thousands of files).
- No model was called for descriptions, so the cost of step 2 is not measured; the estimate is below.

## What the full run would need

Estimates from the pilot's per-call averages and the spec's description formula. They are cost estimates only; nothing about the scores is extrapolated.

- Pull requests: at least 100 (`prs.json` already lists 110). Runs: 110 (full) + 60 (three on the 20-pull-request subset) + 110 (keyword only) = 280 estimator runs. At the pilot's per-call averages (22,000 tokens for formbricks, 123,000 for cal.com; about 72,000 for an even mix), that is roughly 20 million input-side tokens, almost all cache reads, and under 150,000 output tokens. The issue's own count of about 160 runs covers only the full run and the subset runs.
- Model-written descriptions (step 2): at the last pull-request base, formbricks has 14,788 function-like symbols with 5,194 templated, so 9,594 to describe, and cal.com has 8,988 with 2,574 templated, so 6,414 to describe. By the spec formula (950 input and 250 output tokens per function): about 15.2 million input and 4.0 million output tokens, and about 4.3 hours of sequential headless time at 0.96 s per function. This alone is above the 4 million input-token budget of the pilot, which is why the pilot did not do it.
- The third corpus repository (twenty) is not needed for 100 pull requests.

## Differences from the plan

- **Corpus:** formbricks and cal.com only; twenty is not added. `evals/oss/repos.json` is unchanged: both repositories were already listed, and formbricks has role `held-out` there; the issue asks for `tuning`, but changing a role is not a spike-sized edit of a shared file, so the maintainer should say if it is wanted.
- **Descriptions:** `/gantry:init` model-written descriptions were not generated (cost above). The stored-description runs use only the descriptions Gantry writes without a model (template). Coverage is therefore 28.6% to 35.2%, all template.
- **Runs:** a pilot of 10 pull requests, run names `pilot-1`, `pilot-2`, `pilot-3`, `pilot-kw` instead of `full` and `sub-1` to `sub-3`. The issue's Verify commands for `full.json` and `--subset` were not run; the determinism check was done on `pilot-1.json` (two scorings gave the same SHA-256).
- **Headless recipe:** the spec section 16 recipe has `--safe-mode`. With `--safe-mode` the `--mcp-config` server is not loaded (measured: the init event listed no MCP server and only the `StructuredOutput` tool, and the model answered with an empty area), so `run.ts` uses `--setting-sources project --disable-slash-commands --strict-mcp-config --tools ""` and `--disallowedTools` for the other eight Gantry tools. The estimator runs with the user's account and a claude.ai login. Spec not edited.
- **Selection:** the merged pull requests are listed with `gh pr list --limit 600` and ordered by merge time, because GitHub search is not available for cal.com. Changed-file counts at selection use `--no-renames`; scoring uses `reviewDiff`, which detects renames.
- **Clones:** the pinned clones in `~/Dev/gantry-oss/` are shallow, so the spike uses separate blob-less bare clones of the two repositories (and worktrees) under `~/Dev/gantry-oss/plan-estimates/`.
- **Harness faults found and fixed before the numbers above (no scored data was thrown away):** a first trial with `--safe-mode` returned no tools (above); the first scoring pass did not read the short ids (`file:<path>`), which made 3 of 10 pull requests in pilot-1 look empty, so `area.ts` now reads them (applied to all runs alike), and the radius counts were recomputed from the committed areas with `run.ts --radius-only` (heals only, no model call). `biome` reformatted one blank line in `estimator.md` while the pilot was running; the words of the prompt did not change.

## Isolation of the estimator (added after the pilot)

`run.ts` exports the tree of each pull request's `base` with `git archive` into a standalone repository (`~/Dev/gantry-oss/plan-estimates/est/<repo>`) whose history is one synthetic commit per visited base: it holds no real commit, no merge commit, no other ref and borrows no objects. The index and the estimator child live there. Before each estimator call `run.ts` checks that neither the merge commit nor the real base commit is stored in, or reachable (`rev-list --all --reflog`) from, that repository, and fails the run if one is. `estimator.md` also forbids the `range` argument. This was checked on a preparation pass without a model call (`run.ts --prepare-only`).

## Reproduce

```
pnpm build
git clone --bare --filter=blob:none https://github.com/formbricks/formbricks.git ~/Dev/gantry-oss/plan-estimates/formbricks.git
git clone --bare --filter=blob:none https://github.com/calcom/cal.com.git ~/Dev/gantry-oss/plan-estimates/cal.com.git
pnpm tsx docs/spikes/plan-estimates/select.ts
pnpm tsx docs/spikes/plan-estimates/run.ts --pilot --run pilot-1 --run pilot-2 --run pilot-3 --run pilot-kw
pnpm tsx docs/spikes/plan-estimates/score.ts docs/spikes/plan-estimates/runs/pilot-1.json
```

Committed: `prs.json`, `subset.json`, `pilot.json`, `runs/*.json` (node ids and confidences) and `runs/*.meta.json` (model id, token counts, wall time, description counts and radius counts). No pull request text, issue text or source code of the corpus is committed.
