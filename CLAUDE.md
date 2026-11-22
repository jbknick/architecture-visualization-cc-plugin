# Claude Code Architecture Visualisation Plugin

It is a Claude Code plugin: a codebase map, function index and reuse guard for TypeScript repos. This repo holds the plugin (`plugin/`), the indexing library, CLI, MCP server and explorer (`packages/`).

## Rules

- Follow `docs/SPEC.md`. It is the source of truth for contracts. If a brief conflicts with it, follow the spec and flag the conflict in the PR. To change a contract, edit the spec in the same PR and say so.
- Per PR, run `biome check` on the files you changed, `tsc -b` if you changed code, and only the vitest folders you touched. The maintainer runs the full `pnpm check` on `main`, not per PR. There is no CI service and no GitHub Actions.
- This repo is public. Never commit code, descriptions, graph dumps or screenshots from private repos (the Devprentice test bed). Private eval data lives only in git-ignored `evals/private/`.
- Branch names: `gantry/<slug>`. One branch and PR per piece of work.
- The PR body is three lines (what changed, how it was checked, differences from the brief) plus the generated-with line.
- Add only dependencies listed in spec section 2.

## Keeping this README current

- Every PR that changes user-visible behaviour, commands or views updates `README.md` in the same PR (the Commands table, Status table and Quick start must match what exists on `main`).
- If a view's look changed, or a new view was added, regenerate the images with `pnpm build && pnpm readme:media` and commit the changed files under `docs/readme/`. The PNGs are deterministic (re-running changes nothing); `explorer-tour.gif` is captured mid-animation, so it is rewritten only with `pnpm readme:media --gif`. The script uses public data only (`fixtures/pnpm-turbo` and the explorer mock's synthetic scenarios); never point it at a private repo.
