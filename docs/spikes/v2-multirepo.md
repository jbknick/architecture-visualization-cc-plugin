# Spike: one store holds several repos

V2 plan, M11 ("Multirepo workspaces"). Question: does one SQLite store with a `repo` column give correct search, duplicates, per-repo heal and sibling-package resolution for two related public repos, what does it cost, and does the decided workspace file (`gantry-workspace.json`, found by walking up) have a problem?

## Setup

- Code base: `origin/main` at `7170e08`, built (`pnpm build`); the prototype imports the built `packages/core/dist`. `packages/` is unchanged.
- Repos, pinned in `evals/oss/repos.json` (stack `typescript`, role `tuning`), cloned with `pnpm eval:clone`:
  - `honojs/hono` at `75ff8e3ea18485589816881c6278bc9783e56602` (450 file rows, 1,580 symbols)
  - `honojs/middleware` at `6f11fdd162fd3ef5581fb2a8dbd1403631dcc93f` (338 file rows, 948 symbols)
- Machine: Apple M3 Pro, 11 cores, 18 GiB, Darwin 27.2.0, Node v26.13.0. The machine was shared with other agents: load averages (1, 5, 15 min) are 23 to 33 during the final run and are listed beside every timing.
- Prototype, `docs/spikes/v2-multirepo/` (own folder, no tests, not in `tsconfig.json`, Biome-clean):
  - `lib.ts`: the one store (the stock schema from `openStore`, then `workspaces` recreated with `repo` and key `(repo, id)`, and `ALTER TABLE files ADD COLUMN repo`), `mergeRepo` (copies a finished single-repo store into it, tagging `files` and `workspaces` with the repo), `dropRepo`, per-repo row hashes, duplicate groups.
  - `workspace-file.ts`: `findWorkspaceFile` (walk up), membership test, store key, and the edge-case scenarios.
  - `run.ts`: everything else. It makes private copies of the two clones in a fresh temp dir (own `HOME`, so every data dir is fresh), so the pinned clones are never touched, and prints the results as JSON.
- Command: `pnpm tsx docs/spikes/v2-multirepo/run.ts ~/Dev/gantry-oss/hono@75ff8e3 ~/Dev/gantry-oss/middleware@6f11fdd`. It needs `pnpm build` first.

## Results

Numbers are from one run of the command above (the JSON it prints). The sha256 values depend on file mtimes and so differ from run to run; the equality between "before" and "after" within a run does not.

| Measure                                                                                               | Result                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Id collisions, ids GH-263 qualifies with the repo (files, symbols, edges, adapter nodes, search rows) | **0** of 788 file rows, 2,528 symbols, and every edge, node and search row                                                                        |
| Id collisions, workspace ids (not repo-qualified, spec section 6)                                     | **1**: `ws:.` (the root workspace of each repo)                                                                                                   |
| Search, queries in middleware naming functions only in hono: expected function in top 5               | **10/10** (all rank 1); the same queries in middleware's own store: 0/10 found                                                                    |
| Search, queries in hono naming functions only in middleware: expected function in top 5               | **10/10** (all rank 1); in hono's own store: 0/10 found                                                                                           |
| Same queries typed as words (`get cookie`), both directions                                           | 10/10 and 10/10 (one at rank 3: `sValidator` as `s validator`; the rest rank 1)                                                                   |
| Duplicate groups: separate stores, union (hono 27 + middleware 2)                                     | 29 (36 `similar_to` edges)                                                                                                                        |
| Duplicate groups: one store                                                                           | 32 (39 edges)                                                                                                                                     |
| Duplicate groups: lost / gained / cross-repo                                                          | **0** lost / 3 gained / 3 cross-repo (all gained groups are cross-repo; 0 edges lost, 3 gained)                                                   |
| Heal of one repo: the other repo's rows sha256 equal                                                  | **yes** (files, symbols, edges, adapter nodes each equal; also equal with the derived `similar_to` edges, before and after `rebuildSimilarEdges`) |
| Sibling imports resolved to hono source, with the sibling's workspaces                                | **338 / 339 = 99.7%**                                                                                                                             |
| Sibling imports resolved to hono source, without the sibling (fresh clone, no install)                | **0 / 339 = 0%** (339 resolve to `external`, i.e. a declared package, none to a file)                                                             |
| Index time, median of 3: one store vs two separate stores summed                                      | 7,885 ms vs 7,810 ms, **1.010x**                                                                                                                  |
| `gantry.db` size, median of 3: one store vs two separate stores summed                                | 8,761,344 vs 9,113,600 bytes, **0.961x**                                                                                                          |
| Workspace file                                                                                        | Works in the decided form; five problems (see Findings, part 4)                                                                                   |

Index time per run (hono + middleware passes, then the merge into the one store; the one-store time is the three added):

| Run | Load at start     | hono pass | middleware pass | Merge | Separate sum | One store |
| --- | ----------------- | --------- | --------------- | ----- | ------------ | --------- |
| 1   | 29.56 23.74 24.70 | 4,834 ms  | 2,976 ms        | 75 ms | 7,810 ms     | 7,885 ms  |
| 2   | 29.84 23.90 24.75 | 7,214 ms  | 1,567 ms        | 55 ms | 8,781 ms     | 8,836 ms  |
| 3   | 33.07 24.79 25.05 | 2,651 ms  | 1,656 ms        | 52 ms | 4,307 ms     | 4,359 ms  |

The spread between runs (4.3 s to 8.8 s for the same work) is machine load, not the code; the one-store minus separate difference is the merge, 52 to 75 ms. Sizes are identical across runs (WAL folded in with `wal_checkpoint(TRUNCATE)`).

Other measured values:

- Duplicate rebuild (`rebuildSimilarEdges`, exact and near tiers): hono 12 ms, middleware 4 ms, one store 11 ms.
- Heal: hono checked out at `271dd0b` (the commit 100 first-parent steps back, 2026-09-28; 148 files differ from the pinned commit), a fresh `indexRepo` pass of it took 2,661 ms, and replacing hono's rows in the one store (delete by repo, merge in) took 62 ms. Hono's rows changed (hash differs); middleware's did not. 0 dangling `similar_to` edges before or after.
- Sibling imports: 339 distinct (file, specifier) pairs in 167 files over 37 distinct `hono` / `hono/*` specifiers, reaching 36 distinct hono source files. All 36 mappings were read by eye (for example `hono/cookie` to `src/helper/cookie/index.ts`, `hono/jsx/jsx-runtime` to `src/jsx/jsx-runtime.ts`, `hono/utils/jwt/jwa` to `src/utils/jwt/jwa.ts`); none is wrong. The one miss is `hono/dist/types/router` (a deep import of built types, not an exported subpath).

## Findings

### 1. Search, duplicates, heal and sibling resolution all work on one store with a repo column

The results table holds for the Bar. Search ranks a function of the other repo first in 20 of 20 queries, where the separate store of the querying repo finds none. Duplicates lose nothing and gain exactly the cross-repo groups: the same helpers (`run`, `streamSSE`, `isOldBunVersion`) exist in `hono/src/helper/streaming/` and `middleware/packages/mcp/src/streaming.ts`. A per-repo heal leaves the other repo's rows byte-identical.

### 2. The stock indexer cannot write a second repo into a store that already holds one

Calling `indexRepo(paths, { layer: "main", store })` for hono and then for middleware on one unmodified store leaves **0 hono files**: after the hono pass the store has 450 files, 1,580 symbols and 1,580 search rows; after the middleware pass it has 338, 948 and 948. `removeStaleMain` deletes every main file that is not in this run's tree, and the full-index path of the search table runs `DELETE FROM fts_symbols` and re-inserts only its own symbols. `meta` is overwritten too (`repo` and `head_sha` end as middleware's). This is why the prototype builds the one store by merging each repo's own pass. For GH-214 every "all rows" statement in `indexRepo` (the stale-file sweep, the search-table rebuild, the `mainFiles` load, the `missing` calculation) has to be scoped to one repo.

### 3. What else a single store assumes is one repo

- `meta` is a flat key space: `repo`, `repo_root`, `head_sha`, `indexed_at`. `resetStaleStore` deletes the whole store when `meta.repo` differs from the repo being opened, and `heal` reads one `head_sha`. The prototype keeps these as `<repo>|<key>` rows.
- Workspace ids are not repo-qualified (`ws:.`, `ws:<package name>`). `ws:.` exists in both repos (379 hono files and 4 middleware files carry `workspace_id = 'ws:.'`), `listWorkspaces()` returns two rows with that id, and the `workspace` filter of search matches files of both repos. The key `(repo, id)` on `workspaces` fixes the table; `files.workspace_id` then needs the repo (it is in the same row, so `files.repo` covers it) and every query that joins on `ws:...` alone needs the repo too. The resolver also caches its per-workspace oxc resolvers by workspace id.
- Cross-repo `similar_to` edges live on the file of the lower symbol id, so on the repo whose name sorts first. All 3 here are on hono's rows, which is why a heal of middleware cannot touch them and a heal of hono rewrites them. With the names the other way round, the byte-identical result for "the other repo" would not hold. The derived edges need an owner rule (for example: stored on neither repo, or on a workspace-level partition).
- Once GH-217 writes import edges from middleware into hono, middleware's rows depend on hono's. Hono's change between the two commits touched 12 of the 36 hono files that middleware imports from, so those edges must be recomputed (or marked stale) on a hono heal. This spike's hash test covers only rows the single-repo indexer writes, where the independence is by construction.
- Two members with the same repo name collide. The name is the `origin` URL's last two segments, or the directory name without an `origin`. A linked worktree of hono has the same name as the main checkout (`honojs/hono`), and `a/api` and `b/api` without an `origin` are both `api`; every id of a shared path is then identical. A workspace file should reject duplicate names.

### 4. The workspace file

Decided form (`{ "repos": [{ "path": "./hono" }, { "path": "./middleware" }] }` in the directory above the repos, found by walking up, store keyed by the file's directory) works from the repo root and from a nested directory, with the same store key. Problems found:

1. **Walk-up adopts any repo below the file.** A repo under the directory but not listed still finds the file (`isMember` is false). The loader must check membership and treat a non-member as a standalone repo.
2. **Linked worktrees.** A worktree inside the workspace directory finds the file but is not listed, so it is not a member; one outside the directory finds no file at all. Either way a worktree gets its own store (keyed by its own path) and the same repo name as its main checkout. Listing both would collide (above).
3. **Symlinks.** `resolvePaths` resolves the repo root with `realpath`. A symlink to a repo inside the workspace directory works (root is the real target, file found, member). A symlink to a repo outside it fails: walking up from the real root finds no file (walking up from the typed path would). Membership by comparing real paths worked in both cases, so the walk should start from the directory the user is in and compare real paths.
4. **A repo listed by two workspace files** (an outer and an inner one). The nearest wins from the repo, but both files list it, there are two stores (different keys) that each hold a full copy of the repo's rows, and nothing warns. Starting from a directory under the outer file only finds the outer one.
5. **A file above a repo it does not list** (same as 1): the repo is silently outside the workspace.

## Deviations and notes

- The one store is built by merging each repo's own `indexRepo` pass (finding 2), not by writing straight into it. "One store" time is therefore the two passes plus the merge, so its ratio to the separate stores is close to 1 by construction; a direct-write implementation can add costs this does not measure (loading both repos' file rows per pass, search-row upserts). The size comparison is a real file size.
- Search is the keyword half only (`hybridSearch` without an embedder, no descriptions), the state of a fresh index. The headline queries are the function names; the as-words variant is extra. The 20 names were picked by hand from each repo's index after checking the name exists in one repo and not the other.
- Duplicates use the exact and near tiers (the tiers `heal` rebuilds); no vectors. A "group" is a connected component of `similar_to` edges. "Lost" means a separate-store group that no one-store group contains in full.
- Heal re-indexes the older commit with a full `indexRepo` pass into a scratch store and replaces hono's rows; it does not exercise `heal()`'s incremental path or its write lock.
- Sibling resolution without the sibling uses the unchanged resolver rooted at middleware. With the sibling, both repos are put under one root (the workspace directory) with each workspace's `dir` prefixed by its repo directory and unique ids, and one unchanged resolver is built over them. The resolver itself cannot do this in production: it takes one `root` and one `repo`, builds every file id with that repo, and skips the workspace whose `dir` is `.` when mapping package names (so a repo's root package, such as `hono`, is never a target). GH-217 has to change that.
- The issue says stack `typescript`; `evals/oss/repos.json` accepts any lowercase stack string, so that is what both entries use.
- `pnpm biome check docs/spikes/v2-multirepo` passes. There are no tests and no `tsconfig.json` reference.

## Result against the Bar

| Bar                                                                       | Result                                                 | Met                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 id collisions                                                           | 0 for every repo-qualified id; 1 workspace id (`ws:.`) | Met for the ids GH-263 qualifies. Missed on the strictest reading, because workspace ids are not repo-qualified (the maintainer should confirm which reading the Bar means) |
| Search: at least 9 of 10 in the top 5, each direction                     | 10/10 and 10/10                                        | Met                                                                                                                                                                         |
| Duplicates: 0 groups lost                                                 | 0 lost (3 gained, cross-repo)                          | Met                                                                                                                                                                         |
| Heal: other repo's rows sha256 equal                                      | equal                                                  | Met                                                                                                                                                                         |
| Sibling: at least 95% of `hono` / `hono/*` imports resolve to hono source | 338 / 339 = 99.7%                                      | Met                                                                                                                                                                         |
| Cost: index time and size each at most 1.1x the separate stores           | 1.010x and 0.961x                                      | Met (with the construction caveat above)                                                                                                                                    |

**Verdict: go-with-changes.** Every measured Bar line holds, so M11 can go ahead on one store with a repo column. The changes to the plan:

1. Scope every "whole store" statement in `indexRepo` and `heal` to one repo (stale-file sweep, search-table rebuild, `meta` keys), and key the write lock and `head_sha` per repo.
2. Key `workspaces` by `(repo, id)` and give `files` the `repo` column; qualify workspace references in joins and in the `workspace` search filter (or qualify workspace ids with the repo, a spec section 6 change).
3. Decide who owns cross-repo derived edges (`similar_to`) and cross-repo import edges, and recompute or mark stale the importing repo's edges when the imported repo heals.
4. Make the resolver take a per-workspace root and repo (and map a repo's root package), instead of one `root` and `repo`.
5. Workspace file: check membership after walk-up, start the walk from the user's directory and compare real paths, and reject duplicate repo names and a repo listed twice (or by two files) with a message.
