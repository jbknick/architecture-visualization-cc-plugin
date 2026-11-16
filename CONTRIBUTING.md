# Contributing

Thanks for wanting to help. This is an early-stage project, so contracts still move. Read this page before you open a PR, then read [`docs/SPEC.md`](docs/SPEC.md).

## Before you start

- **Questions and ideas** go in [Discussions](https://github.com/jbknick/architecture-visualization-cc-plugin/discussions).
- **Bugs and concrete feature requests** go in [Issues](https://github.com/jbknick/architecture-visualization-cc-plugin/issues/new/choose). Use the templates.
- **Anything larger than a small fix**: comment on the issue (or open one) first, so we can agree the approach before you write code. Issues labelled `good first issue` or `help wanted` are good places to start.
- **Security problems**: do not open a public issue. See [`SECURITY.md`](SECURITY.md).

## Set up

You need Node 22 or newer and pnpm 10 (the version is pinned in `package.json`; `corepack enable` picks it up).

```sh
git clone https://github.com/<you>/architecture-visualization-cc-plugin.git
cd architecture-visualization-cc-plugin
pnpm install
pnpm build    # writes plugin/dist/ (CLI, MCP server, explorer)
pnpm check    # biome + tsc + vitest
```

To try the plugin in Claude Code from your clone, follow [`docs/INSTALL.md`](docs/INSTALL.md). The explorer's notes, including how to run it against the mock API, are in [`packages/explorer/web/README.md`](packages/explorer/web/README.md).

## Rules for a PR

These come from [`CLAUDE.md`](CLAUDE.md), which also guides the coding agents that work on this repo.

1. **The spec wins.** [`docs/SPEC.md`](docs/SPEC.md) is the source of truth for contracts. If an issue conflicts with it, follow the spec and say so in the PR. To change a contract, edit the spec in the same PR and say so.
2. **`pnpm check` must pass.** There is no hosted CI, so run it locally before you open or update a PR. Use `pnpm fmt` to apply Biome fixes.
3. **No private code or data.** This repo is public. Never commit code, descriptions, graph dumps or screenshots from a private repository. Tests and screenshots use `fixtures/` and the explorer mock's synthetic scenarios only. Private eval data belongs in the git-ignored `evals/private/`.
4. **Dependencies.** Add only dependencies listed in section 2 of the spec. If you need another one, propose it in the issue first.
5. **One issue per PR.** Keep a PR to one issue and say `Closes #<n>` in the description. A branch name like `gantry/<issue-number>-<slug>` is welcome but not required on forks.
6. **Keep the README current.** If you change user-visible behaviour, commands or views, update `README.md` in the same PR (the Commands table, Status table and Quick start must match `main`). If a view's look changed, run `pnpm build && pnpm readme:media` and commit the changed files under `docs/readme/`. That needs Chromium for Playwright: `pnpm --filter @gantry/explorer exec playwright install chromium`.

## Releases

The root `package.json` holds the version; `plugin/.claude-plugin/plugin.json` and the workspace `package.json` files must equal it, and `pnpm check` fails (naming the file) when one does not. `claude plugin update` only picks up a build when the plugin version changed, so maintainers cut a release when plugin content should reach users:

```sh
pnpm release <patch|minor|major|x.y.z>   # clean tree required
```

It bumps every version file, adds a dated section to `CHANGELOG.md` from the commit subjects since the last `v*` tag, commits `Release v<version>` and tags `v<version>`. It never pushes; review the commit, then push the branch and the tag yourself. Do not bump versions in ordinary PRs. `pnpm check` only warns when `plugin/` or the packages bundled into `plugin/dist` changed since the last tag without a bump (a feature branch would otherwise fail every PR); `pnpm version:check --strict` turns that warning into an error, to run before tagging.

## Review

`main` is protected: changes land through PRs only. A maintainer reviews each PR, may ask for changes, and merges when it is ready. Pushes to a PR branch update the PR, so there is no need to open a new one.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE), the same as the rest of the project. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
