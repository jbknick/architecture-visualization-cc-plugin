# Gantry pull request comment

A GitHub Action for your own repository. On each pull request it posts one comment with the symbols the pull request changes, what consumes them (directly and through other code), the boundaries the change crosses, the risk, and the duplicates the pull request adds. The comment is updated in place on every push, so a pull request never holds more than one. No model calls, no account, free.

This is something Gantry ships for your repository. It is not CI for the Gantry repository itself, which has no workflow of its own, and Gantry never writes a workflow file into your repo: you add the one below.

## Add it

Create `.github/workflows/gantry.yml` in your repository. Take `version` and `sha256` from a release of Gantry that carries the tarball (its `gantry-<version>.tgz.sha256` file holds the checksum):

```yaml
name: gantry
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  comment:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # the review reads the base and the head from git history
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: jbknick/architecture-visualization-cc-plugin/action@v0.1.0
        with:
          version: "0.1.0"
          sha256: "<the checksum from gantry-0.1.0.tgz.sha256>"
```

The workflow needs `pull-requests: write` to comment and `contents: read` for the checkout, and `fetch-depth: 0` so the base and the head are both in the clone. Do not add `actions/setup-node`: the Action sets up Node 26 itself (step 1 below), so the job runs the same Node whatever the runner has.

Pin `actions/checkout` and this Action by commit SHA if your organisation requires it.

## Inputs

| Input          | Required | What it does                                                                                                                                             |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | yes      | The Gantry release to install, for example `0.1.0`. The tarball of the release tagged `v<version>` is downloaded.                                        |
| `sha256`       | yes      | SHA-256 of `gantry-<version>.tgz`. The install stops if the download, the pinned value and the release's `.sha256` file do not all agree.                |
| `github-token` | no       | The token that posts the comment. Default `github.token`. The workflow needs `pull-requests: write`.                                                     |
| `embed`        | no       | `true` also runs `gantry embed` and adds the code-vector tier to the duplicate check. Slow on a large repository. Default `false`: exact and near tiers. |
| `base`         | no       | Base of the range to review. Default: the pull request's base commit.                                                                                    |
| `head`         | no       | Head of the range to review. Default: the pull request's head commit. Check out the same commit (as above), because the duplicate check reads `HEAD`.    |

Outputs: `comment` (`created`, `updated`, or `summary` when the review went to the job summary) and `comment-url`.

## What the Action does

1. Sets up Node 26 (`actions/setup-node`, pinned by commit SHA) and installs the release tarball by tag and checksum with `npm ci`. Nothing else is downloaded.
2. Runs `gantry init` on the checkout (a cold index; plan for about a minute per 1,000 files on a standard runner, longer on very large repositories). With `embed: true` it then runs `gantry embed`.
3. Runs `gantry review <base>...<head> --json` and `gantry duplicates --since <base> --json` and builds the comment from them. The raw JSON is never posted: the comment is a summary with a cap on every list, and the whole body is kept under 60,000 characters, below GitHub's limit of 65,536. When it still would not fit, the least important sections (consumers, notes, crossings, then the changed-symbol table) are dropped first.
4. Finds its earlier comment on the pull request by the hidden marker `<!-- gantry:pr-comment -->` at the start of its body and updates it; otherwise creates one.

The comment says when the blast radius is **structural only**: a repository without a committed `.gantry/recipe.json` gets a radius that follows imports, calls and renders, without routes, endpoints or tables. Once the repository commits a recipe (see `gantry recipe check` in the main README), the comment shows the same radius as the one developers see locally.

## When Gantry fails

The Action fails open: a Gantry error never fails your job. If the install (input check, download, checksum, extraction, `npm ci`), `gantry init`, `gantry embed` or `gantry review` fails, or the review is not JSON, the step logs a `::warning` line and exits 0, and the pull request still gets its one comment (the same one, updated in place) saying that the analysis failed and why, in one short line. A duplicate check that fails is reported inside the normal comment. If the checksum of the download does not match, the log has an `::error` line, the tarball is deleted and never run, and the comment says so.

When the install fails, the release tarball (and so its comment script) is not there. The last step then runs `post-failure.sh` from this Action's own folder, which needs only `bash`, `curl` and `node`: it writes the same failure comment, or the job summary when no comment can be posted. Only a misconfigured workflow (no base and head to review) still fails the job.

## Pull requests from forks

GitHub gives a `pull_request` run from a fork a read-only token, so it cannot comment. The Action detects a fork, skips the comment, writes the same text to the job summary and finishes green. The same happens whenever the token is refused for another reason (HTTP 401, 403 or 404 on the comment calls), or when the run is not for a pull request.

The Action is meant for the `pull_request` event. It checks out and indexes the code of the pull request but never runs it, yet do not switch the trigger to `pull_request_target` to get a write token for forks: that runs with the base repository's secrets.

## Trying a build from another place

By default the tarball comes from this repository's releases. To try a tarball published elsewhere (a prerelease in a test repository, say), set `GANTRY_RELEASE_BASE` in the workflow's `env` to the directory URL that holds `gantry-<version>.tgz` and its `.sha256` file. `version` and `sha256` are still checked.
