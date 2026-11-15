---
name: map
description: Open the Gantry architecture explorer in the browser. Usage /gantry:map [view] [focus].
disable-model-invocation: true
argument-hint: [view] [focus]
---

Open the architecture explorer for this repository.

1. Take `view` from the first word of `$ARGUMENTS` (default `project-map`) and `focus` from the second (a node id such as `ws:@acme/ui`, `file:<path>` or `sym:<path>#<name>`; leave it out if none).
2. Call `mcp__plugin_gantry_gantry__gantry_open_view` with `view` and `focus`.
3. Print the `url` it returns on its own line and tell the user to open it in a browser. Do not fetch it. The link carries a private access token and works on this machine only.
4. If it returns `unknown_view`, list the `views` it gives and ask which one. If it returns `explorer_unavailable`, show the message.
