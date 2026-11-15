# Security policy

## Supported versions

The project is in early development and has no releases yet. Only the latest `main` gets fixes.

## Reporting a vulnerability

Please do not report security problems in a public issue, discussion or PR.

Open an issue titled "Security contact request" with **no details** of the problem, and the maintainer will arrange a private channel with you. Include a description, steps to reproduce and the affected version or commit once that channel is set up. You should hear back within a week.

## What counts

Things we especially want to hear about:

- the explorer server answering requests without its per-run token, or binding to anything other than `127.0.0.1`
- files that match the sensitive path patterns (`.env*`, `*.pem`, `*.key` and so on) being read or indexed
- path traversal, or command injection through repository content, file names or MCP tool arguments
- model-written descriptions, or other content taken from an indexed repo, that can steer the plugin's agents or hooks into actions the user did not ask for
- git hooks that block a commit or push, or run code from the indexed repo, when they should fail open
