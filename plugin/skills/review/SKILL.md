---
name: review
description: Review a branch or pull request grounded in its blast radius (changed functions, callers by hop, boundary crossings, risk). Usage /gantry:review <base>...<head> or /gantry:review --pr <n>.
disable-model-invocation: true
argument-hint: <base>...<head> | --pr <n>
---

Review `$ARGUMENTS` with the Gantry blast radius. Read only: never edit, commit, push or post anything (no GitHub comments).

1. If `$ARGUMENTS` is empty, ask for a range (`main...HEAD`) or a pull request (`--pr 42`) and stop.
2. Run `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}/bin/gantry" review $ARGUMENTS --json` in the repository root. It prints the symbol diff (`changes`, `files`, `importChanges`, `mergeBase`) and `impact` (`risk`, `callersByHop`, `crossings`, `notes`).
3. If it fails, show its message and stop. For `--pr`, a `gh` error means `gh` is missing or not logged in: suggest `gh auth login`, or the range form it names. If `impact` is null, say the repository has no index (`/gantry:init`) and review the diff without callers.
4. Review in this order, reading code with `Read`, `Grep` and `git diff <mergeBase> <head> -- <path>` only:
   - the risk level and each reason;
   - every change with `signatureChanged`: read the hop-1 callers (`callersByHop[0].ids`, `sym:<path>#<name>`) and check each call still fits the new signature;
   - removed, renamed or moved exports that notes say are still used;
   - crossings (a package used by an app, another workspace, client and server) and the other notes (undeclared imports, duplicated code);
   - then the rest of the diff.
5. Finish with a short list of findings, most serious first, each with `path:line`, what is wrong and why. Say plainly when nothing was found.
6. Call `mcp__plugin_gantry_gantry__gantry_open_view` with `view: "review"` and `filters: { range: "<base>...<head>" }` (the `base` and `head` the JSON printed) and end with the `url` it returns on its own line. Do not fetch it.
