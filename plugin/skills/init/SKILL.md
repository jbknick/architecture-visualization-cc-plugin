---
name: init
description: Index this repository with Gantry and start background describers. Run once per repository.
disable-model-invocation: true
---

Set up Gantry for the current repository. Do the steps in order and stop to ask where marked.

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/gantry" init --estimate` in the repository root. It indexes the code and prints the cost projection; it makes no model calls and writes nothing into the working tree.
2. Show the user the numbers: functions to describe, projected tokens, batches, rounds. Do not invent a time estimate beyond what the command prints.
3. Ask which they want:
   - describe everything now,
   - exported and entry-file functions only (run `"${CLAUDE_PLUGIN_ROOT}/bin/gantry" init --estimate --exports-first` to show that estimate first),
   - later (stop here; they can run `/gantry:sync` any time).
4. If they chose to describe, run `"${CLAUDE_PLUGIN_ROOT}/bin/gantry" init` to make sure the backlog is current, then start 4 `describer` subagents in the background, all in one message, each with the prompt "Work through the Gantry backlog until it is empty." For the exports-only choice, tell the user the describers work in priority order, exported functions first, and can be stopped once those are done.
5. Tell the user the describers run in the background, that they can keep working, and that `"${CLAUDE_PLUGIN_ROOT}/bin/gantry" backlog --json` shows progress. Claims expire after 10 minutes, so an interrupted run resumes with `/gantry:sync`.
6. Offer to run `"${CLAUDE_PLUGIN_ROOT}/bin/gantry" hooks install` (git hooks that keep the index fresh). Only run it if they say yes.
