# Gantry

Gantry is a Claude Code plugin: a codebase map, function index and reuse guard for TypeScript repos. This repo holds the plugin (`plugin/`), the indexing library, CLI, MCP server and explorer (`packages/`).

## Rules

- Follow `docs/SPEC.md`. It is the source of truth for contracts. If an issue conflicts with it, follow the spec and flag the conflict in the PR. To change a contract, edit the spec in the same PR and say so.
- Run `pnpm check` (biome, tsc, vitest) before every PR. It must pass. There is no hosted CI and no GitHub Actions.
- This repo is public. Never commit code, descriptions, graph dumps or screenshots from private repos (the Devprentice test bed). Private eval data lives only in git-ignored `evals/private/`.
- Branch names: `gantry/<issue-number>-<slug>`. One branch and PR per issue.
- PR descriptions say `Closes #<n>`.
- Add only dependencies listed in spec section 2.
