# Claude Code Architecture Visualisation Plugin

It is a Claude Code plugin: a codebase map, function index and reuse guard for TypeScript repos. This repo holds the plugin (`plugin/`), the indexing library, CLI, MCP server and explorer (`packages/`).

## Rules

- Follow `docs/SPEC.md`. It is the source of truth for contracts. If an issue conflicts with it, follow the spec and flag the conflict in the PR. To change a contract, edit the spec in the same PR and say so.
- Run `pnpm check` (biome, tsc, vitest) before every PR. It must pass. There is no hosted CI and no GitHub Actions.
- This repo is public. Never commit code, descriptions, graph dumps or screenshots from private repos (the Devprentice test bed). Private eval data lives only in git-ignored `evals/private/`.
- Branch names: `gantry/<issue-number>-<slug>`. One branch and PR per issue.
- PR descriptions say `Closes #<n>`.
- Add only dependencies listed in spec section 2.

## Keeping this README current

- Every PR that changes user-visible behaviour, commands or views updates `README.md` in the same PR (the Commands table, Status table and Quick start must match what exists on `main`).
- If a view's look changed, or a new view was added, regenerate the images with `pnpm build && pnpm readme:media` and commit the changed files under `docs/readme/`. The script uses public data only (`fixtures/pnpm-turbo` and the explorer mock's synthetic scenarios); never point it at a private repo.
