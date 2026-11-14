# Spike: headless `claude -p` worker recipe (issue #2)

Script: `pnpm tsx docs/spikes/worker/run.ts` (helpers and tests in `docs/spikes/worker/lib.ts`, `lib.test.ts`). Fact sheets are synthetic (3 hand-written, the rest renamed variants). No private data is used.

## Verdict: WORKER OK

The spec section 16 recipe works unchanged on CLI 2.1.325 through the claude.ai subscription login. All flags are accepted, the lock-down holds (1 tool, no MCP servers), `structured_output` was present in every live run of the full recipe whose outcome was inspected (the `--n 10` runs, 2/2 matrix runs, the effort-env runs and the last run at each timing size), and Haiku returned schema-valid descriptions for 1, 10 and 40 fact sheets (the last of the 3 timing runs at each size passed the harness checks; the earlier runs were not checked individually). A batch of 10 takes about 7 s and 40 about 16 s; cold start is about 3.3 s. Token cost is about 125 to 165 output tokens per function. The pre-commit modes `timeboxed` and `strict` can use the headless worker. The fallback (enqueue only, describer subagents do all descriptions) is not needed.

Caveats, none of which change the verdict:

- In the `--n 10` Verify run the model exceeded the 25-word `behavior` limit on 3 of 10 descriptions (27 words each). The harness reports these as length warnings. The production worker must treat over-length `behavior` as repairable (truncate or re-ask), not trust the model to count, and the system prompt should state the limit more firmly. The last timing run at each of 1, 10 and 40 sheets passed all checks.
- Only Haiku with `--effort low` was measured. Quality of descriptions was judged only by the schema/length checks, not against a labelled set (that belongs to the eval issues).
- One account was tested (claude.ai subscription). API-key and Bedrock/Vertex logins were not tested.

## Operator steps (done)

Run on 2026-11-14 with `GANTRY_CLAUDE_BIN=/Users/joseph/.local/bin/claude`. The CLI needed no harness change for 2.1.325. One small harness fix: over-length `behavior` text is now a printed warning (exit 0) instead of a failure, because the host can repair it; schema and missing-key problems still exit 1. `--matrix` and `--effort-env` were run with `--reps 2` instead of the default 3 to keep the call count near 40.

```
pnpm tsx docs/spikes/worker/run.ts --version
pnpm tsx docs/spikes/worker/run.ts --n 10
pnpm tsx docs/spikes/worker/run.ts --matrix --reps 2
pnpm tsx docs/spikes/worker/run.ts --timing
pnpm tsx docs/spikes/worker/run.ts --effort-env --reps 2
pnpm tsx docs/spikes/worker/run.ts --recursion
```

Step 6 (real Claude-made commit) was run by hand in a scratch repo, see below. Model calls made: about 52 (2 `--n 10` (one before and one after the harness fix), 8 matrix init probes plus 16 matrix live runs, 14 timing, 2 invalid-effort probes plus 4 effort-env runs, 3 recursion, 3 step 6). All Haiku, all small.

## Versions (step 1)

| Item                 | Value                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `claude --version`   | 2.1.325 (Claude Code). The earlier offline prep used 2.1.321; the results below were re-run on 2.1.325. |
| `claude auth status` | `loggedIn: true`, `authMethod: claude.ai`, `apiProvider: firstParty`                                    |
| Node / pnpm          | Node 22+, pnpm 10.31 (repo toolchain)                                                                   |
| Binary location      | `/Users/joseph/.local/bin/claude`, not on `PATH` in the agent shell; passed via `GANTRY_CLAUDE_BIN`.    |

## Working command line

Confirmed working end to end (exit 0, `structured_output` present):

```
GANTRY_WORKER=1 claude -p --model haiku --effort low --safe-mode --tools '' --disallowedTools 'mcp__*' --strict-mcp-config --system-prompt-file <file> --no-session-persistence --output-format json --json-schema '<inline>'
```

stdin carries the fact sheets. `CLAUDE_CODE_EFFORT_LEVEL` is removed from the child env. The system prompt is `SYSTEM_PROMPT` in `lib.ts`; the schema is `RESULTS_SCHEMA` (the spec section 8 Description schema wrapped as `{ results: [{ content_key, description }] }`).

The JSON result carries the answer in `structured_output` (an object `{ results: [...] }`), plus `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), `duration_api_ms` and `total_cost_usd`. The `--n 10` run (10 sheets) printed: `outcome=ok wall=7595 ms api=6400 ms`, `tokens: input=2 output=1647 cache_creation=3435 cache_read=0 cost_usd=0.0015107`, `per function: output=164.7 input=0.2`. A second run after the harness fix (exit 0, `schema checks: pass`) printed `outcome=ok wall=8073 ms`, `input=2 output=1751 cache_creation=727 cache_read=2709 cost_usd=0.00105`, `per function: output=175.1`; the same 3 sheets (the three byte-formatter copies) again exceeded 25 words, so the over-length is repeatable for that input, and the repeat run read most of the prompt from cache.

## Flag matrix (step 4)

Measured in a scratch directory that has a project `.mcp.json` (stub MCP server), a `CLAUDE.md` and a project skill. "tools / MCP / skills" come from the `system/init` event of `--output-format stream-json --verbose`; the last two columns are live runs (2 per variant, `--reps 2`).

| Variant                                      | CLI parse | tools loaded           | MCP servers loaded                                                                                        | skills / slash cmds | `structured_output` present | live outcomes                              |
| -------------------------------------------- | --------- | ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------- | ------------------------------------------ |
| full recipe                                  | accepted  | 1 (`StructuredOutput`) | none                                                                                                      | 23 / 59             | 2/2                         | ok, ok                                     |
| drop `--safe-mode`                           | accepted  | 1                      | none                                                                                                      | 24 / 60             | 2/2                         | ok, ok                                     |
| drop `--strict-mcp-config`                   | accepted  | 1                      | none                                                                                                      | 23 / 59             | 2/2                         | ok, ok                                     |
| drop `--json-schema`                         | accepted  | 0                      | none                                                                                                      | 23 / 59             | **0/2**                     | no_structured_output, no_structured_output |
| drop `--safe-mode` and `--strict-mcp-config` | accepted  | 1                      | **23** (stub project server, 11 plugin MCP servers, 11 claude.ai connectors such as Gmail, Drive, Linear) | 55 / 92             | 2/2                         | ok, ok                                     |
| drop `--tools ''`                            | accepted  | 28                     | none                                                                                                      | 23 / 59             | 2/2                         | ok, ok                                     |
| drop `--disallowedTools`                     | accepted  | 1                      | none                                                                                                      | 23 / 59             | 2/2                         | ok, ok                                     |
| drop `--no-session-persistence`              | accepted  | 1                      | none                                                                                                      | 23 / 59             | 2/2                         | ok, ok                                     |

Observed:

- No combination errors at parse time and no combination fails live, except dropping `--json-schema`, where the model answers in plain text and `structured_output` is absent. `--json-schema` is the only flag the result depends on.
- Dropping both `--safe-mode` and `--strict-mcp-config` loads 23 MCP servers (the user's plugin servers and account connectors, plus the project stub) and 55 skills. Either flag alone keeps them all out. Keep both: this is the lock-down that matters, and a worker that could see Gmail or Drive connectors is a leak.
- `--tools ''` leaves a single tool, `StructuredOutput`, and only with `--json-schema`. Without `--json-schema` there are zero tools. Dropping `--tools ''` gives 28 built-in tools (27 on 2.1.321), so it is required.
- `--safe-mode` still leaves 23 skills and 59 slash commands (built-in or bundled; the counts rose from 19/52 on 2.1.321). The cost is prompt tokens only and is included in the token table below. Dropping it adds one (the scratch project skill).
- `--disallowedTools 'mcp__*'` and `--no-session-persistence` had no visible effect on the loaded sets or the outcome. They stay as defence in depth (the second keeps worker sessions out of the user's history).
- `--effort` with an invalid value does not error: it prints `Warning: Unknown --effort value ... ignoring it` and uses the default. Valid: low, medium, high, xhigh, max.

## Recursion and hook guard (step 6)

### Simulated (`--recursion`, live worker on 2.1.325)

Scratch git repo with a stub hook that exits at once when `GANTRY_WORKER=1`, otherwise appends to a log. The stub is registered as a Claude Code `SessionStart` hook (project `.claude/settings.json`) and called from a git `pre-commit` hook, which then runs the worker. The commit itself runs without the guard. Counts exclude the outer pre-commit call.

| Worker invocation (inside git pre-commit)     | worker-side hook runs that did work | worker-side guard exits |
| --------------------------------------------- | ----------------------------------- | ----------------------- |
| no guard, no `--safe-mode` (positive control) | 1                                   | 0                       |
| `GANTRY_WORKER=1`, no `--safe-mode`           | 0                                   | 1                       |
| `GANTRY_WORKER=1`, `--safe-mode`              | 0                                   | 0                       |

### Real Claude-made commit

Scratch repo under the temp directory (not inside any real repo), the same stub registered as a `SessionStart` hook, and a `pre-commit` hook that runs the stub and then the full recipe with `GANTRY_WORKER=1`. A headless Claude Code session (`claude -p --model haiku --allowedTools Bash`, `GANTRY_WORKER` unset) was asked to run `git commit`. Result:

- The commit succeeded (the worker exited 0 and returned `structured_output` of `{"results":[]}`).
- The hook log had exactly two lines: `session-start` (the outer Claude Code session) and `outer-pre-commit`. No third line, so the worker did not fire the Gantry hook.
- The guard-exit log was empty. With the full recipe the worker's `--safe-mode` skips project hooks, so the guard never even runs.

Findings: a `claude -p` worker without `--safe-mode` re-enters project `SessionStart` hooks, and `GANTRY_WORKER=1` stops that (guard exit count 1, work count 0). With `--safe-mode`, project hooks do not run at all. The guard is a second line of defence, and both lines hold for a real Claude-made commit. Not measured: a commit by a Claude Code session that has Gantry's real plugin hooks (as opposed to the stub with the same structure) installed; that belongs to the hook issues.

## Timing (step 5)

`--timing`, Haiku, `--effort low`, no cache warm-up beyond what the CLI does itself.

| Measure                   | Result                                                  |
| ------------------------- | ------------------------------------------------------- |
| Cold start, 5 runs (n=1)  | 3343, 3395, 2788, 4781, 2993 ms                         |
| Median cold start         | 3343 ms                                                 |
| Wall time, 1 fact sheet   | 2739 ms (median of 3 runs)                              |
| Wall time, 10 fact sheets | 6957 ms (median of 3 runs); `--n 10` single run 7595 ms |
| Wall time, 40 fact sheets | 16279 ms (median of 3 runs)                             |

The per-call overhead is about 2.5 to 3.5 s; each extra function adds roughly 0.35 to 0.45 s of generation. A 40-function batch fits easily in a 120 s timeout; the pre-commit `timeboxed` budget decides how many batches fit.

## Tokens per function (step 5)

Values are from the last of the 3 runs at each size (`--timing` prints one row of tokens per size). "All input" is `input_tokens + cache_creation + cache_read`; the 1/10/40 totals are `all input/fn` times the sheet count, as printed.

| Fact sheets | input_tokens | output_tokens | output per function | all input (total) | all input per function |
| ----------- | ------------ | ------------- | ------------------- | ----------------- | ---------------------- |
| 1           | 2            | 160           | 160.0               | 2082              | 2082.0                 |
| 10          | 2            | 1543          | 154.3               | 3435              | 343.5                  |
| 40          | 2            | 5009          | 125.2               | 7968              | 199.2                  |

`input_tokens` is 2 because the prompt prefix is billed as cache creation. The fixed cost is about 2000 input tokens per call (built-in prompt plus the 23 bundled skills' descriptions plus the system prompt); each fact sheet adds about 140 input tokens. The `--n 10` Verify run: `input=2 output=1647 cache_creation=3435 cache_read=0`, `cost_usd=0.0015` for 10 functions. Batching therefore pays: 10 per call costs about a sixth of the per-function input of single calls.

## Effort override (step 7)

- Invalid `--effort` only warns, with or without `CLAUDE_CODE_EFFORT_LEVEL=high` in the env (same warning, exit 0), so the override is not observable that way.
- Live, 3 fact sheets per run, 2 runs each, `--effort low`:

| Variant                   | output_tokens per run | median wall |
| ------------------------- | --------------------- | ----------- |
| `--effort low`, env unset | 672, 616              | 4617 ms     |
| `--effort low`, env=`max` | 4914, 4382            | 19288 ms    |

The env var clearly wins over the flag: output tokens rise about 7x and wall time about 4x with `CLAUDE_CODE_EFFORT_LEVEL=max` set. Unsetting it restores the flag's behaviour. The worker must remove `CLAUDE_CODE_EFFORT_LEVEL` from its env, as the spec says and the script does. (Measured by token and time effect; the CLI does not report the effective effort.)

## Spec changes to make (section 16; docs/SPEC.md is not edited here, that is issue #11)

1. Replace "M0 confirms which flags work together" with the confirmed recipe from this report (CLI 2.1.325). Every flag in the recipe works together unchanged.
2. `--system-prompt-file` works but does not appear in `claude --help` (only `--system-prompt` is listed). Note to re-check it on each CLI upgrade, or fall back to `--system-prompt "$(cat file)"`.
3. State that `--json-schema` is mandatory: without it there is no `structured_output` (0/2 live) and no `StructuredOutput` tool. Keep "may be missing, then backlog" for model or schema failures.
4. State that `--safe-mode` and `--strict-mcp-config` are each sufficient to keep MCP servers out, and that dropping both loads all user plugin and claude.ai connector servers (23 here). Keep both; keep `GANTRY_WORKER=1` as the third line (it stopped the hook in the control without `--safe-mode`). `--disallowedTools 'mcp__*'` and `--no-session-persistence` had no visible effect on loaded sets; keep them as defence in depth.
5. Say how Gantry finds the `claude` binary. It is not on `PATH` when Claude Code runs from the desktop app or here (`~/.local/bin/claude`). Resolve in this order: config override, `$CLAUDE_CODE_EXECPATH`, `claude` on `PATH`.
6. `claude auth status` prints JSON; gate on `loggedIn === true` (`authMethod: claude.ai` worked). Treat `false` as "no worker, enqueue only", not an error.
7. Add the measured budget: about 3 s cold start, about 0.4 s per function, about 2000 input tokens fixed per call plus about 140 per fact sheet, about 125 to 165 output tokens per function. Recommend batches of 10 to 40 per call.
8. Add that the worker must validate and repair output: `behavior` over 25 words occurred in 3 of 10 descriptions in one run, so the host enforces the limit (truncate or re-ask), and schema failures go to the backlog.
9. Keep the rule to remove `CLAUDE_CODE_EFFORT_LEVEL` from the worker env: it overrides `--effort` (about 7x output tokens with `max`).

Nothing in the recipe contradicts the spec; items 1 to 9 are additions, not corrections.
