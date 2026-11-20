# Spike: install the CLI in a runner and time it

Issue #279. Question: does the release tarball install on a GitHub Actions `ubuntu-latest` runner, and how long do install, cold index, review and a comment take at about 1,000, 5,000 and 10,000 TypeScript files?

## Verdict: go-with-changes

- The bar is met for everything that could be measured. At 5,000 files, install + cold index + review + duplicates take a median of 60.7 s against 300 s.
- Two things did not come out as planned, and both need a decision before the Action (#282) is built:
  1. Posting a comment could not be timed. With the workflow limited to `contents: read`, the comment call is refused (HTTP 403). The sandbox also has no pull request. The bar's "comment" part is therefore unmeasured, not missed. A comment is a single API call, but the refused calls (0.4 to 3.4 s) say nothing about the time of a successful one and are not used as a measurement.
  2. The 10,000-file repo did not finish `gantry init`: the 16 GiB runner ran out of memory and the job was killed, in all 6 jobs. At 5,000 files the same step peaks at 1.3 GB, so the 10,000-file failure is not a gentle extension of the trend. It needs its own look (see "10,000 files").

## Setup

- Sandbox repo (public): https://github.com/jbknick/gantry-ci-sandbox, release `v0.1.0-sandbox.1` with `gantry-0.1.0.tgz` (sha256 `7da512528e0579422ee968f1f7a237b281f86838c052b3a5c72d8d481d083b49`) and its `.sha256`, built from this repo at 3f86b0f.
- Runner: `ubuntu-latest` = Ubuntu 26.04.1 LTS, runner image `ubuntu-26.04` version 20261116.202.1 (the `ImageVersion` variable inside the job reported `ubuntu26/20261111.196.1`), 4 CPUs, 15,983 MiB RAM, Node v26.13.1, npm 11.20.0. GitHub-hosted standard runner on a public repo.
- Each size was dispatched once; one dispatch runs 3 jobs on separate fresh runners (matrix), so each cell is a median of 3 runs.
- The workflow ([`ci-install/workflow.yml`](ci-install/workflow.yml), copied here for the record; it runs only in the sandbox) checks out the pinned repo at its SHA with full history, then times with `date +%s%N`: install (download, both checksum checks, `tar`, `npm ci --omit=dev`, `gantry --version`), `gantry init` (fresh `CLAUDE_PLUGIN_DATA`), `gantry review <parent>...<sha> --json`, `gantry duplicates --json`, then a comment create and update. It verifies the tarball sha256 against a value pinned in the file before installing, pins every action by full commit SHA, asks for `contents: read` only and uses no secrets.
- Repos (pinned in `evals/oss/repos.json`):

| Size   | Repo                                   | SHA                                        | `.ts`/`.tsx` files at the SHA |
| ------ | -------------------------------------- | ------------------------------------------ | ----------------------------- |
| 1,000  | trpc/trpc (already pinned)             | `596d03d93295f8b4876909cfce86f94a1e6afe51` | 1,465                         |
| 5,000  | formbricks/formbricks (already pinned) | `b52ebf833e92c1205d95492dc43567760ef56706` | 6,021                         |
| 10,000 | grafana/grafana (added)                | `42c9c62eb2dd6b6f1f01265ef946b0eeef9c9c6d` | 10,109                        |

## Results (medians of 3, seconds)

Total = install + cold index + review + duplicates (the comment steps are excluded, see above). Peak RSS is that of `gantry init`, the largest of the steps.

| Files                              | Install | Cold index            | Review | Duplicates | Comment create     | Comment update | Total | Peak RSS (init)                         | Bar (total ≤ 300 s) |
| ---------------------------------- | ------- | --------------------- | ------ | ---------- | ------------------ | -------------- | ----- | --------------------------------------- | ------------------- |
| 1,000 (trpc, 1,465 ts files)       | 11.0    | 8.4                   | 0.17   | 0.68       | not measured (403) | not measured   | 20.3  | 406 MiB                                 | pass                |
| 5,000 (formbricks, 6,021 ts files) | 11.0    | 48.4                  | 0.18   | 1.1        | not measured (403) | not measured   | 60.7  | 1.25 GiB                                | pass                |
| 10,000 (grafana, 10,109 ts files)  | n/a     | killed, out of memory | n/a    | n/a        | n/a                | n/a            | n/a   | 15.6 GiB of 15.6 GiB in use when killed | fail (no result)    |

Individual runs (install / init / review / duplicates, seconds):

- 1,000: 12.2 / 9.0 / 0.17 / 0.72; 11.0 / 8.4 / 0.17 / 0.68; 10.4 / 6.0 / 0.15 / 0.38.
- 5,000: 10.8 / 37.8 / 0.16 / 0.94; 11.0 / 48.4 / 0.18 / 1.1; 11.8 / 66.9 / 0.21 / 1.4. The cold index varies by almost a factor of two between runners.

Run URLs:

- 1,000 files: https://github.com/jbknick/gantry-ci-sandbox/actions/runs/44699767667
- 5,000 files: https://github.com/jbknick/gantry-ci-sandbox/actions/runs/44699773070
- 10,000 files: https://github.com/jbknick/gantry-ci-sandbox/actions/runs/44693577399 (memory log of the failure) and https://github.com/jbknick/gantry-ci-sandbox/actions/runs/44692544863 (same result with the previous revision of the workflow)
- Earlier runs on earlier revisions of the workflow, not used in the table: 44692200786 (the shell stopped at the first failing step), 44692360215 (1,000 files, one revision before the final one; same numbers within noise).

## Findings

### Install

The tarball installs on a stock runner with the README one-liner steps. Download, both checksum checks and `npm ci` took 10.4 to 12.2 s in all 6 runs, with a peak RSS of 0.8 GB, and `gantry --version` printed. No step needed anything beyond Node 26.

### 5,000 files

The cold index is the whole cost: 38 to 67 s. Review (0.15 to 0.21 s) and duplicates (0.4 to 1.4 s) are small next to it. The bar has about 240 s of headroom at this size even before caching an index between runs.

The review range asked for by the issue (the SHA's parent to the SHA) produced a 426-byte JSON in both the 1,000- and 5,000-file repos, identical in size, so those commits changed little or no indexed code. The review time in the table is therefore the cost of a near-empty diff on a full index, not of a large pull request. To get some idea of a larger one, the workflow also ran `gantry review <sha>~100...<sha>` (outside the bar): 11 to 14 s at 1,000 files and 180 to 267 s at 5,000 files (peak RSS 0.5 GB). A review of a 100-commit span on a 6,000-file repo would by itself use most of the 5-minute budget. Real pull requests sit between the two; this spike did not measure one.

### 10,000 files

`gantry init` on grafana at the pinned SHA used memory steadily for about 5 minutes (1.2 GiB after 10 s, 8.4 GiB after 70 s, 15.9 GiB after 5 minutes) and the runner was killed (exit code 143) before the index finished. Disk use stayed at 43%. All 6 jobs behaved the same, so this is not noise. The repo has 10,109 `.ts`/`.tsx` files but also a large amount of Go and JavaScript, which `init` indexes too, so file count alone does not explain it; formbricks needed 1.3 GB for 6,054 indexed files. This spike did not look into where the memory goes (optimising the index is out of scope). Until it is understood, the Action cannot promise a cold index on a repository of this size on a standard runner; a fresh index per run is the wrong default for it, and a restored index or a limit on the paths indexed are the options to evaluate.

### Comment

- With `permissions: contents: read` the comment endpoints return 403 (`Resource not accessible by integration`). Posting a pull request comment needs `pull-requests: write` (or `issues: write`) in the workflow. The sandbox has no pull request and this spike was not allowed to create one or widen the token, so create and update times are not measured. The workflow tried a commit comment on the sandbox's own commit, which is refused the same way.
- Fork pull requests: not tested here. GitHub documents that the `pull_request` event from a fork gets a read-only token and no secrets, so a comment from that event would be refused as above. The usual route is a second workflow (`workflow_run`, or `pull_request_target` without checking out fork code) that holds the write permission and only posts a result produced by the first. That design should be tested in the sandbox before #282 relies on it.
- Comment size: GitHub limits a comment body to 65,536 characters. The review JSON at 100 commits was 5.3 MB (1,000 files) and 20 MB (5,000 files), and the duplicates JSON 14 KB and 148 KB. The raw JSON must never be posted: the comment must be a summary built from it, with a cut-off and a link or artifact for the rest.

## Deviations

- The issue says to put the workflow here as `workflow.yml` and run it with Node 26 and 3 runs per size; done, with one change: the 3 runs of a size run in parallel on 3 runners instead of one after another on one.
- The 1,000-file repo has 1,465 files, 46% over "about 1,000"; it was already pinned and no closer candidate was looked for. The 10,000-file repo is grafana (10,109 files at the SHA).
- Comment create and update are not measured, for the reasons above. No sandbox pull request was created and no permission beyond `contents: read` was requested.
- Added to the workflow beyond the issue: peak RSS per step, a memory log, and the 100-commit review.
- The pinned sha256 check is in addition to the `.sha256` file check.
- `gantry duplicates --json` exists on `main` (#280 has merged), so it was run.

## Not changed

No workflow or CI file was added to this repo. `evals/oss/repos.json` gained one entry (grafana, role `tuning`).
