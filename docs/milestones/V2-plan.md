# V2 plan

Status: reviewed plan, not yet contracts. Each issue edits `docs/SPEC.md` in its own PR where it changes a contract; the "Spec sections touched" lines say where. The evidence behind this revision is in `docs/spikes/V2-assumptions.md` and the six `docs/spikes/v2-*.md` reports. Recipes are written by hand. How every issue is verified is in "Verification"; the order issues are built in is in "Build order".

## Goals

1. Any TypeScript project works, whatever its layout: one package, any monorepo tool, project references only, or none.
2. Go backends, with full symbol support (descriptions, search, duplicate warnings, callers). Java follows after V2 through the same language interface.
3. Any web framework and any ORM, in TypeScript and Go, with no framework- or ORM-specific code. A person writes each repo's recipe by hand and checks it with `gantry recipe check --nodes`; the recipe is committed to the repo and every index re-runs that same recipe unchanged, like a workflow, so no stack variation is wired into the code.
4. Multirepo is a first-class case. Calls link across repos to the handlers that serve them, by method and path, without OpenAPI.

There are no users. Nothing in V2 keeps old stores, old data directories or old formats working: when the store format changes, the index is rebuilt from scratch.

UI that V2 adds or changes in the explorer (repo grouping on the project map, Go labels) uses the explorer's UI kit: SmoothUI components (https://smoothui.dev/) and Hugeicons icons (https://hugeicons.com/react-icons, free set), adopted as side work in #252 (see `docs/milestones/Review-plan.md`, "UI kit").

## Milestones and paths

The work is groundwork (M7) and then two paths. Path B is self-contained: it needs nothing from Path A. Path A carries the release at its end, where it waits on Path B. Path B is the shorter path and runs Go first, so the wait should be met before Path A reaches it. The paths can run in parallel or as a waterfall.

| Milestone                        | Owner  | What a user can do at the end                                                                                                                                                                                                                                        |
| -------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M7 V2 groundwork**             | First  | Nothing new; the legacy data dir, store migrations and index-format re-index are gone.                                                                                                                                                                               |
| **M9 Recipes**                   | Path A | Write a recipe by hand for whatever frameworks and ORMs the repo uses, check it with `gantry recipe check --nodes`, and commit it; every index re-runs it unchanged. Routes, endpoints, tables, reads and writes come from recipes. No hand-written adapters remain. |
| **M10 Call linking in one repo** | Path A | Calls through client instances, wrappers, constants and env-var base URLs link to their handlers in the same repo.                                                                                                                                                   |
| **M8 Any TypeScript project**    | Path A | Index any TypeScript layout: one package, any workspace tool, project references only, or no workspace tool; bundler aliases resolve; a 10,000-file repo is ready in about a minute.                                                                                 |
| **M15 V2 release**               | Path A | Trace a TypeScript page to the Go handler and tables that serve it in another repo; V2 is tagged.                                                                                                                                                                    |
| **M12 Go backends**              | Path B | Index Go modules with symbols, callers, duplicate warnings and descriptions.                                                                                                                                                                                         |
| **M11 Multirepo workspaces**     | Path B | List related repos once; search, duplicates, the map and go-to-source span all of them, and each repo stays up to date on its own.                                                                                                                                   |
| **M13 Cross-repo call linking**  | Path B | A frontend call links to the handler in another repo, and a page in one repo traces to its handler and tables in another.                                                                                                                                            |

- **Path A, TypeScript then the release:** M9 → M10 → M8 → M15. M9 opens with a spike (#246), because generic data-access helpers are a bet the rest of V2 stands on. M10 follows, because a frontend calling an API through a client instance, a wrapper or an env-var base URL needs it next. M8 closes the remaining layout gaps: monorepos on pnpm, npm, yarn, bun, Nx and Turborepo already index.
- **Path B, Go and multirepo (17 issues):** M12 → M11 → M13. M12 goes first so the Go module is ready early; M11 and M12 do not depend on each other.
- **Groundwork (9 issues):** M7, built first, before both paths. It removes the legacy paths, makes the quality gate safe to run in several checkouts at once (#258), pins the toolchain (#259), adds the evaluation corpus (#260) and puts the repo part into stable IDs (#263), so the store schema changes of Path B (M11's repo column, M12's `lang` field) need no migration and nothing built later is re-keyed.

### Where Path A waits on Path B

| Path A work                                                               | Needs from Path B               |
| ------------------------------------------------------------------------- | ------------------------------- |
| M15: Trace a TypeScript page to the Go handler and tables in another repo | Trace a page across repos (M13) |

Touch points, not waits: M11's first issue adds a repo part to stable IDs (section 6) and M12's first adds a `lang` field; Path A rebases its snapshots onto both. M8 and M11 both touch workspace discovery. M10 and M13 both extend `clients.ts`: M10 widens what counts as a call, M13 widens where its handler can be. Recipes reach languages only through the existing adapter resolver contract (`resolveSpecifier`, `resolveSymbol`), so the recipe engine and the language interface are built without waiting on each other. Path B's linking work runs on endpoints from the shipped adapters until M9 replaces them with recipes that emit the same node kinds.

## M7 V2 groundwork (first)

- Remove the legacy data-dir fallback (`~/.gantry/data`): the plugin data dir is the only location (section 4).
- Remove the numbered store migrations and the `meta.index_format` re-index (#195). There is one schema. A store whose schema version is not the current one is deleted and rebuilt, and the user is told (sections 9, 11).

- The quality gate runs beside untracked local files and never edits tracked sources (#258); Node 26 and the pnpm version in use are pinned (#259).
- The evaluation corpus and clone script (#260; see "Verification").
- `gantry review --json` is byte-stable (#261); search ranks the same function first with and without embeddings (#262).
- **Stable IDs gain a repo part** (#263, section 6): file, symbol and adapter IDs carry a repo name that is the same on every machine and in CI. The name is the `repo` field of the workspace file, and by default the owner and name of the `origin` remote, or the directory name when there is no remote. Never a local path or `worktreeHash`. The repo part follows the prefix: `file:<repo>:<path>`, `sym:<repo>:<path>#<name>`, and the same for route, endpoint, middleware, table and client-call ids. Workspace ids (`ws:<package name>`) stay as they are.

Spec sections touched: 1, 4, 6, 9, 11, 13, 14.

## M8 Any TypeScript project (Path A)

Most layouts already work: pnpm, `package.json` workspaces (npm, yarn, bun), Nx `project.json`, and single packages are detected, and the resolver already follows tsconfig with `references: "auto"`. M8 closes the remaining, verified gaps:

- A repo whose packages are tied together only by tsconfig project references.
- A repo with several `package.json` files and no workspace tool.
- Bundler aliases (Vite, webpack) that are not in tsconfig `paths`.
- A tsconfig that extends one provided by a workspace package loses its own `paths` when the target repo has no `node_modules` (#265). Measured on formbricks at `b52ebf8`: 12,996 unresolved imports on a fresh clone, 652 once that one package is linked.
- A measured cold index (#202): a pinned public repo of at least 10,000 TypeScript files indexes in 60 s or less on the reference machine (Apple M3 Pro), median of 3 runs from fresh data dirs, recorded in `docs/milestones/M8.md`. Measured so far: 6,033 files in 28 s.

Spec sections touched: 3 (workspace discovery), 5, 13.

## M9 Recipes (Path A)

### The rule

No framework- or ORM-specific code. Framework and data-access knowledge lives only in a repo's recipe, which a person writes by hand. Gantry ships the engine and generic helpers. A stack the engine cannot express is fixed in a generic helper, never with code for that stack. Spec section 1 gains this rule.

### Recipes

- **Recipe, not live inference.** Spec section 1 requires deterministic output. The recipe is written once, and the indexer applies the same recipe with `@ast-grep/napi` on every index, like a workflow. Same repo and same recipe give the same graph (confirmed in `v2-recipes`).
- **Committed to the repo.** The recipe is `.gantry/recipe.json` at the repo root, one per repo, covering every workspace in it. The user writes it and commits it; Gantry never writes or commits it. A commit's graph depends only on that commit's tree, recipe included, so CI, teammates and every machine build the same graph, and `gantry review <base>...<head>` reads each side's recipe from its own ref. Git history is the recipe's version log.
- **A recipe is data, never code.** Rules, examples and helper names, checked by zod; it cannot run anything, so a recipe from an untrusted pull request is safe to apply. A repo with no recipe gets the structural graph only.
- **Recipes run inside the existing adapter framework.** One generic recipe adapter implements the current `Adapter` interface (`extract`/`link`) and is registered where the hand-written adapters are today. The hand-written TanStack Router, TanStack Start, Hono, oRPC and Drizzle adapters are deleted once recipes reproduce `fixtures/adapters` and `fixtures/pnpm-turbo` (#203, #206, #247). `clients.ts` stays as the shared client-call matcher (it is not framework-specific) and is extended in M10 and M13.
- **What a recipe holds.** The dependencies it has classified (what each is, or that it is neither a framework nor data access); rules that emit route, page, router, mount, endpoint, client-call and table nodes and the existing `serves`, `handles`, `requests`, `reads`, `writes` and `contains` edges (sections 7, 9). Each rule names its language. No framework versions. A collection counts as a table.
- **Validation.** Each rule carries example snippets that must and must not match; a recipe is accepted only when all examples pass. A rule that matches nothing in the repo is a warning, not a rejection. `gantry recipe check` validates the file, runs every example and counts each rule's matches; with `--nodes` it also lists the nodes the index would store, so the author sees what the recipe produces before committing it.
- **Unresolved sites stay visible** as low-confidence nodes with a reason.

### Generic helpers

Rules alone are not enough (spike: Hono 0 of 7 endpoints with rules only, 7 of 7 with helpers). Recipes may name these helpers, which use the language's resolver, not the syntax tree:

- **Routes and endpoints** (from `v2-recipes`): name resolution, constant strings, mount graph (routers mounted under prefixes, across files; also nested route objects and nested JSX route elements, whose child paths join their parent's), call return, argument flow, and file-system routing (TanStack Router files, Next.js `app/` and `pages/`, React Router's `flatRoutes()`, Fastify's `@fastify/autoload` directories).
- **Data access** (#247; settled by the `v2-data-access` spike, #246): SQL text (table names and read or write from SQL in strings, template literals, tagged templates and `.sql` files), text rules (line and pattern rules for files with no syntax tree in the index, such as Prisma schemas and SQL migrations), model naming (a recipe-stated rule from a model, entity or struct name to its table: explicit map, snake case, plural), and method classes (a recipe-stated list of which methods on a client, repository or query builder read and which write).

A table named only at runtime is a low-confidence node with a reason, never a guess.

### Spike first

| Spike                   | Question                                                                                                                                                                                                     | Blocks     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `v2-data-access` (#246) | Do the four data-access helpers, with the existing ones, find tables, reads and writes for Drizzle, Prisma, TypeORM, Kysely, Sequelize, MikroORM, Mongoose, raw SQL, database/sql, sqlx, sqlc, GORM and ent? | #247, #249 |

New dependency: pin `@ast-grep/napi` 0.51.3 exactly (section 2; approved but not yet installed). Prebuilds cover macOS arm64 and x64, Linux arm64 and x64, and Windows x64; there is none for Windows arm64.

Spec sections touched: 1 (no framework or ORM code; the committed recipe file), 2, 3, 4 (`.gantry/recipe.json`), 5 (recipe file, helpers), 7 (node kinds), 10 (`gantry recipe check`), 11 (recipe per ref), 13.

## M10 Call linking in one repo (Path A)

Runs straight after M9, before M8 (#242): it is what a frontend calling an API through a client instance, a wrapper or an env-var base URL needs next.

Today `clients.ts` matches literal `fetch`/`ky`/`axios` URLs by method and path. On public full-stack repos it linked 1 of 70 linkable calls; the spike prototype linked 70 of 70 with no wrong links, but only 35% on a held-out repo before one fix, so the numbers below are targets, not measured results. Everything here works and is tested inside one repo.

- **Client instances.** `axios.create`, `ky.create` and `ky.extend`, and the default instance configured through `axios.defaults.baseURL`, are followed through imports, with each library's own URL joining rules.
- **Wrappers.** A function whose parameter supplies the start of the path or the method is inferred as a client wrapper; a recipe can list wrappers as an override.
- **Constant URLs.** A small evaluator reads consts, enums, `as const` objects, env members, `??`, concatenation, `new URL` and both branches of a conditional.
- **Base URLs.** The recipe maps `env:<NAME>`, `url:<origin>` and `path:<prefix>` to `{ workspace, prefix? }`, where `workspace` is a package in the repo (M13 lets it name a package in another repo). The prefix is required: in the held-out repo `VITE_API_URL` ends in `/api`, and the value is not in the repo (`.env*` is excluded as sensitive). The recipe author writes the entries from the code, dev-server proxies and `.env.example`; a call that matches no entry stays unlinked.
- **Matching.** A literal segment beats a parameter. Several candidates, or a parameter against a literal segment, give a low-confidence "ambiguous" node with its candidates, never a link.
- **OpenAPI is out of V2.** Endpoints come from code only.

Spec sections touched: 5, 7, 9, 15.

## M11 Multirepo workspaces (Path B)

- **One store per workspace.** A workspace file, `gantry-workspace.json`, found by walking up from a repo, lists the repos of one Gantry project by local path (no remote URLs). Its repos share one database with a repo column, so cross-repo edges, `trace` and search need no federated query layer. A repo used alone is a workspace of one.
- **Stable IDs already carry a repo part** (M7, #263), so file and symbol IDs stay unique across repos.
- **Heal per repo.** Each repo's HEAD, hooks and working layer update only that repo's rows.
- **Sibling packages.** A dependency on a package that a sibling repo publishes resolves to that repo's source, not `node_modules`.
- **Across repos:** search, the function index, duplicate warnings (within one language) and the project map, which groups by repo.
- **Spike first** (#273): one store for two pinned public repos, measuring search, duplicates, heal per repo and sibling-package resolution, before #214 starts.
- **Recipes per repo.** Each repo has its own committed recipe, written by hand.
- **Unverified:** all of M11; nothing here was spiked.

Spec sections touched: 4, 5, 6, 9, 10, 11, 15, 17.

## M12 Go backends (Path B)

### Language interface

The TypeScript pipeline is split into a language module and shared code before Go is added. The split is driven by what the spikes showed each side must own:

- **The language supplies:** file match and skip rules; workspace discovery from manifests; parsing to symbols; import resolution and the adapter resolver; call and type edges with confidence; for each symbol `{ exact, shape, selfRefs, stmtCount }` token streams and the text used for code embeddings; fact sheet fields and prompt hints; display labels for symbol kinds.
- **Shared code computes all five hashes** (`exactHash`, `renamedHash`, `shapeHash`, `minhash`, `nearMinhash`) from those streams. With the TypeScript streams this was byte-identical on every fixture and on this repo (3,337 symbols). A shared, language-blind normaliser is not used: it changed every TypeScript hash.
- **Symbol kinds stay a neutral set** (section 7). A Go struct is `class`, shown as "struct".
- **Records carry a `lang` field** (files and symbols). Adding it is the only intended change to the TypeScript graph when the split lands; hashes, IDs and edges stay identical.
- **Duplicate tiers** are one algorithm with thresholds per language. Go starts with the TypeScript thresholds and is refit only if seeded Go duplicates fail. Comparisons never cross languages.
- **No formal conformance suite in V2.** The TypeScript and Go fixture snapshots are the test; the suite is written when Java needs it.

### Go module

- **Parser.** tree-sitter Go through `@ast-grep/lang-go` 0.0.6 on `@ast-grep/napi` 0.51.3, pinned exactly (section 2). No Go toolchain on the user's machine. Measured: 100% symbol precision and recall on 11,893 symbols from two public repos, about 1,700 to 2,200 files per second.
- **Workspaces.** Each `go.mod` module is a workspace; `go.work` groups them. `vendor/`, generated files and `_test.go` follow the existing skip and test rules (`vendor/` and `go.work` are unverified: no tested repo had them).
- **Symbols and IDs.** `func` is `function`, a func with a receiver is `method`, a struct is `class`. Exported means upper-case first letter. Stable IDs are defined for symbols declared in several build-constrained files; `_` and `init` are excluded from duplicate checks.
- **Calls.** Syntax only, with local type inference for calls on concrete types (receivers, parameters, literals, constructor results, field chains, embedding, range and element types); without it only about 29% of in-repo calls resolve. Calls through an interface resolve to the interface method at high confidence. Interface satisfaction is computed by method-name matching as low-confidence `implements` edges. Measured against go/packages: same-package and package-qualified calls 99.9 to 100%, concrete methods 93 to 96%, interface methods 78 to 79%, overall 92 to 97% recall at 99.99 to 100% precision. No helper binary.
- **Imports** map package names from the target's `package` clause, not the last path element.
- **Descriptions.** Fact sheets work as they are; the prompt gains a language field.

Spec sections touched: 2, 3 (`lang/`), 7 (`lang` field), 8, 9, 13, 17.

## M13 Cross-repo call linking (Path B)

- **Across repos** (after M11): the existing `clients.ts` matching runs over every repo in the workspace, on endpoints from whatever produces them (the shipped adapters now, recipes after M9). The existing `trace` and views then show page → call → handler → table across repos. No new trace views.
- M10's client forms (instances, wrappers, constants, base URLs) reach across repos once both milestones land; neither waits on the other.

Spec sections touched: 9, 15.

## M15 V2 release (Path A)

- The end-to-end case on public code: a TypeScript frontend repo and a Go backend repo in one workspace; a page traces to the Go handler that serves it and the tables it reads and writes (#231).
- README, install guide and Status table describe V2. Tag the release.

## Verification

Every issue states a Verify block: the exact commands, their inputs and the expected output (section 19). These rules apply to all of them.

- **Pinned corpus (#260).** `evals/oss/repos.json` lists every public repo an evaluation uses: name, URL, full commit SHA, stack and role (`tuning` or `held-out`). `pnpm eval:clone` clones each one at its SHA into `~/Dev/gantry-oss/<name>@<sha7>` (`GANTRY_OSS_DIR` overrides the directory), outside this repo. Nothing is measured on a repo that is not in the file. Already pinned: `formbricks/formbricks@b52ebf833e92c1205d95492dc43567760ef56706` (Next.js, Prisma), `gothinkster/node-express-realworld-example-app@30b68e1e881462b2f4164ea09ab4c4f5699c7b0b` (Express, Prisma) and `dotnize/react-tanstarter@7faa622c492fc3f699dc959afc69a76205bb1774` (TanStack Start, Drizzle).
- **Byte-stable output.** `index --dump`, `trace --json` and `review --json` (#261) are compared by sha256 across two fresh data dirs (`CLAUDE_PLUGIN_DATA=<tmp>`).
- **Timings** are measured on a named machine, recorded in the milestone report as the median of 3 runs, and never part of `pnpm check`.
- **UI** is checked by a Playwright spec in `packages/explorer/web/e2e`, with reduced motion forced, against the built CLI's `map` on a fixture. The issue lists the steps the spec takes.
- **Search and descriptions.** A check that depends on search sets the model directory and says whether vectors exist (#262); a check that depends on descriptions uses committed description fixtures, not a describer run.
- **Milestone reports.** The last issue of each milestone runs its regression and writes `docs/milestones/M<n>.md`: #264 (M7), #266 (M8), #270 (M9), #274 (M11), #275 (M12), #276 (M13), #233 (M15).

## Build order

Blocked-by relations between issues are kept in the tracker. These contracts and files have one writer at a time:

- **Store schema, stable IDs and snapshots:** #258 and #259, then #189 → #198 → #263 (repo part in IDs) → #220 (`lang` field) → #203 (recipe engine). #214 follows #263 and the spike #273.
- **`clients.ts`:** #225 → #226 → #227 → #228 → #229.
- **Workspace discovery:** #199, #200, #265, #214 and #221, one at a time in the order they become ready.
- **`fixtures/react-router-fastify`:** #267 creates it; #240 and #241 only read it.

Other order that the milestone order does not show:

- #260 (corpus) comes before any measurement on public repos.
- #246 blocks #247 and #249.
- #247 deletes the Drizzle adapter; #206 deletes the oRPC and TanStack Start ones.
- M10's issues follow #203. Its evaluation repos (#271) have Express or Fastify backends, so they are measured after #207 and #241; no M10 case waits for another framework.

## Lost or at risk

- A stack added to a repo is not mapped until someone updates the recipe.
- A recipe file in every repo, written and committed by the user.
- Sharing one repo's store across workspaces (one store per workspace).
- OpenAPI as a link source, and with it spec-versus-code drift reports.
- A formal conformance suite for languages, until Java needs it.

## Out of scope for V2

- Languages other than TypeScript and Go. Java is next, through the M12 language interface.
- OpenAPI, gRPC, GraphQL and message queues as link sources.
- Remote repos in a workspace file.
- Any legacy fallback, migration or upgrade path.

## Still unverified

- The data-access helpers on any ORM (#246).
- Every framework and ORM as a recipe except the five spiked (TanStack Router, Hono, Express, chi, gin); net/http patterns; Fastify autoload; echo and fiber.
- Everything in M11 (#273 measures it first).
- A 10,000-file cold index (extrapolated).
- Go `vendor/` and `go.work`; Go duplicate thresholds; Go descriptions.
- Windows arm64 (no ast-grep prebuild) and Linux musl.
