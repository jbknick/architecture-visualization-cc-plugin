# Gantry

A Claude Code plugin that maps a TypeScript codebase as a graph, describes every function in plain words, and stops AI agents from rewriting code that already exists.

> **Status:** early development. Nothing to install yet.

## Why

Coding agents often write a new helper when an equivalent one already exists, usually because the existing one has a name that doesn't say what it does. Gantry gives Claude a searchable index of every function, describes each one by what its body actually does, and checks new code against it before duplicates land.

## What it does

- **Maps the repo.** Workspaces, files, functions, components and hooks, with imports, calls and renders between them. Monorepos first (pnpm, npm/yarn workspaces, Nx, Turborepo).
- **Describes every function.** One sentence per function, written by the cheapest model that does the job well (Haiku at low effort by default). Descriptions are keyed by content hash, so unchanged code is never described twice.
- **Guards against duplicates.** Right after Claude writes a function, Gantry checks for exact, near, code-similar and same-meaning matches and says how to reuse the existing one, for example "import it from `@acme/utils`". It also flags imports of packages a workspace hasn't declared.
- **Gives agents tools.** An MCP server with search, browse, find-similar, impact and trace tools.
- **Shows it visually.** A local explorer in the browser: project map, who calls a function, duplicate clusters, pages and feature slices. Later: endpoints, page → API → table chains, and a code review "blast radius" view. It updates live as files change.

## How it works

- Runs locally on your Claude Code login. No API key.
- Deterministic tools first: oxc parsing, import-binding resolution, structural hashes, SQLite with full-text and vector search, local embeddings. Models are used only for descriptions and for explanations you ask for.
- Writes nothing into your repo except optional git hooks. The index lives in Gantry's own data folder, one per worktree.
- Never reads `.env` files, keys or other sensitive files.

## Roadmap

| Milestone | Scope |
| --- | --- |
| M0 Spikes | Prove the risky parts: headless Claude calls, description quality, embeddings, the import graph |
| M1 Structural graph | Workspace detection, parsing, import resolution, local index, git hooks |
| M2 Reuse guard | Function descriptions, duplicate detection, reuse advice, MCP tools, Claude Code hooks |
| M3 Explorer | Browser graph with project map, function, duplicate, page and feature views |
| M4 Live updates | The explorer updates as you save |
| M5 Code review | Blast radius of a change or pull request |
| M6 Framework adapters | TanStack Start, Hono, oRPC and Drizzle: page → API → table views |

## Repository

The repo is named `architecture-visualization-cc-plugin`; the plugin, CLI and MCP server are named `gantry`.

## License

[MIT](LICENSE). Use it for anything; just keep the copyright notice.
