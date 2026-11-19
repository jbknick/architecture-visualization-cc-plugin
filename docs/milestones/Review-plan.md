# Review plan

Status: draft plan, not yet contracts. Nothing here has been reviewed or spiked; the "Spike first" table lists what must be measured before a milestone is written as issues. Each issue edits `docs/SPEC.md` in its own PR where it changes a contract; the "Spec sections touched" lines say where. Read against `origin/main` at `7c40e8b` (M0 to M6 done) and `docs/milestones/V2-plan.md`.

## Goals

1. Every pull request shows what it changes, what consumes it, and the duplicates it adds, without anyone running a command.
2. The blast radius goes as far as the code reaches, ranked so that the top of the list is what matters, with hubs collapsed instead of flooding it.
3. Paths that the code provably cannot take are marked, never hidden.
4. A plan committed before the work gives an estimated area and radius, and the finished branch is compared with it.
5. One person can shape the map (labels, hidden parts, groups, saved views), and groups act as boundaries.

Everything here runs on the user's machine or in their CI, makes no model calls outside their own Claude session, and is free.

**UI kit.** Every UI in this plan (the curation overlay's rename, hide, group and pin controls and view switcher, the review view's outer ring and hub entries, gate labels, and M20's confirm-the-area flow) is built from SmoothUI components (https://smoothui.dev/) with Hugeicons icons (https://hugeicons.com/react-icons, the free `@hugeicons/core-free-icons` set through `@hugeicons/react`). The explorer adopts the kit first, as side work (#252); see "UI kit" below.

## Milestones and paths

| Milestone                                | Path      | What a user can do at the end                                                                                                                                                           |
| ---------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M16 Duplicates report and PR comment** | Side work | Print a duplicates report with one command; get one comment on every pull request listing the duplicates it adds and its blast radius.                                                  |
| **UI kit**                               | Side work | The explorer's panels, bars and controls use SmoothUI components and Hugeicons icons, in light and dark, with the canvases unchanged.                                                   |
| **M17 Curation overlay**                 | Path C    | Rename, hide, group and pin on the map by selection or by prompt; save views that survive re-indexing; get a warning when an edit crosses a group.                                      |
| **M18 Deeper blast radius**              | Path D    | See every consumer a change can reach, not only three hops, ranked by hop, confidence and fan-in, with hubs collapsed into one entry each.                                              |
| **M19 Gate-aware blast radius**          | Path D    | See consumers that sit behind a condition the code proves false, or behind arguments no caller passes, marked "behind a gate" with the condition, in a lower tier.                      |
| **M20 Plan to actual**                   | Path C    | From a plan committed before the work, get a proposed area and radius with confidence; confirm it on the map; get a note when an edit leaves it; see estimate against actual in the PR. |

- **Side work (M16):** runs on what exists today and comes first; M18 to M20 add to its comment.
- **Side work (UI kit, #252):** runs on what exists today and lands before M17, the first milestone that adds UI.
- **Path C (M17 → M20):** M20 confirms its area by selecting nodes on the map and stores it beside M17's overlay.
- **Path D (M18 → M19):** both change the review engine (`core/review/impact.ts`). M19's tiers are M18's.

### Where this sits relative to V2

| Milestone | Needs                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| M16       | nothing                                                                                                    |
| M17       | M7 (one data dir, no migrations); the repo part in stable IDs (M11's first issue, #214); the UI kit (#252) |
| M18       | nothing                                                                                                    |
| M19       | M10's constant evaluator; M9's argument-flow helper; M18's tiers                                           |
| M20       | M16 (the comment), M17 (selection and storage)                                                             |

M17 waits for the repo part in stable IDs so that overlay entries are not re-keyed under it. That change is M11's first issue in V2's Path B; landing it straight after M7 helps both plans.

## M16 Duplicates report and PR comment (side work)

- **`gantry duplicates [--json] [--since <ref>] [--workspace <w>]`.** The ranked groups of the Duplicates view from the same engine (section 17), with the totals strip. `--since` keeps only groups with a member added or changed after `<ref>`. Exits 0. This is the command the README Status table lists as not built.
- **PR comment.** A composite GitHub Action that indexes the checkout, runs `gantry review <base>...<head> --json` and the duplicate check on the symbols that are new or changed against the base (the pre-commit check, section 14), and posts one comment, updated in place on each push. No model calls. Exact and near tiers by default; the code-vector tier only when the workflow opts into `gantry embed`.
- The Action is something Gantry ships for users' repos. It is not CI for this repo, which keeps its rule of no hosted CI (section 1). Gantry never writes the workflow file into a target repo: the user adds it.
- **Unverified:** how the CLI is installed in a runner (today it runs from a clone; this needs a published package or a tagged build); cold index plus review time on a hosted runner; the comment size limit on large PRs; pull requests from forks, whose token cannot comment.

Spec sections touched: 1 (the Action is not repo CI), 3 (`action/`), 10, 11, 13.

## UI kit (side work, #252)

- **Components:** SmoothUI, a copy-paste registry of animated React components (MIT) on Tailwind CSS 4, Motion and shadcn. Components are added with `pnpm dlx shadcn@latest add @smoothui/<name>` into `packages/explorer/web/src/components/smoothui/`, on a `base-*` (Base UI) shadcn style, and committed as source with SmoothUI's MIT notice. `SOURCES.md` beside them lists each component, its registry URL and the date copied; nothing is fetched at build time.
- **Fallback order:** a SmoothUI component; else a shadcn primitive on the same style; else hand-written, with the reason in the PR.
- **Icons:** Hugeicons only, through `HugeiconsIcon` from `@hugeicons/react` with icons from `@hugeicons/core-free-icons` (MIT). Icon imports that come with copied components (for example `lucide-react`) are replaced. No `@hugeicons-pro` package: its licence does not allow open-source icon assets.
- **What changes:** the chrome (top bar, left panel, inspector, status bar, search, lists, badges, review and cross-stack panels). The canvases (sigma, flow, three) keep drawing as they do.
- **Theme:** the explorer's light and dark tokens become the CSS variables the components read.
- **Determinism:** animations respect `prefers-reduced-motion`, and Playwright e2e and `pnpm readme:media` force reduced motion, so a second `pnpm build && pnpm readme:media` changes no PNG.
- **New dependencies** (section 2): `@hugeicons/react`, `@hugeicons/core-free-icons`, `tailwindcss`, `@tailwindcss/vite`, `motion`, `clsx`, `tailwind-merge`, and the Base UI package the style needs. The shadcn CLI runs through `pnpm dlx` and is not a dependency.
- **Verify:** `pnpm check`; the explorer's Playwright suites; `pnpm readme:media` twice with no diff; `rg -n "lucide-react|@hugeicons-pro" packages/explorer` prints nothing; the perf spec's budgets hold and the PR records the bundle-size change; every view on `fixtures/pnpm-turbo`, opened from the built CLI in light and dark, matches the regenerated README images.

Spec sections touched: 2, 11.

## M17 Curation overlay (Path C)

- **Overlay file.** `<dataDir>/overlay.db`, separate from `gantry.db`. M7 deletes and rebuilds a store whose schema is not current; curation must not be deleted with it. The `dismissals` and `layouts` tables move here for the same reason: both hold a person's decisions, not index output.
- **Objects.** Label (a display name for a node), hidden (a selector), group (a name plus selectors), pin (a saved position) and saved view (a named filter spec: view, level, focus, hidden, groups, filters).
- **Selectors, not code.** A selector is a path glob, a kind, a workspace or a list of ids. A filter spec is JSON checked by zod. The same spec always draws the same picture.
- **By selection.** Rename, hide, group and pin from the explorer; a view switcher; reset.
- **By prompt.** `/gantry:view "hide tests and generated code"` runs a subagent that writes a filter spec and saves it through `gantry_save_view`, which validates it. The explorer still makes no model calls.
- **Survives re-indexing.** Selectors are evaluated on every load. An id-keyed entry whose node is gone is kept as unresolved, listed, and re-attached when a symbol with the same `exactHash` appears elsewhere (a move or rename).
- **A group is a boundary.** A group may list the groups it may use. An import or call from a member of one group to a member of a group it does not list is a crossing. Crossings appear in the Stop hook's note (inside its 600 characters) and at pre-commit. Warn only: there is no `block` mode. Groups live in the data dir, so CI does not see them and the PR comment carries no crossings.
- `views.slices` (section 5) is replaced by default groups built from the same globs; the feature slices view reads groups.
- **Unverified:** all of it. In particular how many id-keyed entries survive renames and moves, how often a prompt gives a valid spec, and how noisy boundary warnings are on a real repo.

Spec sections touched: 4, 5, 7, 9, 11 (explorer API and views), 14, 15, 16.

## M18 Deeper blast radius (Path D)

Today `computeImpact` stops at 3 hops or 500 callers (section 11, #43 and #169), on purpose: a few hops further, nearly every path reaches a hub such as a database client or a utils package, and an unlimited radius reads as "the whole repo". M18 walks further and ranks instead of cutting.

- **Walk to the end.** The walk follows the same consumer edge kinds (`CONSUMER_KINDS`) until nothing new is reached, up to a node cap fitted by the `blast-depth` spike (a note says when it is hit). Each node keeps its first hop, as now.
- **A third tier.** Directly affected (hop 1) and potentially affected (hops 2 and 3) keep their meaning and their risk rules. Hops 4 and beyond are a new tier, **reachable**, so a consumer of today's output sees the same first two tiers.
- **Ranking inside each tier:** hop, then path confidence (the lowest edge confidence on the best path; edges are `high` or `low`, section 7), then fan-in, then the existing sort (workspace, path, name, id). Deterministic.
- **Hubs collapse.** A node whose fan-in is above a threshold (fitted by the spike) is a hub. The walk goes through it, but its consumers are listed as one entry, `{ hub, consumers_total, by_workspace }`, which the explorer expands on click.
- **Where it shows.** `gantry review` prints the reachable tier's total and its top entries; `--json` has it in full, capped like the other tiers. `gantry_impact` adds totals per workspace and the collapsed hubs, inside its 4,000 characters. The review view gains an outer ring. The M16 comment shows the reachable total and the hubs.
- **Risk is unchanged** until the spike shows that a rule on the reachable tier predicts something.
- **Unverified:** whether the walk to the end stays fast on a 10,000-file repo; where the hub threshold sits; whether the ranking puts the consumers that mattered near the top.

Spec sections touched: 7, 11 (impact, review view), 13, 15 (`gantry_impact`).

## M19 Gate-aware blast radius (Path D)

A gate is a condition that stops a consumer from reaching the changed code. Static analysis can prove a gate in only two cases, and M19 handles only those:

1. **Constant condition.** The call or render that makes the consumer edge sits in a branch whose condition evaluates to a constant that skips it: `if (false)`, `const FLAG = false` then `if (FLAG)`, an enum or `as const` member. The evaluator is M10's (consts, enums, `as const` objects, `??`, concatenation, both branches of a conditional).
2. **Arguments no caller passes.** The changed code sits inside a branch on a parameter (`if (opts.x)`), and every caller on the path passes literal arguments that never satisfy it. This uses M9's argument-flow helper. It is decided per path: a caller that passes `x` keeps its path open.

- **Mark, never cut.** A gated path moves to a lower tier, **behind a gate**, with the condition and its `path:line`. It does not count in the risk rules for direct callers. It is never removed: a wrong gate would hide real risk, which is worse than showing too much, and the rule everywhere is to warn, never block.
- **Not gates:** runtime flags, environment variables, auth checks and feature-flag SDK calls. They cannot be proven, so their paths stay in their tier. Whether to label them "conditional", with the condition shown, is left to the spike.
- **Index data.** A consumer edge records whether its site is inside a conditional branch and the span of the condition, at index time, so the graph stays deterministic. TypeScript first; Go through M12's language interface.
- **Proof must be exact.** A gate is shown only when the evaluator resolves the condition fully; anything it cannot resolve leaves the path open.
- **Unverified:** how often real consumer edges sit behind a provable gate. If it is close to none, the milestone is dropped and the spike says so.

Spec sections touched: 7 (edge fields), 9, 11, 15.

## M20 Plan to actual (Path C)

- **The plan.** A markdown file committed on the branch before the work starts, for example a saved Claude Code plan. Plan paths are a config glob (section 5), `docs/plans/**` by default.
- **Estimate.** `/gantry:plan <file>` runs a subagent, as the describer and explainer run, with no API key: plan text → `gantry_search` over descriptions → candidate nodes → `gantry_impact` by hop → a proposed area with a confidence per node and its estimated radius. Plan text is untrusted and passed as data in an `untrusted_` field, as descriptions are (section 15).
- **Confirm.** A person confirms or adjusts the area by selecting nodes on the map. Estimation never runs unattended.
- **Saved with the plan.** CI has no data dir and makes no model calls, so the confirmed estimate is committed beside the plan, as `<plan>.estimate.json` (node ids, confidence, the plan's content hash). Gantry writes it only when the user runs `gantry plan save <file>`, as V2's recipe file (`.gantry/recipe.json`) is written only by init and on-request discovery. Section 1 gains that exception.
- **Scope note.** While a branch has a confirmed estimate, an edit outside the area adds one line to the Stop note. Warn only.
- **Estimate against actual.** `gantry review <base>...<head> --plan <file>`, and the M16 comment when the PR contains a plan with an estimate, list changed nodes outside the area, planned nodes left untouched, and the estimated radius against the actual one. The difference is recorded in `overlay.db` to calibrate later estimates.
- **Unverified:** estimate accuracy, which depends on description coverage. This milestone is planned as issues only if the `plan-estimates` spike passes.

Spec sections touched: 1, 4, 5, 9, 10, 11, 14, 15, 16.

## Spike first

Each is a report under `docs/spikes/<name>.md` with a verdict, on public repos only.

| Spike          | Question                                                                                                                                                                                                              | Blocks |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| ci-install     | How is the CLI installed in a runner? Cold index, review and comment time on a hosted runner for 1,000, 5,000 and 10,000 files.                                                                                       | M16    |
| overlay-ids    | Replaying a public repo's history, what share of id-keyed overlay entries survive renames and moves, with and without re-attaching by `exactHash`?                                                                    | M17    |
| prompt-views   | For 30 prompts, how often does the subagent write a valid filter spec, and does the same prompt give the same picture?                                                                                                | M17    |
| blast-depth    | On public repos' PR history: radius size per hop when the walk runs to the end; time on 10,000 files; the hub threshold; whether the ranking puts the consumers the same PR or its follow-up fix edited near the top. | M18    |
| blast-gates    | How often consumer edges sit behind a constant condition or a literal-argument branch; on hand-labelled samples, whether every gate the evaluator proves is real (the bar is no false gates).                         | M19    |
| plan-estimates | For at least 100 merged public PRs, with the PR description or its linked issue as the plan, run at the base: how much of the changed set does the estimate find, and how much of it is wrong?                        | M20    |

## Contract changes by spec section

| Section                | Change                                                                                                                                                                                                                      | Milestone     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1 Ground rules         | The shipped GitHub Action is not CI for this repo. `gantry plan save` writes an estimate file into the repo, on request only.                                                                                               | M16, M20      |
| 3 Repo layout          | `action/`.                                                                                                                                                                                                                  | M16           |
| 2 Dependencies         | The UI kit's packages (see "UI kit").                                                                                                                                                                                       | UI kit        |
| 4 Paths and data       | `overlay.db` in the data dir.                                                                                                                                                                                               | M17           |
| 5 Config               | `views.slices` replaced by overlay groups. Plan paths glob. No `block` mode for boundaries or scope.                                                                                                                        | M17, M20      |
| 7 Core types           | `Selector`, `FilterSpec`, `Group`, `SavedView`, `PlanEstimate`. Edge fields for conditional sites. Tier `reachable` and `gated`.                                                                                            | M17 to M20    |
| 9 Store schema         | Overlay schema: labels, hidden, groups, group rules, pins, views, dismissals (moved), layouts (moved), estimates and their outcomes. Edge condition spans.                                                                  | M17, M19, M20 |
| 10 CLI                 | `gantry duplicates`, `gantry plan save`, `gantry review --plan`.                                                                                                                                                            | M16, M20      |
| 11 Lifecycle, explorer | Overlay applied at view time. Impact walk to the end, ranking, hubs, gates. Explorer API: overlay read and write, estimates, review view outer ring.                                                                        | M17 to M20    |
| 13 Fixtures and evals  | Public fixtures for overlays, deep radius, gates and plans. Evals on public repos' PR and issue history only.                                                                                                               | all           |
| 14 Hook contracts      | Stop and pre-commit notes gain boundary crossings and scope, inside the existing 600 characters and budget.                                                                                                                 | M17, M20      |
| 15 MCP                 | New: `gantry_save_view`, `gantry_propose_change`. `gantry_open_view` accepts a saved view. `gantry_impact` gains the reachable tier, hubs and gates. Every answer stays within 4,000 characters; plan text is `untrusted_`. | M17 to M20    |
| 16 Plugin              | Skills `view`, `plan`. Agents for prompt-to-spec and plan estimation, run as the describer and explainer are.                                                                                                               | M17, M20      |

## Conflicts with the V2 plan and the spec

- **M11's ordering.** M17 needs the repo part in stable IDs, which is M11's first issue (#214), after M12 in Path B. Split it out of #214 and land it straight after M7. V2 already says Path A rebases its snapshots onto this change, so earlier is cheaper for every path.
- **M7 deletes stale stores.** That would delete curation and "not a duplicate" decisions if they stayed in `gantry.db`. M17 moves them to the overlay file, which M7's rule must not cover.
- **Section 1** says never to add GitHub Actions. M16 ships one for users. The spec must say the rule is about this repo's own gate.
- **Section 1 and the README** say nothing is written into the repo's working tree, except by `gantry hooks install` and, from V2's M9, the committed recipe. M20's `gantry plan save` is one more exception, run only by the user.
- **M9 recipes are committed** (`.gantry/recipe.json`, #244), so the M16 Action applies the same recipe as every developer and its radius matches the local one. A repo with no recipe gets a structural radius, and the comment says so.
- **M19 waits on V2.** It reuses M10's evaluator and M9's argument-flow helper rather than writing its own.

## Not covered

- Whether "conditional" (unproven) paths are labelled, or left as they are.
- Whether M20's estimate file lives beside the plan or in one folder for the repo.

## Still unverified

- Everything in M16 to M20. Nothing here was spiked.
- CLI distribution for CI.
- That hooks stay inside 1,500 ms with the boundary and scope checks added.
- That one comment per PR stays readable once it carries duplicates, the three tiers, hubs, gates and plan against actual.
