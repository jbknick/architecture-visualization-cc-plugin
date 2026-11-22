# Review plan

Status: draft plan, not yet contracts. Nothing here has been spiked; each milestone starts with a spike, and its issues start only when that spike meets its bar ("Spike first"). Each issue edits `docs/SPEC.md` in its own PR where it changes a contract; "Contract changes by spec section" says where. How every issue is verified is in "Verification". Read with `docs/milestones/V2-plan.md`.

## Goals

1. Every pull request shows what it changes, what consumes it, and the duplicates it adds, without anyone running a command.
2. The blast radius goes as far as the code reaches, ranked so that the top of the list is what matters, with hubs collapsed instead of flooding it.
3. One person can shape the map (labels, hidden parts, groups, saved views), and groups act as boundaries.

Everything here runs on the user's machine or in their CI, makes no model calls outside their own Claude session, and is free.

**UI kit.** Every UI in this plan (the curation overlay's rename, hide and group controls and view switcher, the review view's outer ring and hub entries) is built from SmoothUI components (https://smoothui.dev/) with Hugeicons icons (https://hugeicons.com/react-icons, the free `@hugeicons/core-free-icons` set through `@hugeicons/react`). The explorer adopts the kit first, as side work (#252); see "UI kit" below.

## Milestones and paths

| Milestone                                | Path      | What a user can do at the end                                                                                                              |
| ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **M16 Duplicates report and PR comment** | Side work | Print a duplicates report with one command; get one comment on every pull request listing the duplicates it adds and its blast radius.     |
| **UI kit**                               | Side work | The explorer's panels, bars and controls use SmoothUI components and Hugeicons icons, in light and dark, with the canvases unchanged.      |
| **M17 Curation overlay**                 | Path C    | Rename, hide and group on the map; save views that survive re-indexing; get a warning when an edit crosses a group.                        |
| **M18 Deeper blast radius**              | Path D    | See every consumer a change can reach, not only three hops, ranked by hop, confidence and fan-in, with hubs collapsed into one entry each. |

- **Side work (M16):** runs on what exists today and comes first; M18 adds to its comment.
- **Side work (UI kit, #252):** runs on what exists today and lands before M17, the first milestone that adds UI.
- **Path C (M17):** the curation overlay.
- **Path D (M18):** changes the review engine (`core/review/impact.ts`).

### Where this sits relative to V2

| Milestone | Needs                                                                                   |
| --------- | --------------------------------------------------------------------------------------- |
| M16       | nothing                                                                                 |
| M17       | M7 (one data dir, no migrations); the repo part in stable IDs (#263); the UI kit (#252) |
| M18       | nothing                                                                                 |

M17 waits for the repo part in stable IDs so that overlay entries are not re-keyed under it. That change is M11's first issue in V2's Path B; landing it straight after M7 helps both plans.

## M16 Duplicates report and PR comment (side work)

- **`gantry duplicates [--json] [--since <ref>] [--workspace <w>]`.** The ranked groups of the Duplicates view from the same engine (section 17), with the totals strip. `--since` keeps only groups with a member added or changed after `<ref>`. Exits 0. This is the command the README Status table lists as not built.
- **PR comment.** A composite GitHub Action that indexes the checkout, runs `gantry review <base>...<head> --json` and the duplicate check on the symbols that are new or changed against the base (the pre-commit check, section 14), and posts one comment, updated in place on each push. No model calls. Exact and near tiers by default; the code-vector tier only when the workflow opts into `gantry embed`.
- The Action is something Gantry ships for users' repos. It is not CI for this repo, which keeps its rule of no hosted CI (section 1). Gantry never writes the workflow file into a target repo: the user adds it.
- **Install in a runner.** `pnpm release` builds a tarball that a tagged GitHub release carries (#281); the Action downloads it by tag and checksum. The tarball holds the bundled CLI and a lockfile for its native dependencies (`better-sqlite3`, `sqlite-vec`, the parsers), which the runner installs with `npm ci`; there is one tarball, not one per platform. No package registry for Gantry itself.
- **Issues:** #279 (spike), #280, #281, #282, #283 (report).
- **Unverified:** cold index plus review time on GitHub's runner; the comment size limit on large PRs; pull requests from forks, whose token cannot comment.

## UI kit (side work, #252)

- **Components:** SmoothUI, a copy-paste registry of animated React components (MIT) on Tailwind CSS 4, Motion and shadcn. Components are added with `pnpm dlx shadcn@latest add @smoothui/<name>` into `packages/explorer/web/src/components/smoothui/`, on a `base-*` (Base UI) shadcn style, and committed as source with SmoothUI's MIT notice. `SOURCES.md` beside them lists each component, its registry URL and the date copied; nothing is fetched at build time.
- **Fallback order:** a SmoothUI component; else a shadcn primitive on the same style; else hand-written, with the reason in the PR.
- **Icons:** Hugeicons only, through `HugeiconsIcon` from `@hugeicons/react` with icons from `@hugeicons/core-free-icons` (MIT). Icon imports that come with copied components (for example `lucide-react`) are replaced. No `@hugeicons-pro` package: its licence does not allow open-source icon assets.
- **What changes:** the chrome (top bar, left panel, inspector, status bar, search, lists, badges, review and cross-stack panels). The canvases (sigma, flow, three) keep drawing as they do.
- **Theme:** the explorer's light and dark tokens become the CSS variables the components read.
- **Determinism:** animations respect `prefers-reduced-motion`, and Playwright e2e and `pnpm readme:media` force reduced motion, so a second `pnpm build && pnpm readme:media` changes no PNG.
- **New dependencies** (section 2): `@hugeicons/react`, `@hugeicons/core-free-icons`, `tailwindcss`, `@tailwindcss/vite`, `motion`, `clsx`, `tailwind-merge`, and the Base UI package the style needs. The shadcn CLI runs through `pnpm dlx` and is not a dependency.
- **Verify:** `pnpm check`; the explorer's Playwright suites; `pnpm readme:media` twice with no diff; `rg -n "lucide-react|@hugeicons-pro" packages/explorer` prints nothing; the perf spec's budgets hold and the PR records the bundle-size change; every view on `fixtures/pnpm-turbo`, opened from the built CLI in light and dark, matches the regenerated README images.

## M17 Curation overlay (Path C)

- **Overlay file.** `<dataDir>/overlay.db`, separate from `gantry.db`. M7 deletes and rebuilds a store whose schema is not current; curation must not be deleted with it. The `dismissals` and `layouts` tables move here for the same reason: both hold a person's decisions, not index output.
- **Objects.** Label (a display name for a node), hidden (a selector), group (a name plus selectors) and saved view (a named filter spec: view, level, focus, hidden, groups, filters).
- **Selectors, not code.** A selector is a path glob, a kind, a workspace or a list of ids. A filter spec is JSON checked by zod. The same spec always draws the same picture.
- **By selection.** Rename, hide and group from the explorer; a view switcher; reset.
- **Survives re-indexing.** Selectors are evaluated on every load. An id-keyed entry whose node is gone is kept as unresolved, listed, and re-attached when a symbol with the same `exactHash` appears elsewhere (a move or rename).
- **A group is a boundary.** A group may list the groups it may use. An import or call from a member of one group to a member of a group it does not list is a crossing. Crossings appear in the Stop hook's note (inside its 600 characters) and at pre-commit. Warn only: there is no `block` mode. Groups live in the data dir, so CI does not see them and the PR comment carries no crossings.
- `views.slices` (section 5) is replaced by default groups built from the same globs; the feature slices view reads groups.
- **Issues:** #284 (spike), #285 to #290, #291 (report).
- **Unverified:** all of it. In particular how many id-keyed entries survive renames and moves, and how noisy boundary warnings are on a real repo.

## M18 Deeper blast radius (Path D)

Today `computeImpact` stops at 3 hops or 500 callers (section 11, #43 and #169), on purpose: a few hops further, nearly every path reaches a hub such as a database client or a utils package, and an unlimited radius reads as "the whole repo". M18 walks further and ranks instead of cutting.

- **Walk to the end.** The walk follows the same consumer edge kinds (`CONSUMER_KINDS`) until nothing new is reached, up to a node cap fitted by the `blast-depth` spike (a note says when it is hit). Each node keeps its first hop, as now.
- **A third tier.** Directly affected (hop 1) and potentially affected (hops 2 and 3) keep their meaning and their risk rules. Hops 4 and beyond are a new tier, **reachable**, so a consumer of today's output sees the same first two tiers.
- **Ranking inside each tier:** hop, then path confidence (the lowest edge confidence on the best path; edges are `high` or `low`, section 7), then fan-in, then the existing sort (workspace, path, name, id). Deterministic.
- **Hubs collapse.** A node whose fan-in is above a threshold (fitted by the spike) is a hub. The walk goes through it, but its consumers are listed as one entry, `{ hub, consumers_total, by_workspace }`, which the explorer expands on click.
- **Where it shows.** `gantry review` prints the reachable tier's total and its top entries; `--json` has it in full, capped like the other tiers. `gantry_impact` adds totals per workspace and the collapsed hubs, inside its 4,000 characters. The review view gains an outer ring. The M16 comment shows the reachable total and the hubs.
- **Risk is unchanged** until the spike shows that a rule on the reachable tier predicts something.
- **Issues:** #292 (spike), #293 to #296, #297 (report).
- **Unverified:** whether the walk to the end stays fast on a 10,000-file repo; where the hub threshold sits; whether the ranking puts the consumers that mattered near the top.

## Spike first

Each is a report under `docs/spikes/<name>.md` with a verdict, on public repos pinned in `evals/oss/repos.json` (V2 plan, "Verification"). A spike that misses its bar stops its milestone, and the maintainer decides what happens next.

| Spike              | Question                                                                                                                                                                                                         | Bar                                                                                                                  | Blocks |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| ci-install (#279)  | Does the release tarball install in GitHub's runner? Cold index, review and comment time at 1,000, 5,000 and 10,000 files.                                                                                       | Install, index, review and comment in 5 minutes or less at 5,000 files on `ubuntu-latest`, in a public sandbox repo. | M16    |
| overlay-ids (#284) | Replaying at least 500 commits of a pinned repo, what share of id-keyed overlay entries on symbols that still exist survive renames and moves, with and without re-attaching by `exactHash`?                     | At least 90% survive with re-attaching.                                                                              | M17    |
| blast-depth (#292) | On at least 50 merged PRs from two pinned repos: radius size per hop when the walk runs to the end; time on a 10,000-file repo; the hub threshold and node cap; where the consumers a follow-up fix edited rank. | The walk takes 2 s or less at 10,000 files; the report fixes the hub threshold and node cap as numbers.              | M18    |

The sandbox repo for `ci-install` is created by the maintainer; this repo keeps its rule of no hosted CI.

## Verification

The V2 plan's rules apply: a Verify block in every issue, pinned inputs, byte-stable output compared by sha256, UI through Playwright with reduced motion against the built CLI, timings in the milestone report and never in `pnpm check`. Each milestone adds:

- **M16.** `gantry duplicates --json` on `fixtures/pnpm-turbo` matches a committed snapshot, and two runs give the same sha256. The Action's script runs in vitest against a fake GitHub API (`node:http`) that asserts one comment is created, then updated in place on a second run. One real run in the sandbox repo is recorded in `docs/milestones/M16.md`.
- **M17.** Unit tests for the overlay schema and selectors. Rebuilding the index leaves `overlay.db` byte-identical (sha256 before and after). A Playwright spec renames, hides and groups a node on `fixtures/pnpm-turbo`, saves a view, reloads and finds all four. A fixture with two groups and one crossing makes the Stop hook print one exact line.
- **M18.** A new fixture, `fixtures/deep-radius`, has a six-hop chain and one hub; `gantry review <range> --json` on its committed branch matches a snapshot holding the reachable tier, the ranking and the collapsed hub. A Playwright spec finds the outer ring and expands the hub.

## Build order

- #252 (UI kit) lands alone, before any other issue that touches the explorer's panels: it restyles all of them and regenerates the README images.
- M16 needs nothing and comes first. #281 (tarball) comes before #282 (Action).
- M17 needs M7 (#198) and the repo part in stable IDs (#263), then #252.
- `core/review/impact.ts` has one writer at a time: #293 → #294.

## Cut

- Editing a view by prompt (`/gantry:view` and the tool that saved its result) and its spike. Lost: describing a view in words instead of selecting.
- Pins (saved positions). Lost: a hand-placed layout that survives a re-layout.

## Contract changes by spec section

| Section                | Change                                                                                                                                                                | Milestone |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1 Ground rules         | The shipped GitHub Action is not CI for this repo.                                                                                                                    | M16       |
| 3 Repo layout          | `action/`.                                                                                                                                                            | M16       |
| 2 Dependencies         | The UI kit's packages (see "UI kit").                                                                                                                                 | UI kit    |
| 4 Paths and data       | `overlay.db` in the data dir.                                                                                                                                         | M17       |
| 5 Config               | `views.slices` replaced by overlay groups. No `block` mode for boundaries.                                                                                            | M17       |
| 7 Core types           | `Selector`, `FilterSpec`, `Group`, `SavedView`. Tier `reachable`.                                                                                                     | M17, M18  |
| 9 Store schema         | Overlay schema: labels, hidden, groups, group rules, views, dismissals (moved), layouts (moved).                                                                      | M17       |
| 10 CLI                 | `gantry duplicates`.                                                                                                                                                  | M16       |
| 11 Lifecycle, explorer | Overlay applied at view time. Impact walk to the end, ranking, hubs. Explorer API: overlay read and write, review view outer ring.                                    | M17, M18  |
| 13 Fixtures and evals  | Public fixtures for overlays and deep radius. Evals on public repos' PR and issue history only.                                                                       | all       |
| 14 Hook contracts      | Stop and pre-commit notes gain boundary crossings, inside the existing 600 characters and budget.                                                                     | M17       |
| 15 MCP                 | New: `gantry_propose_change`. `gantry_open_view` accepts a saved view. `gantry_impact` gains the reachable tier and hubs. Every answer stays within 4,000 characters. | M17, M18  |

## Conflicts with the V2 plan and the spec

- **Stable IDs.** M17's overlay entries hold node ids, so they need the repo part in stable IDs, named the same on every machine. That is V2's #263, in M7.
- **M7 deletes stale stores.** That would delete curation and "not a duplicate" decisions if they stayed in `gantry.db`. M17 moves them to the overlay file, which M7's rule must not cover.
- **Section 1** says never to add GitHub Actions. M16 ships one for users. The spec must say the rule is about this repo's own gate.
- **M9 recipes are committed** (`.gantry/recipe.json`, #244), so the M16 Action applies the same recipe as every developer and its radius matches the local one. A repo with no recipe gets a structural radius, and the comment says so.

## Still unverified

- Everything in M16 to M18. Nothing here was spiked.
- That hooks stay inside 1,500 ms with the boundary and scope checks added.
- That one comment per PR stays readable once it carries duplicates, the three tiers and hubs.
