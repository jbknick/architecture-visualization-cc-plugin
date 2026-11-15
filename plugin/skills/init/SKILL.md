---
name: init
description: Index this repository with Gantry and start background describers. Run once per repository.
disable-model-invocation: true
---

Set up Gantry for the current repository. Do the steps in order and stop to ask where marked.

1. Run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" init --estimate` in the repository root. It indexes the code and prints the cost projection and the data dir it used (`data:`); it makes no model calls and writes nothing into the working tree.
2. Show the user the numbers: functions to describe, projected tokens, batches, rounds, and the data dir. Do not invent a time estimate beyond what the command prints.
3. Ask which they want:
   - describe everything now,
   - exported and entry-file functions only (run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" init --estimate --exports-first` to show that estimate first),
   - later (stop here; they can run `/gantry:sync` any time).
4. If they chose to describe, run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" init` to make sure the backlog is current, then start 4 `describer` subagents in the background, all in one message, each with its own worker id in the prompt: "Your worker id is init-1. Work through the Gantry backlog until it is empty. When a submit rejects an item, rewrite it from the code following that rejection's fix and resubmit while resubmit is true." (init-2, init-3 and init-4 for the others; never give two describers the same id) For the exports-only choice, tell the user the describers work in priority order, exported functions first, and can be stopped once those are done.
5. Tell the user the describers run in the background, that they can keep working, and that `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" backlog --json` shows progress.
6. Keep the describers going until the backlog is done. A describer hands back after a fixed number of batches, well before its turn limit. Each time one finishes:
   - `MORE WORK`, or a result marked partial or cut off: start a fresh `describer` in the background with the same prompt and worker id. Start a new one; do not resume the old one with SendMessage, which keeps its whole history. The server hands it any batch the old one left unsubmitted.
   - `DONE`: run `backlog --json`; restart that worker id only if `pending` is above 0.
   - `NOT INDEXED`: stop restarting and tell the user the describer's data dir has no index; show it next to `data_dir` from `backlog --json`.
   - `ERROR`, or two runs in a row of the same worker id with 0 accepted: stop restarting that id and tell the user.
   Stop restarting when the user asks. When every describer is done, show `backlog --json` counts, `fallback` included (functions the server described without a model after repeated wording rejections). If `failed` is above 0, offer `backlog --failed` (rule names per function) and `backlog --retry-failed` (back to pending, then `/gantry:sync`). Claims of an interrupted run expire after 10 minutes, so `/gantry:sync` resumes it.
7. Offer to run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" hooks install` (git hooks that keep the index fresh). Only run it if they say yes.
