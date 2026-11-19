# Installing the plugin from a local clone

The plugin lives in `plugin/`. A development marketplace file at `.claude-plugin/marketplace.json` (marketplace name `gantry-dev`) points at it, so you install it from your clone. You need Node 26, pnpm 10.31.0 and Claude Code.

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

The plugin adds the `gantry` MCP server, the `describer` agent and the read-only `explainer` agent and six skills that only you can start: `/gantry:init`, `/gantry:sync`, `/gantry:explain`, `/gantry:overview`, `/gantry:map` and `/gantry:review`. You can check the files without a session: `claude plugin validate plugin` and `claude plugin validate .claude-plugin/marketplace.json`.

## Where the data lives

The MCP server, the hooks and the skills all use one data directory per repo: the plugin data dir Claude Code gives the plugin (`~/.claude/plugins/data/gantry-gantry-dev/` for this marketplace), under `repos/<hash>/`. Commands that Claude runs through the Bash tool do not receive `CLAUDE_PLUGIN_DATA`, so the skills pass it in explicitly and `bin/gantry` derives it from its own install path when it is missing. Running `bin/gantry` from a terminal at the installed path (`~/.claude/plugins/cache/gantry-dev/gantry/<version>/bin/gantry`) gives the same directory. Running it from your clone (`<clone>/plugin/bin/gantry`) does not, so for terminal checks set `CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/gantry-gantry-dev` first.

`gantry init` prints the data dir it used (`data:`), and `gantry backlog` prints it too (`Data:`, or `data_dir` with `--json`), so you can check that the CLI and the MCP server read the same store. A describer that finds no index in its data dir reports `NOT INDEXED` with that dir instead of an empty backlog.

An index written earlier to `~/.gantry/data/repos/<hash>/` (what the CLI used from a skill before #141) is still found: it is used as long as the plugin data dir has no store (`gantry.db`) for that repo yet. An empty directory there is ignored, and commands that only read (`backlog`, `usage`, `heal`), the session-start hook and the git hooks never create one for a repo without an index (before #147, `backlog`, `usage` and `heal` created an empty store whenever they ran in a repo with no index, which then made the session-start hook skip its "run /gantry:init" reminder).

### Removing an orphaned legacy index

Once the plugin data dir has its own index for a repo, the old copy under `~/.gantry/data/repos/<hash>/` is no longer read. `gantry backlog` then prints `Note: an older index for this repository is still in <dir> and is no longer used` (`legacy_data_dir` with `--json`). To remove it:

1. In the repo, run `"<plugin>/bin/gantry" backlog --json` and check that `indexed` is true and `data_dir` is the plugin data dir, not the `legacy_data_dir`.
2. If git hooks were installed while the old index was in use, run `"<plugin>/bin/gantry" hooks install` again so the hook scripts carry the plugin data dir.
3. Delete the directory named in `legacy_data_dir` (`rm -rf ~/.gantry/data/repos/<hash>`). Do not run `gantry uninstall` for this: it deletes the data dir in use and removes the git hooks.

### After an upgrade

When an upgrade changes what indexing writes for unchanged files (new framework adapters, for example), the index records it (`meta.index_format`) and the first run after the upgrade re-indexes the whole repo once, so the new facts appear for every file and not only the ones you edit. The first Gantry tool call in a session, the explorer's Refresh, `gantry map`, `gantry heal` or a git hook (post-checkout, post-merge, post-rewrite, pre-push) runs it; it takes about as long as `gantry index`. The session-start hook does not wait for it, so a session starts as quickly as before. Descriptions and embeddings are kept. To do it right away, run `"<plugin>/bin/gantry" heal` in the repo.

To start over with a fresh index instead, delete `~/.gantry/data/repos/<hash>/` (or run `gantry uninstall` in the repo) and re-run `/gantry:init`.

## Use

- `/gantry:init` in a TypeScript git repo: indexes it, shows the estimate (functions to describe, tokens, batches), asks whether to describe everything, exported functions only, or later, then starts 4 background `describer` agents. You can keep working. It offers to install the git hooks.
- `/gantry:sync`: shows the backlog (`gantry backlog --json`) and starts describers for what is left. Run it again after an interruption: a claim that was not submitted expires after 10 minutes and returns to the queue.
- Large backlogs: a describer's run ends after 15 claims (about 150 functions), with a `MORE WORK` report, well before the subagent's `maxTurns` of 60. While work is left, `/gantry:init` and `/gantry:sync` start a fresh describer with the same worker id; they do not resume the old one, which would carry its whole history. The server hands the new run any batch the old one left unsubmitted. No env vars, worker ids or size overrides are needed.
- `/gantry:explain <target>`: a function, `path:line`, file, workspace or folder explained in at most 200 words with `path:line` references. Reads only.
- `/gantry:overview <workspace|dir>`: the cached overview if code inside has not changed, else the `explainer` writes and saves one. Overviews are never written unless you ask. They show in the explorer inspector for workspaces and folders.
- `/gantry:map [view] [focus]`: opens the explorer and prints its URL.
- `/gantry:review <base>...<head>` or `/gantry:review --pr <n>`: reviews a branch or pull request from its blast radius (`gantry review --json`): risk first, then changed signatures with their direct callers, crossings and notes, and ends with a short list of findings and a link to the review view. Reads only; it never posts to GitHub. `--pr` needs a logged-in `gh`.
- `"<plugin>/bin/gantry" backlog [--json]` shows pending, claimed and failed counts, the split by priority (0 exported and entry files, 1 other exported, 2 local) and the data dir. `backlog --failed [--json]` lists each failed function with the rule name of its last rejection (for example `identifier` or `shape`; the description text is never shown), and `backlog --retry-failed` puts them back to pending for the next `/gantry:sync`.

## Operator check (an interactive session is required)

This is the acceptance check for the plugin. It makes real model calls (Haiku) on a copy of a fixture. Use only `fixtures/`, never a private repo.

1. Copy the fixture to a scratch git repo outside this clone:

   ```sh
   FX=$(mktemp -d)/pnpm-turbo && cp -R fixtures/pnpm-turbo "$FX" && cd "$FX" \
     && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
   ```
2. Start Claude Code in `$FX` (`cd "$FX" && claude`). Run `/plugin marketplace add <clone path>`, `/plugin install gantry@gantry-dev`, `/reload-plugins`. Check `/plugin` shows `gantry` enabled with no errors and `/mcp` shows `plugin:gantry:gantry` connected.
3. In a second terminal, set `export CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/gantry-gantry-dev` (the directory the plugin uses, see above) and `G=<clone path>/plugin/bin/gantry`, and run `cd "$FX" && "$G" init --estimate` once, so you know the total. Run `"$G" backlog --json` and note `total` (call it N) then note the time right before you start step 4 (`date +%s`, call it T0).
4. In the session run `/gantry:init`. Expect the estimate, then the question. Answer "everything". Expect 4 background `describer` agents.
5. Watch progress: `watch -n 10 "cd $FX && $G backlog --json"`. `byStatus.pending` falls in steps of 10 per agent and reaches 0; `claimed` returns to 0 once every agent finishes. `failed` should stay 0 or small; `"$G" backlog --failed` names the rule each one failed. `data_dir` must match the `data:` line of `/gantry:init`. On a backlog above about 600 functions, expect describers to report `MORE WORK` and the session to start fresh ones with the same ids until the backlog is done.
6. When `pending` and `claimed` are both 0, note the time (T1). Functions per minute = `N_done / ((T1 - T0) / 60)`, where `N_done = N - failed`. Also run `"$G" usage` and `"$G" search <word>`, and confirm `git -C "$FX" status --porcelain` is empty (nothing is written into the repo).
7. Check the tool limit: in the session, ask `/agents` (or the transcript of a describer) and confirm it only called `gantry_claim_batch` and `gantry_submit_descriptions`.
8. Record N, T1 - T0, functions per minute and the `failed` count in the PR.

### Hooks check (PostToolUse, Stop and SessionStart)

No model calls and no description run are needed for this one. Do it in the same scratch repo `$FX` with the plugin installed (the index must exist: run `"$G" init` first).

1. Run `claude plugin validate plugin`; it must pass and list the hooks. In the session, `/hooks` shows `SessionStart`, `PostToolUse` and `Stop` entries from the `gantry` plugin.
2. Start a new session in `$FX`. If you ran `"$G" init`, no line appears (or `Gantry: N functions await descriptions ...` when the backlog is at or above the threshold). In a repo that has no index, the line is `Gantry: run /gantry:init to index this repo`.
3. Ask Claude: "Create `apps/web/src/lib/new.ts` with a `slugify(input: string): string` function that lowercases, trims, turns whitespace into dashes, strips anything outside a-z, 0-9 and dash, collapses repeated dashes and trims leading and trailing dashes." At the end of that turn (the `Stop` hook; the edit itself prints nothing), Claude should say it saw a Gantry note and switch to `import { slugify } from './slug'` (or tell you it exists). The note itself is in the transcript (`ctrl+o`) as `Gantry: slugify (apps/web/src/lib/new.ts:1) looks like slugify in apps/web/src/lib/slug.ts:1 [exact 1.00]. Import it: ...` (the tier may be `near` if Claude words the function differently).
4. Ask Claude to add `import { db } from "@acme/db"` to a file in `apps/web/src`. Expect `Gantry: Declare "@acme/db" in apps/web/package.json (line N)`.
5. Ask for an unrelated edit (a new constant). Expect no Gantry text at all.
6. `git -C "$FX" status --porcelain` shows only the files Claude wrote, nothing from Gantry. Run `git add -A && git commit -m t` after `"$G" hooks install`: the same findings appear on stderr in the Bash output and the commit succeeds.
7. Ask Claude, in one request, to add `import { db } from "@acme/db"` to a file in `apps/web/src` and to add `"@acme/db": "workspace:*"` to `apps/web/package.json`. Expect no Gantry text: the check runs once the turn's edits are done.
8. Time one hook run by hand (without a session id the edit is settled at once): `time (echo '{"tool_name":"Write","tool_input":{"file_path":"'"$FX"'/apps/web/src/lib/new.ts"},"cwd":"'"$FX"'"}' | "$G" hook post-tool-use)`; record it in the PR.

### Explainer check (`/gantry:explain`, `/gantry:overview`, `/gantry:map`)

Interactive session required: it makes real model calls (Sonnet). Use the scratch repo `$FX` of the first check, with the plugin installed and the index built (`"$G" init`). Descriptions are not needed; run `/gantry:init` first if you want the explainer to see them.

1. In the session in `$FX` run `/gantry:explain formatRelativeDate`. Expect an answer of at most 200 words that names `packages/utils/src/date.ts:1` (where it is defined), its callers or the fact that nothing calls it, and `path:line` references for every claim. In the transcript (`ctrl+o`) the `explainer` subagent used only `gantry_*`, `Read`, `Grep` or `Glob` calls. Record the answer in the issue.
2. Run `/gantry:overview @acme/utils`. Expect an overview of at most 1,200 characters, then `"$G" usage` shows a row with task `overview` and source `explainer`. Run it again: it returns the same text at once with no subagent and no new usage row.
3. Edit a function in `packages/utils/src/date.ts` (add a statement) and run `/gantry:overview @acme/utils` again: a new overview is written.
4. Run `/gantry:map project-map ws:@acme/utils`. Expect a `http://127.0.0.1:<port>/...` link; open it. Select the `@acme/utils` workspace: the inspector shows "Overview — generated, may be wrong" with the text from step 3. Select `@acme/web`: it shows "Run /gantry:overview ws:@acme/web in Claude Code".
5. `git -C "$FX" status --porcelain` is empty (nothing was written into the repo) and `/agents` shows `explainer` with no `Write`, `Edit` or `Bash` tool.

Clean up with `/plugin uninstall gantry@gantry-dev`, `/plugin marketplace remove gantry-dev` and `"$G" uninstall` in `$FX`.
