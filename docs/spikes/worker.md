# Spike: headless `claude -p` worker recipe (issue #2)

Script: `pnpm tsx docs/spikes/worker/run.ts` (helpers and tests in `docs/spikes/worker/lib.ts`, `lib.test.ts`). Fact sheets are synthetic (3 hand-written, the rest renamed variants). No private data is used.

## Verdict: PENDING OPERATOR (neither WORKER OK nor WORKER FALLBACK yet)

Every flag in the spec section 16 recipe is accepted by the CLI and the lock-down behaves as intended (see the flag matrix). The live part could not run: the `claude` binary available to the agent that ran this spike reports `loggedIn: false` (`authMethod: none`), and every model call returns `Not logged in · Please run /login` (`terminal_reason: api_error`). Logging in is a credential action the agent must not do. All cells that need a model response are marked **pending operator**. No numbers below were invented.

If the operator run shows `structured_output` present, schema checks passing and acceptable timings, the verdict becomes **WORKER OK**. Otherwise it is **WORKER FALLBACK** (pre-commit only enqueues; describer subagents do all descriptions).

## Operator steps

In a normal terminal where `claude auth status` shows `loggedIn: true`:

```
pnpm install
pnpm tsx docs/spikes/worker/run.ts --version        # records version and auth state
pnpm tsx docs/spikes/worker/run.ts --n 10           # the Verify command
pnpm tsx docs/spikes/worker/run.ts --matrix         # fills the "structured_output" and "live outcomes" columns
pnpm tsx docs/spikes/worker/run.ts --timing         # cold start x5, then 1 / 10 / 40 fact sheets x3
pnpm tsx docs/spikes/worker/run.ts --effort-env     # env override test
```

If `claude` is not on `PATH`, pass `--claude <path>` or set `GANTRY_CLAUDE_BIN`. Paste the output into the pending cells below. Roughly 40 small Haiku calls in total.

Step 6, real Claude-made commit: in a scratch repo, install a pre-commit hook that runs the recipe (the script `--recursion` prints what to expect), then ask a Claude Code session to `git commit`. Confirm no extra Gantry hook output. This is **pending operator**; the simulation below used the same hook structure without a Claude Code session.

## Versions (step 1)

| Item | Value |
| --- | --- |
| `claude --version` | 2.1.321 (Claude Code) |
| `claude auth status` | `loggedIn: false`, `authMethod: none`, `apiProvider: firstParty` (run from the agent's sandbox; the operator's state may differ) |
| Node / pnpm | Node 22+, pnpm 10.31 (repo toolchain) |
| Binary location | Not on `PATH`. It was found via `$CLAUDE_CODE_EXECPATH` (the Claude desktop app bundles it). |

## Working command line

Confirmed to parse (all flags accepted, no `unknown option`, exit 0 through to the API call):

```
GANTRY_WORKER=1 claude -p --model haiku --effort low --safe-mode --tools '' --disallowedTools 'mcp__*' --strict-mcp-config --system-prompt-file <file> --no-session-persistence --output-format json --json-schema '<inline>'
```

stdin carries the fact sheets. `CLAUDE_CODE_EFFORT_LEVEL` is removed from the child env. The system prompt is `SYSTEM_PROMPT` in `lib.ts`; the schema is `RESULTS_SCHEMA` (the spec section 8 Description schema wrapped as `{ results: [{ content_key, description }] }`).

Whether this returns `structured_output`: **pending operator**.

## Flag matrix (step 4)

Measured with the `system/init` event of `--output-format stream-json --verbose` in a scratch directory that has a project `.mcp.json` (stub MCP server), a `CLAUDE.md` and a project skill. This part needs no login. "Live" columns need one.

| Variant | CLI parse | tools loaded | MCP servers loaded | skills / slash cmds | structured_output | live outcomes |
| --- | --- | --- | --- | --- | --- | --- |
| full recipe | accepted | 1 (`StructuredOutput`) | none | 19 / 52 | pending operator | pending operator |
| drop `--safe-mode` | accepted | 1 | none | 20 / 53 | pending operator | pending operator |
| drop `--strict-mcp-config` | accepted | 1 | none | 19 / 52 | pending operator | pending operator |
| drop `--json-schema` | accepted | 0 | none | 19 / 52 | pending operator (expected: absent) | pending operator |
| drop `--safe-mode` and `--strict-mcp-config` | accepted | 1 | **spike-stub** (project MCP loaded) | 20 / 53 | pending operator | pending operator |
| drop `--tools ''` | accepted | 27 | none | 19 / 52 | pending operator | pending operator |
| drop `--disallowedTools` | accepted | 1 | none | 19 / 52 | pending operator | pending operator |
| drop `--no-session-persistence` | accepted | 1 | none | 19 / 52 | pending operator | pending operator |

Observed:

- No combination errors at parse time.
- `--safe-mode` alone and `--strict-mcp-config` alone each keep the project MCP server out. Only dropping both lets it load. The recipe is belt and braces here.
- `--tools ''` leaves a single tool, `StructuredOutput`, and only when `--json-schema` is given. Without `--json-schema` there are zero tools. This means structured output is delivered through a synthetic tool, which is why `--tools ''` does not break it.
- Dropping `--tools ''` gives 27 built-in tools, so it is required.
- `--safe-mode` still leaves 19 skills and 52 slash commands (built-in or bundled, not user config); dropping it adds one (the scratch project skill). Built-in plugins also remain. The remaining skills only cost prompt tokens; their size effect is part of the pending token measurement.
- `--disallowedTools 'mcp__*'` had no visible effect on top of the other two flags (nothing to deny).
- `--effort` with an invalid value does not error: it prints `Warning: Unknown --effort value ... ignoring it` and uses the default. Valid: low, medium, high, xhigh, max.

## Recursion and hook guard (step 6, simulated)

Scratch git repo with a stub hook that exits at once when `GANTRY_WORKER=1`, otherwise appends to a log. The stub is registered as a Claude Code `SessionStart` hook (project `.claude/settings.json`) and called from a git `pre-commit` hook, which then runs the worker. The commit itself runs without the guard, as in a Claude-made commit. Counts exclude the outer pre-commit call.

| Worker invocation (inside git pre-commit) | worker-side hook runs that did work | worker-side guard exits |
| --- | --- | --- |
| no guard, no `--safe-mode` (positive control) | 1 | 0 |
| `GANTRY_WORKER=1`, no `--safe-mode` | 0 | 1 |
| `GANTRY_WORKER=1`, `--safe-mode` | 0 | 0 |

Findings: `claude -p` fires `SessionStart` hooks even before auth succeeds, so a worker without `--safe-mode` would re-enter Gantry hooks; `GANTRY_WORKER=1` stops that. With `--safe-mode`, project hooks do not run at all. The guard is therefore a second line of defence. A real Claude-made commit: **pending operator**.

## Timing (step 5)

All **pending operator** (`--timing`).

| Measure | Result |
| --- | --- |
| Cold start, 5 runs (n=1) | pending operator |
| Median cold start | pending operator |
| Wall time, 1 fact sheet | pending operator |
| Wall time, 10 fact sheets | pending operator |
| Wall time, 40 fact sheets | pending operator |

## Tokens per function (step 5)

**Pending operator** (`--n 10` and `--timing` print `usage.input_tokens`, `output_tokens`, cache tokens and per-function values).

| Fact sheets | input_tokens | output_tokens | output per function | all input per function |
| --- | --- | --- | --- | --- |
| 1 | pending | pending | pending | pending |
| 10 | pending | pending | pending | pending |
| 40 | pending | pending | pending | pending |

## Effort override (step 7)

- Offline: `--effort` with an invalid value only warns, with or without `CLAUDE_CODE_EFFORT_LEVEL=high` in the env, so the override is not observable that way. Neither `--debug-file` nor the init event reports the effective effort.
- Live comparison (`--effort low` with env unset vs `CLAUDE_CODE_EFFORT_LEVEL=max`, comparing output tokens and wall time): **pending operator** (`--effort-env`). Until then the spec's rule (always remove the variable from the worker env) stays, and the script does so.

## Spec changes to make

1. Section 16: `--system-prompt-file` works but does not appear in `claude --help` (only `--system-prompt` is listed; the help text mentions `--system-prompt[-file]` in passing). It is accepted in 2.1.321. Add a note to re-check it on each CLI upgrade, or fall back to `--system-prompt "$(cat file)"`.
2. Section 16: say how Gantry finds the `claude` binary. It is not on `PATH` when Claude Code runs from the desktop app; `$CLAUDE_CODE_EXECPATH` points at it inside Claude Code sessions. Git hooks run from a Claude-made commit inherit that variable, but a commit from the user's own terminal may not. Resolve in this order: config override, `$CLAUDE_CODE_EXECPATH`, `claude` on `PATH`.
3. Section 16: note that `--safe-mode` already disables project hooks and MCP, so `GANTRY_WORKER=1` and `--strict-mcp-config` are redundant but kept as defence in depth.
4. Section 16: `claude auth status` prints JSON; gate on `loggedIn === true`. In the agent sandbox it was false even though the desktop app is signed in, so Gantry must treat `loggedIn: false` as "no worker, enqueue only" rather than an error.

Nothing in the recipe contradicts the spec; items 1 to 4 are additions, not corrections. The spec file is not changed in this PR because the verdict is still open.
