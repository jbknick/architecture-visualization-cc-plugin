# Contributing

Thanks for wanting to help. The project is at an early stage and its contracts still change, so read this page and then [`docs/SPEC.md`](docs/SPEC.md) before you open a PR.

## Before you start

- Ask questions and float ideas in [Discussions](https://github.com/jbknick/architecture-visualization-cc-plugin/discussions).
- Report bugs and concrete feature requests in [Issues](https://github.com/jbknick/architecture-visualization-cc-plugin/issues/new/choose), using the templates.
- For anything larger than a small fix, comment on the issue (or open one) first so we can agree on the approach before you write code. Issues labelled `good first issue` or `help wanted` are good places to start.
- Report security problems privately as described in [`SECURITY.md`](SECURITY.md), not in a public issue.

## Contributing through Devprentice

If you joined through a Devprentice guided program, follow the program's steps alongside this page. The rules here apply the same way: one issue per PR, `pnpm check` passing locally, and review by the code owner before merge. Ask questions about the program in the program itself, and questions about this project in Discussions or on the issue you are working on.

## Set up

You need Node 26 (see `.nvmrc`) and pnpm 10.31.0. The pnpm version is pinned in `package.json`, and `corepack enable` picks it up.

```sh
git clone https://github.com/<you>/architecture-visualization-cc-plugin.git
cd architecture-visualization-cc-plugin
pnpm install
pnpm build    # writes plugin/dist/ (CLI, MCP server, explorer)
pnpm check    # biome + tsc + vitest
```

To try the plugin in Claude Code from your clone, follow [`docs/INSTALL.md`](docs/INSTALL.md). The explorer has its own notes, including how to run it against the mock API, in [`packages/explorer/web/README.md`](packages/explorer/web/README.md).

## Rules for a PR

These come from [`CLAUDE.md`](CLAUDE.md), which the coding agents that work on this repo also follow.

1. Follow the spec. [`docs/SPEC.md`](docs/SPEC.md) defines the contracts. If an issue conflicts with it, follow the spec and say so in the PR. To change a contract, edit the spec in the same PR and say so.
2. Run `pnpm check` before you open or update a PR, and make sure it passes. There is no hosted CI to run it for you. `pnpm fmt` applies Biome fixes. Several checkouts or worktrees may run `pnpm check` at the same time, and files that git ignores do not fail it.
3. Keep private code and data out. This repo is public, so never commit code, descriptions, graph dumps or screenshots from a private repository. Tests and screenshots use `fixtures/` and the explorer mock's synthetic scenarios only. Private eval data goes in the git-ignored `evals/private/`.
4. Add only dependencies listed in section 2 of the spec. If you need another one, propose it in the issue first.
5. Keep each PR to one issue and put `Closes #<n>` in the description. A branch name like `gantry/<issue-number>-<slug>` is welcome but not required on forks.
6. Update `README.md` in the same PR when you change user-visible behaviour, commands or views. The Commands table, Status table and Quick start must match `main`. If a view's look changed, run `pnpm build && pnpm readme:media` and commit the changed files under `docs/readme/`. That needs Chromium for Playwright: `pnpm --filter @gantry/explorer exec playwright install chromium`.

## Releases

The root `package.json` holds the version. `plugin/.claude-plugin/plugin.json` and the workspace `package.json` files must match it, and `pnpm check` fails and names the file when one does not. `claude plugin update` only picks up a build when the plugin version changed, so maintainers cut a release when plugin content should reach users:

```sh
pnpm release <patch|minor|major|x.y.z>   # clean tree required
```

It bumps every version file, adds a dated section to `CHANGELOG.md` from the commit subjects since the last `v*` tag, commits `Release v<version>` and tags `v<version>`. It then runs `pnpm build` and packs `dist/gantry-<version>.tgz` and `dist/gantry-<version>.tgz.sha256` (`pnpm release:pack` runs only that step for the current version). It never pushes or uploads, so review the commit, then push the branch and the tag and create the GitHub release yourself:

```sh
git push && git push origin v<version>
gh release create v<version> dist/gantry-<version>.tgz dist/gantry-<version>.tgz.sha256 --notes-from-tag
```

Do not bump versions in ordinary PRs.

The tarball is one file for every platform. It holds `plugin/` (`bin/`, `dist/`, `agents/`, `skills/`, `hooks/`, `.claude-plugin/`, `.mcp.json`), `LICENSE`, and the `package.json` and `package-lock.json` from `scripts/release-deps/`, which pin the native dependencies the bundle leaves external (the `external` list in `tsup.config.ts`). A runner installs it with the one line in the README's "Install in CI" section, and `npm ci` reads that lockfile. Whenever you change the version of one of those packages in the root `package.json`, make the same change in `scripts/release-deps/package.json` and regenerate the lockfile there (`npm install --package-lock-only --ignore-scripts` inside `scripts/release-deps/`); `pnpm check` fails and names the package when the versions differ. A package that is not in the root `package.json` (`onnxruntime-node`, which `@huggingface/transformers` depends on) is checked against nothing, so check its version against `pnpm-lock.yaml` yourself.

`pnpm check` only warns when `plugin/` or the packages bundled into `plugin/dist` changed since the last tag without a version bump, because a hard failure would break every feature branch. Run `pnpm version:check --strict` before tagging to turn that warning into an error.

## Review

A ruleset protects `main`. Changes land through pull requests, force-pushes and branch deletion are blocked, and PRs merge by squash only. Each PR needs one approving review, and [`.github/CODEOWNERS`](.github/CODEOWNERS) makes the code owner's approval the required one. There is no hosted CI, so no status checks are required: run `pnpm check` yourself and tick the box in the PR template.

The maintainer reviews each PR against the rules above (spec, `pnpm check`, private data, dependencies, one issue per PR, README), may ask for changes, and merges when it is ready. Pushing to your PR branch updates the PR, so you do not need to open a new one.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE), like the rest of the project. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
