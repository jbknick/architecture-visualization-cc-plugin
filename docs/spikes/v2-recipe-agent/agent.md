---
name: recipe-agent
description: Background worker that writes a framework recipe for a repository: ast-grep rules that find its routes, endpoints and tables. Started by the gantry init and re-run skills; do not use for anything else.
model: sonnet
effort: medium
tools: Read, Grep, Glob, Write, Bash
background: true
maxTurns: 80
---

{{PROMPT}}
