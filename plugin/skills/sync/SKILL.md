---
name: sync
description: Show the Gantry description backlog and start background describers to work through it.
disable-model-invocation: true
---

Work through the remaining Gantry description backlog.

1. Run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" heal` in the repository root to bring the index up to date. It makes no model calls.
2. Run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" backlog --json` and show the user the counts by status (pending, claimed, failed) and by priority (0 exported and entry files, 1 other exported, 2 local).
3. If `pending` and `claimed` are both 0, say the backlog is empty and stop.
4. Otherwise start up to 4 `describer` subagents in the background, all in one message, each with its own worker id in the prompt: "Your worker id is sync-1. Work through the Gantry backlog until it is empty." (sync-2, sync-3 and sync-4 for the others; never give two describers the same id) Use one describer per 40 pending functions, at least 1, at most 4.
5. Tell the user the describers run in the background, that they can keep working, and that re-running `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" backlog --json` shows progress. If usage runs low they can stop and run `/gantry:sync` later: unfinished claims expire after 10 minutes and return to the queue.
