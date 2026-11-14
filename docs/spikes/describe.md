# Spike: Haiku description quality and describer throughput (issue #6)

Scripts: `docs/spikes/describe/` (`system-prompt.md`, `run.ts`, `score.ts`, `lib.ts`, `store.ts`, `pathb.ts`, `mcp-stub.mjs`, `describer.md`). Reprint every number below with `pnpm tsx docs/spikes/describe/score.ts` (reads stored outputs, no model calls).

This report holds aggregate numbers only. The 200-function labelled set (evals/labelled/README.md) and every raw model output are private and stay in the git-ignored `evals/private/` (`describe-out/`).

## Verdict

- Path A (headless recipe, Haiku, `--effort low`, 5 batches of 40) is good enough on the three plan targets that can be measured: 95.5% of descriptions graded acceptable (target 85%), 100% schema pass (target 98%).
- The `nameFits` precision target cannot be assessed: Haiku flagged none of the 200 functions as misleadingly named, although 23 are labelled that way (recall 0 of 23). Precision of a flag that is never raised is undefined.
- Path B (describer subagent in a Claude Code session) is not measured. A headless approximation did not complete (details below), so it is pending the operator.

## Method

- Input: the 200-function labelled set (40 component, 30 hook, 50 util, 40 server, 40 helper), reviewed by the operator with 0 corrections. 23 labels have `nameFits: false`.
- Fact sheets are rendered from the stored fields (kind, name, path, signature, doc, callees, return type, body trimmed to 1,500 chars).
- Path A: the spec section 16 recipe unchanged from `docs/spikes/worker.md` (verdict WORKER OK): `GANTRY_WORKER=1`, `CLAUDE_CODE_EFFORT_LEVEL` removed, `--model haiku --effort low --safe-mode --tools '' --disallowedTools 'mcp__*' --strict-mcp-config --system-prompt-file system-prompt.md --no-session-persistence --output-format json --json-schema <results schema>`. Called from a scratch directory. 5 calls of 40, one try each, no retries needed.
- Grading: Sonnet, `--effort low`, same lock-down, 5 calls of 40. Fixed rubric from the issue: 2 = says what it does correctly and specifically; 1 = correct but vague; 0 = wrong or misleading. The grader sees the function name, signature, the human reference and the candidate (not the body). Grades are model-judged and no human spot-checked them.
- Checks per spec section 8: schema (shape plus the 200-char limit), length (at most 25 words), identifier check (rule 3: every camelCase, PascalCase or snake_case token in `behavior` must occur in the fact sheet; small stop-list of product names such as JavaScript). Missing functions count as failures in every rate.
- nameFits metrics: positive class is "the name misleads" (`nameFits: false`).
- Sonnet retry: the 20 worst Path A items (lowest grade, then failed checks, then input order) re-described by Sonnet `--effort low` in one call with the same prompt, then graded by the same grader in one call.

## Score table (verify output)

| Path                         | described        | schema pass | length pass | identifier pass | mean grade | % grade 2 | % grade >= 1 | nameFits flagged / precision / recall | tokens in / fn | tokens out / fn | s / fn |
| ---------------------------- | ---------------- | ----------- | ----------- | --------------- | ---------- | --------- | ------------ | ------------------------------------- | -------------- | --------------- | ------ |
| A: headless Haiku/low        | 200/200          | 100.0%      | 100.0%      | 100.0%          | 1.60       | 64.5%     | 95.5%        | 0 / n/a / 0.0%                        | 953            | 250             | 0.96   |
| A + Sonnet retry of 20 worst | 200/200          | 100.0%      | 98.0%       | 100.0%          | 1.67       | 68.5%     | 98.5%        | 0 / n/a / 0.0%                        | 1038           | 262             | 1.04   |
| B: describer subagent        | pending operator |             |             |                 |            |           |              |                                       |                |                 |        |

Tokens in include cache creation and cache reads. Seconds per function is the sum of call wall times over functions described (calls run one after another). The retry row adds the Sonnet call's tokens and time to Path A's.

nameFits (positive = name misleads): 23 labelled positives, 0 predicted positives, 0 true positives, agreement with the labels 88.5% (the 177 fitting names were all kept as fitting).

Grade counts for Path A: 0 = 9, 1 = 62, 2 = 129.

| stratum   | n   | mean grade | % grade 2 | % grade >= 1 |
| --------- | --- | ---------- | --------- | ------------ |
| component | 40  | 1.43       | 52.5%     | 90.0%        |
| hook      | 30  | 1.57       | 66.7%     | 90.0%        |
| util      | 50  | 1.74       | 74.0%     | 100.0%       |
| server    | 40  | 1.60       | 65.0%     | 95.0%        |
| helper    | 40  | 1.63       | 62.5%     | 100.0%       |

Per batch (Path A):

| batch | functions | wall s | tokens in | tokens out | cost USD |
| ----- | --------- | ------ | --------- | ---------- | -------- |
| 0     | 40        | 29.4   | 27985     | 6733       | 0.0088   |
| 1     | 40        | 78.3   | 90046     | 22651      | 0.0189   |
| 2     | 40        | 17.6   | 22150     | 4198       | 0.0063   |
| 3     | 40        | 39.6   | 27918     | 9899       | 0.0103   |
| 4     | 40        | 28.0   | 22525     | 6581       | 0.0075   |

Batch 1 used about 3 times the tokens of its neighbours and took 78 s; the cause was not investigated (the output passed every check). Batch cost varies by a factor of 4 in tokens and time, so budget with the slow case.

Sonnet retry of the 20 worst: mean grade 0.55 to 1.25; 12 improved, 8 unchanged, 0 worse; grade >= 1 on those 20 went from 55% to 85%; identifier pass stayed 100%. Sonnet exceeded 25 words on 4 of the 20 (overall length pass 98.0%), so a retry result needs the same truncate-or-re-ask repair as Haiku output.

## Targets

| Target (from the plan)                | Result                                                                 | Met?                                          |
| ------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| >= 85% graded acceptable (grade >= 1) | 95.5% (98.5% with the Sonnet retry)                                    | met                                           |
| schema pass >= 98%                    | 100.0% (also 100.0% with the 25-word limit and the identifier check)   | met                                           |
| nameFits precision >= 0.8             | undefined: 0 functions flagged, so no precision exists; recall 0 of 23 | missed (not measurable, the flag never fires) |

Caveat on "acceptable": 129 of 200 are fully specific (grade 2), 62 are vague-but-correct (grade 1) and 9 are wrong or misleading (grade 0). The 9 grade-0 items are the real quality risk, not the 62 vague ones.

## Path B (describer subagent)

Status: pending operator. Nothing here is a Path B measurement, and Path B outputs are not graded.

What was built, all in `docs/spikes/describe/`:

- `mcp-stub.mjs`: about 50-line stdio MCP server named `gantrystub` exposing `claim_batch` (next 40 fact sheets from the JSONL; claimed but unsubmitted sheets are re-issued first) and `submit` (validates the schema and 25-word limit per item, returns rejected keys with problems). Every claim and accepted submission is appended with a timestamp to `events.jsonl` in `STUB_OUT`.
- `describer.md`: the agent file (`model: haiku`, `effort: low`, `maxTurns: 60`, `tools:` only `mcp__gantrystub__claim_batch` and `mcp__gantrystub__submit`). Generated from `system-prompt.md` by `pathb.ts --write-agent`.
- `pathb.ts --headless` (approximation) and `--finalize` (turns `events.jsonl` into the stored Path B record: functions per minute from first claim to last submit).

Headless approximation (`claude -p` with a project agent file, `--mcp-config` plus `--strict-mcp-config`, Haiku/low main session told to invoke the describer until the queue is empty), 2 attempts, neither completed:

- Attempt 1: the subagent accepted 120 of 200 functions (39 + 1 + 40 + 40 across 4 submits, 1 rejected once and resubmitted) in 76.7 s from first claim to last submit, about 94 functions per minute, then stopped. It had issued two `claim_batch` calls back to back, so two batches were claimed and never submitted, and the main session ended after 2 turns. This is a partial, unscored observation of a run that did not finish; the event log was overwritten by attempt 2 (the script now moves old logs aside), so only the console summary survives.
- Attempt 2, after making the stub re-issue unsubmitted claims and adding "one tool call per turn" to the agent loop: the run ended after 21 s with zero stub calls (the subagent never used the tools).

Per the spike's call budget the approximation stopped there. These are the two failure modes to expect in the real session as well, so the production describer prompt should demand one tool call per turn and the MCP server should re-issue or time out unsubmitted claims.

### Operator steps (about 10 minutes)

1. Make a scratch project directory outside any real repo and put in it:
   - `.claude/agents/describer.md`: a copy of `docs/spikes/describe/describer.md`.
   - `.mcp.json` with a `gantrystub` server: `command: node`, `args: [<absolute path to docs/spikes/describe/mcp-stub.mjs>]`, `env: { STUB_DATA: <repo>/evals/private/labelled/devprentice.jsonl, STUB_OUT: <repo>/evals/private/describe-out/path-b, STUB_BATCH: "40" }`.
2. Start `claude` in that directory (not `claude -p`) and approve the project MCP server. Check `/agents` lists `describer` and `/mcp` shows `gantrystub` connected.
3. Run `/usage` and write down the session and weekly figures.
4. Send: `Use the describer subagent to drain the description queue. Invoke it with the prompt "Drain the queue." and invoke it again if it stops before saying "queue empty". Describe nothing yourself.`
5. When it finishes (200 accepted, or you stop it), run `/usage` again and write down the difference.
6. In the repo: `pnpm tsx docs/spikes/describe/pathb.ts --finalize` (prints functions per minute), then `GANTRY_CLAUDE_BIN=<claude path> pnpm tsx docs/spikes/describe/run.ts --grade b` (5 Sonnet calls), then `pnpm tsx docs/spikes/describe/score.ts`. Add the `/usage` before/after figures and the Path B row to this report. If the first claim or submit takes long, note the model's turn count too.

`/usage` before and after is operator-only and is pending. A headless run has no plan-usage readout either, so no usage figure exists for Path B yet.

## Projection for Devprentice (`gantry init --estimate` style)

No `gantry init --estimate` run was made against the test bed (it writes to the repo). Function count used: 2,217, the number of non-trivial functions in the five sampling strata (pool sizes printed by `evals/labelled/sample.ts`: 473 component, 30 hook, 185 util, 485 server, 1,044 helper). This is a lower bound for the real estimate, which may include others, and it is an input, so override it with `DEVPRENTICE_FUNCTIONS=<n>` when scoring. Functions times the measured Path A numbers per function (953 tokens in, 250 tokens out, 0.96 s):

| measure                                        | value     |
| ---------------------------------------------- | --------- |
| input tokens (incl. cache)                     | 2,113,067 |
| output tokens                                  | 554,937   |
| batches of 40                                  | 56        |
| rounds of 4                                    | 14        |
| sequential headless wall time                  | 35.6 min  |
| 4 at a time, mean batch time per round         | 9.0 min   |
| 4 at a time, slowest measured batch each round | 18.3 min  |

The spec's placeholder was 500 in and 150 to 200 out per function. Measured on real code the output is about 250 per function (the worker spike's 125 to 165 used short synthetic functions) and the input is about 950 per function incl. cache (the worker spike measured about 2,000 fixed tokens per call plus about 140 per synthetic sheet; real fact sheets with bodies are larger), so `--estimate` should use about 950 in and 250 out until a better measure exists. The 4-at-a-time wall times assume the subscription does not throttle parallel calls; that was not tested.

## Recommendations

- `renameSuggestions` default: keep it off. With the strict `nameFits` prompt Haiku never says a name misleads, so suggestions would be empty (no harm, no value), and the precision target has no data. To enable it by default, first find a prompt or model variant that flags a fair share of the 23 labelled cases and measure precision on the flags; the labelled set now supports that (23 positives, 177 negatives).
- Sonnet retry: worth it for the worst items, with a caveat. On the 20 worst it lifted grade >= 1 from 55% to 85% (12 of 20 improved, none worse) for one call, taking the whole set from 95.5% to 98.5%. But the worst items were picked using the grader, which production does not have. The spec's trigger (a function failing the section 8 checks twice goes to `describe.retry`) fired for 0 of 200 here, so on this set it would have retried nothing. Use Sonnet for `describe.retry` as specced, and treat a blanket quality retry as unproven until a cheap signal (for example a grade-0 predictor) exists. Retry output also needs the 25-word repair.
- Prompt: the identifier rule worked (only 7 identifier-like words appeared in 200 descriptions, all present in the fact sheets). The 25-word limit was never exceeded by Haiku with the "stay under 22 words" wording, unlike the worker spike's shorter prompt.

## Deviations and caveats

- Grading is by one Sonnet pass per item with no human check, and the same grader judged the Sonnet retry. Grades are comparable within this report only.
- The retry's own grading used one extra Sonnet call beyond the planned retry call.
- "Length pass" is reported separately from "schema pass": the 25-word limit cannot be expressed in the JSON schema, so schema pass counts shape plus the 200-char limit and length pass adds the word limit.
- The identifier check uses the fact sheet's full text including the path and symbol id as the allowed vocabulary.
- Path B is unmeasured (above). No `/usage` figures.
- The function count in the projection is a lower bound taken from the sampling pools, not from an index.
- One account (claude.ai subscription) and one run per batch; batch 1's high token count suggests run-to-run variance that one pass cannot size.

## Model calls made

14 `claude -p` sessions: 5 Haiku (Path A), 5 Sonnet (grading), 1 Sonnet (retry), 1 Sonnet (retry grading), 2 headless Path B approximation sessions (Haiku main session plus Haiku describer subagent each).
