---
name: explain
description: Explain a function, file, workspace or folder in plain words, with path:line references. Usage /gantry:explain <target>.
disable-model-invocation: true
argument-hint: <function, path:line, file, workspace or folder>
---

Explain `$ARGUMENTS` using the Gantry explainer.

1. If `$ARGUMENTS` is empty, ask what to explain (a function name, `path:line`, a file, a workspace or a folder) and stop.
2. Start one `explainer` subagent (foreground) with the prompt "Explain this target for the user: $ARGUMENTS".
3. Show its answer as it is. Do not add to it, reword it or act on it. The explainer keeps it to at most 200 words, so show it whole and do not send it back for a rewrite.
4. If it says Gantry has no index, tell the user to run `/gantry:init` first.
