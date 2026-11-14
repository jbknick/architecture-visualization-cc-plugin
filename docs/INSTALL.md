# Installing the plugin from a local clone

The plugin lives in `plugin/`. A development marketplace file at `.claude-plugin/marketplace.json` (marketplace name `gantry-dev`) points at it, so you install it from your clone. You need Node 22 or newer, pnpm and Claude Code.

## Install

```sh
git clone https://github.com/jbknick/architecture-visualization-cc-plugin.git
cd architecture-visualization-cc-plugin
pnpm install && pnpm build
```

`pnpm build` writes `plugin/dist/` (the CLI, the MCP server and the explorer). The plugin does not work without it. Then, in a Claude Code session:

```
/plugin marketplace add /absolute/path/to/architecture-visualization-cc-plugin
/plugin install gantry@gantry-dev
/reload-plugins
```

The plugin adds the `gantry` MCP server, the `describer` agent and two skills that only you can start: `/gantry:init` and `/gantry:sync`. You can check the files without a session: `claude plugin validate plugin` and `claude plugin validate .claude-plugin/marketplace.json`.

## Use

- `/gantry:init` in a TypeScript git repo: indexes it, shows the estimate (functions to describe, tokens, batches), asks whether to describe everything, exported functions only, or later, then starts 4 background `describer` agents. You can keep working. It offers to install the git hooks.
- `/gantry:sync`: shows the backlog (`gantry backlog --json`) and starts describers for what is left. Run it again after an interruption: a claim that was not submitted expires after 10 minutes and returns to the queue.
- `"<plugin>/bin/gantry" backlog [--json]` shows pending, claimed and failed counts and the split by priority (0 exported and entry files, 1 other exported, 2 local).

## Operator check (an interactive session is required)

This is the acceptance check for the plugin. It makes real model calls (Haiku) on a copy of a fixture. Use only `fixtures/`, never a private repo.

1. Copy the fixture to a scratch git repo outside this clone:

   ```sh
   FX=$(mktemp -d)/pnpm-turbo && cp -R fixtures/pnpm-turbo "$FX" && cd "$FX" \
     && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
   ```
2. Start Claude Code in `$FX` (`cd "$FX" && claude`). Run `/plugin marketplace add <clone path>`, `/plugin install gantry@gantry-dev`, `/reload-plugins`. Check `/plugin` shows `gantry` enabled with no errors and `/mcp` shows `plugin:gantry:gantry` connected.
3. In a second terminal, set `G=<clone path>/plugin/bin/gantry` and run `cd "$FX" && "$G" init --estimate` once, so you know the total. Run `"$G" backlog --json` and note `total` (call it N) then note the time right before you start step 4 (`date +%s`, call it T0).
4. In the session run `/gantry:init`. Expect the estimate, then the question. Answer "everything". Expect 4 background `describer` agents.
5. Watch progress: `watch -n 10 "cd $FX && $G backlog --json"`. `byStatus.pending` falls in steps of 40 per agent and reaches 0; `claimed` returns to 0 once every agent finishes. `failed` should stay 0 or small.
6. When `pending` and `claimed` are both 0, note the time (T1). Functions per minute = `N_done / ((T1 - T0) / 60)`, where `N_done = N - failed`. Also run `"$G" usage` and `"$G" search <word>`, and confirm `git -C "$FX" status --porcelain` is empty (nothing is written into the repo).
7. Check the tool limit: in the session, ask `/agents` (or the transcript of a describer) and confirm it only called `gantry_claim_batch` and `gantry_submit_descriptions`.
8. Record N, T1 - T0, functions per minute and the `failed` count in the PR.

Clean up with `/plugin uninstall gantry@gantry-dev`, `/plugin marketplace remove gantry-dev` and `"$G" uninstall` in `$FX`.
