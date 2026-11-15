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

The plugin adds the `gantry` MCP server, the `describer` agent and the read-only `explainer` agent and five skills that only you can start: `/gantry:init`, `/gantry:sync`, `/gantry:explain`, `/gantry:overview` and `/gantry:map`. You can check the files without a session: `claude plugin validate plugin` and `claude plugin validate .claude-plugin/marketplace.json`.

## Use

- `/gantry:init` in a TypeScript git repo: indexes it, shows the estimate (functions to describe, tokens, batches), asks whether to describe everything, exported functions only, or later, then starts 4 background `describer` agents. You can keep working. It offers to install the git hooks.
- `/gantry:sync`: shows the backlog (`gantry backlog --json`) and starts describers for what is left. Run it again after an interruption: a claim that was not submitted expires after 10 minutes and returns to the queue.
- `/gantry:explain <target>`: a function, `path:line`, file, workspace or folder explained in at most 200 words with `path:line` references. Reads only.
- `/gantry:overview <workspace|dir>`: the cached overview if code inside has not changed, else the `explainer` writes and saves one. Overviews are never written unless you ask. They show in the explorer inspector for workspaces and folders.
- `/gantry:map [view] [focus]`: opens the explorer and prints its URL.
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

### Hooks check (PostToolUse and SessionStart)

No model calls and no description run are needed for this one. Do it in the same scratch repo `$FX` with the plugin installed (the index must exist: run `"$G" init` first).

1. Run `claude plugin validate plugin`; it must pass and list the hooks. In the session, `/hooks` shows `SessionStart` and `PostToolUse` entries from the `gantry` plugin.
2. Start a new session in `$FX`. If you ran `"$G" init`, no line appears (or `Gantry: N functions await descriptions ...` when the backlog is at or above the threshold). In a repo that has no index, the line is `Gantry: run /gantry:init to index this repo`.
3. Ask Claude: "Create `apps/web/src/lib/new.ts` with a `slugify(input: string): string` function that lowercases, trims, turns whitespace into dashes, strips anything outside a-z, 0-9 and dash, collapses repeated dashes and trims leading and trailing dashes." After the Write, Claude should say it saw a Gantry note and switch to `import { slugify } from './slug'` (or tell you it exists). The note itself is in the transcript (`ctrl+o`) as `Gantry: slugify (apps/web/src/lib/new.ts:1) looks like slugify in apps/web/src/lib/slug.ts:1 [exact 1.00]. Import it: ...` (the tier may be `near` if Claude words the function differently).
4. Ask Claude to add `import { db } from "@acme/db"` to a file in `apps/web/src`. Expect `Gantry: Declare "@acme/db" in apps/web/package.json (line N)`.
5. Ask for an unrelated edit (a new constant). Expect no Gantry text at all.
6. `git -C "$FX" status --porcelain` shows only the files Claude wrote, nothing from Gantry. Run `git add -A && git commit -m t` after `"$G" hooks install`: the same findings appear on stderr in the Bash output and the commit succeeds.
7. Time one hook run by hand: `time (echo '{"tool_name":"Write","tool_input":{"file_path":"'"$FX"'/apps/web/src/lib/new.ts"},"cwd":"'"$FX"'"}' | "$G" hook post-tool-use)`; record it in the PR.

### Explainer check (`/gantry:explain`, `/gantry:overview`, `/gantry:map`)

Interactive session required: it makes real model calls (Sonnet). Use the scratch repo `$FX` of the first check, with the plugin installed and the index built (`"$G" init`). Descriptions are not needed; run `/gantry:init` first if you want the explainer to see them.

1. In the session in `$FX` run `/gantry:explain formatRelativeDate`. Expect an answer of at most 200 words that names `packages/utils/src/date.ts:1` (where it is defined), its callers or the fact that nothing calls it, and `path:line` references for every claim. In the transcript (`ctrl+o`) the `explainer` subagent used only `gantry_*`, `Read`, `Grep` or `Glob` calls. Record the answer in the issue.
2. Run `/gantry:overview @acme/utils`. Expect an overview of at most 1,200 characters, then `"$G" usage` shows a row with task `overview` and source `explainer`. Run it again: it returns the same text at once with no subagent and no new usage row.
3. Edit a function in `packages/utils/src/date.ts` (add a statement) and run `/gantry:overview @acme/utils` again: a new overview is written.
4. Run `/gantry:map project-map ws:@acme/utils`. Expect a `http://127.0.0.1:<port>/...` link; open it. Select the `@acme/utils` workspace: the inspector shows "Overview — generated, may be wrong" with the text from step 3. Select `@acme/web`: it shows "Run /gantry:overview ws:@acme/web in Claude Code".
5. `git -C "$FX" status --porcelain` is empty (nothing was written into the repo) and `/agents` shows `explainer` with no `Write`, `Edit` or `Bash` tool.

Clean up with `/plugin uninstall gantry@gantry-dev`, `/plugin marketplace remove gantry-dev` and `"$G" uninstall` in `$FX`.
