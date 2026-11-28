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

Pin `actions/checkout` and this Action by commit SHA if your organization requires it.

## Inputs

| Input          | Required | What it does                                                                                                                                             |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | yes      | The Gantry release to install, for example `0.1.0`. The tarball of the release tagged `v<version>` is downloaded.                                        |
| `sha256`       | yes      | SHA-256 of `gantry-<version>.tgz`. The install stops if the download, the pinned value and the release's `.sha256` file do not all agree.                |
| `github-token` | no       | The token that posts the comment. Default `github.token`. The workflow needs `pull-requests: write`.                                                     |
| `embed`        | no       | `true` also runs `gantry embed` and adds the code-vector tier to the duplicate check. Slow on a large repository. Default `false`: exact and near tiers. |
| `base`         | no       | Base of the range to review. Default: the pull request's base commit.                                                                                    |
| `head`         | no       | Head of the range to review. Default: the pull request's head commit. Check out the same commit (as above), because the duplicate check reads `HEAD`.    |

| `team-server` | no | URL of your team server. With `team-org` and `team-token` set, the Action also uploads (see "Uploading to a team server"). Default empty: nothing is uploaded. |
| `team-org` | no | Your organization's slug on the team server. Default empty. |
| `team-token` | no | The team's CI token. Store it as a secret. Default empty. A pull request from a fork never gets it. |

Outputs: `comment` (`created`, `updated`, or `summary` when the review went to the job summary) and `comment-url`.

## What the Action does

1. Sets up Node 26 (`actions/setup-node`, pinned by commit SHA) and installs the release tarball by tag and checksum with `npm ci`. Nothing else is downloaded.
2. Runs `gantry init` on the checkout (a cold index; plan for about a minute per 1,000 files on a standard runner, longer on very large repositories). With `embed: true` it then runs `gantry embed`.
3. Runs `gantry review <base>...<head> --json` and `gantry duplicates --since <base> --json` and builds the comment from them. The raw JSON is never posted: the comment is a summary with a cap on every list, and the whole body is kept under 60,000 characters, below GitHub's limit of 65,536. When it still would not fit, the least important sections (consumers, notes, team boundaries, crossings, then the changed-symbol table) are dropped first.
4. Finds its earlier comment on the pull request by the hidden marker `<!-- gantry:pr-comment -->` at the start of its body and updates it; otherwise creates one.

The comment says when the blast radius is **structural only**: a repository without a committed `.gantry/recipe.json` gets a radius that follows imports, calls and renders, without routes, endpoints or tables. Once the repository commits a recipe (see `gantry recipe check` in the main README), the comment shows the same radius as the one developers see locally.

## When Gantry fails

The Action fails open: a Gantry error never fails your job. If the install (input check, download, checksum, extraction, `npm ci`), `gantry init`, `gantry embed` or `gantry review` fails, or the review is not JSON, the step logs a `::warning` line and exits 0, and the pull request still gets its one comment (the same one, updated in place) saying that the analysis failed and why, in one short line. A duplicate check that fails is reported inside the normal comment. If the checksum of the download does not match, the log has an `::error` line, the tarball is deleted and never run, and the comment says so.

When the install fails, the release tarball (and so its comment script) is not there. The last step then runs `post-failure.sh` from this Action's own folder, which needs only `bash`, `curl` and `node`: it writes the same failure comment, or the job summary when no comment can be posted. A workflow with no pull request and no `base` and `head` inputs (a push, a schedule) simply skips the comment: the comment and embed steps run only when the event carries a pull request, or both inputs are set.

## Uploading to a team server

Uploading is opt-in. With `team-server`, `team-org` and `team-token` all set, a last step (`Upload to the team server`) runs after the index and the comment; with any of them empty the step does not run and nothing is sent. No source leaves the runner: the upload carries what [What is uploaded and what is not](../README.md#what-is-uploaded-and-what-is-not) lists. What it sends depends on the event:

| Event                                              | What happens                                                                                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push` to the default branch                       | uploads the graph of that branch (`gantry upload --force-main`)                                                                                                                                            |
| `push` to another branch                           | `upload skipped: push to <branch> is not the default branch (<default>)`                                                                                                                                   |
| `pull_request` `opened`, `synchronize`, `reopened` | uploads that pull request's change set (`gantry upload --pr <n> --base <sha> --head <sha>`)                                                                                                                |
| `pull_request` `closed`                            | tells the server the pull request closed, and whether it was merged (`--close`, with `--merged` when it was); the index, embed and comment steps are skipped, so a close costs the install and one request |
| `pull_request` from a fork                         | `fork: upload skipped`: nothing is sent, and the token is not used                                                                                                                                         |
| any other action or event                          | `upload skipped: ... does not upload`                                                                                                                                                                      |

On a push there is nothing to review, so the comment and embed steps do not run; the index does, because the upload needs it. If the index failed, a push or a pull request update uploads nothing (`upload skipped: the index failed`); a close still goes through. The step never fails the job: an upload that does not work logs one `::warning title=Gantry::upload failed: <reason>` line, with the token never in it. Store the three values as secrets (the server URL and organization are not secret, but then they are one place to change):

```yaml
name: gantry
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read
  pull-requests: write

jobs:
  gantry:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      - uses: jbknick/architecture-visualization-cc-plugin/action@v0.3.0
        with:
          version: "0.3.0"
          sha256: "<the checksum from gantry-0.3.0.tgz.sha256>"
          team-server: ${{ secrets.GANTRY_SERVER }}
          team-org: ${{ secrets.GANTRY_ORG }}
          team-token: ${{ secrets.GANTRY_TOKEN }}
```

The upload step first ships in v0.3.0; an earlier version installs fine but skips the upload with a warning.

Use the `pull_request` event, not `pull_request_target`: a fork's run must not get the secrets, and GitHub does not pass them to a `pull_request` run from a fork, so the three inputs are empty there as well.

## Team boundaries in the comment

With the same three inputs (`team-server`, `team-org`, `team-token`), the comment gains a section `### Team boundaries (<n>)` between `Crossings` and `Consumers`. It lists, for each pair of groups, the places where a changed function (or an added import) uses a group that its own team group does not list in `mayUse`: up to 3 items per pair, the number of edges in total, up to 10 pairs, then `and <n> more`. It is a warning only and never fails the check. The groups are the team's, read from the server with one request; nothing from the repository is sent, and the team token is used only for that request, never for the comment (the comment still uses `github-token`).

- It is separate from `Crossings`, which lists consumers in another workspace, app or client and server, and is unchanged.
- Without the three inputs, and for a pull request from a fork, there is no request and no section: the comment is exactly what it was.
- If the server cannot be reached or refuses the token, the comment is posted without the section and the log has one `::warning title=Gantry::team boundaries unavailable: <reason>` line. The job stays green and the comment is not the failure comment.
- A group name is shown as plain code, so a name cannot add a link, a mention or HTML to the comment. When the comment would be too long, this section goes before `Crossings` does.
- The release you install must include the `gantry team boundaries` command; with an older release the step logs the warning above and the section is left out.

## Pull requests from forks

GitHub gives a `pull_request` run from a fork a read-only token, so it cannot comment. The Action detects a fork, skips the comment, writes the same text to the job summary and finishes green. The same happens whenever the token is refused for another reason (HTTP 401, 403 or 404 on the comment calls), or when the run is not for a pull request.

The Action is meant for the `pull_request` event. It checks out and indexes the code of the pull request but never runs it, yet do not switch the trigger to `pull_request_target` to get a write token for forks: that runs with the base repository's secrets.

## Trying a build from another place

By default the tarball comes from this repository's releases. To try a tarball published elsewhere (a prerelease in a test repository, say), set `GANTRY_RELEASE_BASE` in the workflow's `env` to the directory URL that holds `gantry-<version>.tgz` and its `.sha256` file. `version` and `sha256` are still checked.
