---
name: sync
description: Show the Gantry description backlog and start background describers to work through it.
disable-model-invocation: true
---

Work through the remaining Gantry description backlog.

1. Run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" heal` in the repository root to bring the index up to date. It makes no model calls, and it creates nothing when the repository has no index.
2. Run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" backlog --json`. If `indexed` is false, tell the user this repository has no Gantry index in `data_dir` yet, suggest `/gantry:init`, and stop. Otherwise show the counts by status (pending, claimed, failed) and by priority (0 exported and entry files, 1 other exported, 2 local), and the `data_dir`. If `legacy_data_dir` is set, mention that an older, unused index is there and docs/INSTALL.md explains how to remove it.
3. If `pending` and `claimed` are both 0, say the backlog is empty. If `failed` is above 0, offer `backlog --failed` (rule names per function) and `backlog --retry-failed` (back to pending). Then stop.
4. Otherwise start up to 4 `describer` subagents in the background, all in one message, each with its own worker id in the prompt: "Your worker id is sync-1. Work through the Gantry backlog until it is empty." (sync-2, sync-3 and sync-4 for the others; never give two describers the same id) Use one describer per 40 pending functions, at least 1, at most 4.
5. Tell the user the describers run in the background, that they can keep working, and that re-running `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" backlog --json` shows progress. If usage runs low they can stop and run `/gantry:sync` later: unfinished claims expire after 10 minutes and return to the queue.
6. Keep the describers going until the backlog is done. A describer hands back after a fixed number of batches, well before its turn limit. Each time one finishes:
   - `MORE WORK`, or a result marked partial or cut off: start a fresh `describer` in the background with the same prompt and worker id. Start a new one; do not resume the old one with SendMessage, which keeps its whole history. The server hands it any batch the old one left unsubmitted.
   - `DONE`: run `backlog --json`; restart that worker id only if `pending` is above 0.
   - `NOT INDEXED`: stop restarting and tell the user the describer's data dir has no index; show it next to `data_dir` from `backlog --json`.
   - `ERROR`, or two runs in a row of the same worker id with 0 accepted: stop restarting that id and tell the user.
   Stop restarting when the user asks. When every describer is done, show the counts and, if `failed` is above 0, offer `backlog --failed` and `backlog --retry-failed`.
