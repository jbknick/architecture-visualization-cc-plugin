# V2 plan

Status: reviewed plan, not yet contracts. Each issue edits `docs/SPEC.md` in its own PR where it changes a contract; the "Spec sections touched" lines say where. The evidence behind this revision is in `docs/spikes/V2-assumptions.md` and the six `docs/spikes/v2-*.md` reports. Reordered on 2026-11-19 (#242) to bring React Router and Fastify forward, then reworked the same day (#244) so recipes are written on the fly by agents and cover any ORM; neither change was reviewed or spiked (see "Reworked for agent recipes and any ORM").

## Goals

1. Any TypeScript project works, whatever its layout: one package, any monorepo tool, project references only, or none.
2. Go backends, with full symbol support (descriptions, search, duplicate warnings, callers). Java follows after V2 through the same language interface.
3. Any web framework and any ORM, in TypeScript and Go, with no framework- or ORM-specific code. An agent writes each repo's recipe on the fly and keeps it current, so no stack variation is wired by hand.
4. Multirepo is a first-class case. Calls link across repos to the handlers that serve them, by method and path, without OpenAPI.

There are no users. Nothing in V2 keeps old stores, old data directories or old formats working: when the store format changes, the index is rebuilt from scratch.

## Milestones and paths

The work is split into two paths and one piece of side work. Path B is self-contained: it needs nothing from Path A. Path A carries the work that needs both (Go frameworks and data access, and the release) at its end, where it waits on Path B twice. Path B is the shorter path and runs Go first, so both waits should be met before Path A reaches them. The paths can run in parallel or as a waterfall.

| Milestone                             | Owner     | What a user can do at the end                                                                                                                                                                                                        |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M7 V2 groundwork**                  | Side work | Nothing new; the legacy data dir, store migrations and index-format re-index are gone.                                                                                                                                               |
| **M9 Recipes by agent**               | Path A    | Init writes a recipe for whatever frameworks and ORMs the repo uses, and the agent keeps it current on its own as the stack changes. Routes, endpoints, tables, reads and writes come from recipes. No hand-written adapters remain. |
| **M10 Call linking in one repo**      | Path A    | Calls through client instances, wrappers, constants and env-var base URLs link to their handlers in the same repo.                                                                                                                   |
| **M8 Any TypeScript project**         | Path A    | Index any TypeScript layout: one package, any workspace tool, project references only, or no workspace tool; bundler aliases resolve; a 10,000-file repo is ready in about a minute.                                                 |
| **M14 Go frameworks and data access** | Path A    | Go endpoints (net/http, chi, gin, echo, fiber) and Go tables (database/sql, sqlx, sqlc, GORM, ent) come from the same agent-written recipes as TypeScript ones.                                                                      |
| **M15 V2 release**                    | Path A    | Trace a TypeScript page to the Go handler and tables that serve it in another repo; linking is measured on unseen public repos; V2 is tagged.                                                                                        |
| **M12 Go backends**                   | Path B    | Index Go modules with symbols, callers, duplicate warnings and descriptions.                                                                                                                                                         |
| **M11 Multirepo workspaces**          | Path B    | List related repos once; search, duplicates, the map and go-to-source span all of them, and each repo stays up to date on its own.                                                                                                   |
| **M13 Cross-repo call linking**       | Path B    | A frontend call links to the handler in another repo, and a page in one repo traces to its handler and tables in another.                                                                                                            |

- **Path A, TypeScript then the joined end (30 issues):** M9 → M10 → M8 → M14 → M15. M9 opens with two spikes (#245, #246), because agent-written recipes and generic data-access helpers are the bets the rest of V2 stands on. M10 follows, because a frontend calling an API through a client instance, a wrapper or an env-var base URL needs it next. M8 closes the remaining layout gaps: monorepos on pnpm, npm, yarn, bun, Nx and Turborepo already index.
- **Path B, Go and multirepo (13 issues):** M12 → M11 → M13. M12 goes first so the Go module is ready early for M14; M11 and M12 do not depend on each other.
- **Side work (2 issues):** M7, done by the maintainer outside both paths. It should land before Path B changes the store schema (M11's repo column, M12's `lang` field), so those changes need no migration.

### Where Path A waits on Path B

| Path A work                                                               | Needs from Path B               |
| ------------------------------------------------------------------------- | ------------------------------- |
| M14: Go endpoints and tables from recipes; Go discovery                   | Index a Go module (M12)         |
| M15: Trace a TypeScript page to the Go handler and tables in another repo | Trace a page across repos (M13) |
| M15: Call linking measured on public repos it has not seen                | Cross-repo linking (M13)        |

Touch points, not waits: M11's first issue adds a repo part to stable IDs (section 6) and M12's first adds a `lang` field; Path A rebases its snapshots onto both. M8 and M11 both touch workspace discovery. M10 and M13 both extend `clients.ts`: M10 widens what counts as a call, M13 widens where its handler can be. Recipes reach languages only through the existing adapter resolver contract (`resolveSpecifier`, `resolveSymbol`), so the recipe engine and the language interface are built without waiting on each other. Path B's linking work runs on endpoints from the shipped adapters until M9 replaces them with recipes that emit the same node kinds.

## M7 V2 groundwork (side work)

- Remove the legacy data-dir fallback (`~/.gantry/data`): the plugin data dir is the only location (section 4).
- Remove the numbered store migrations and the `meta.index_format` re-index (#195). There is one schema. A store whose schema version is not the current one is deleted and rebuilt, and the user is told (sections 9, 11).

Spec sections touched: 4, 9, 11, 14.

## M8 Any TypeScript project (Path A)

Runs after M10 (#242).

Most layouts already work: pnpm, `package.json` workspaces (npm, yarn, bun), Nx `project.json`, and single packages are detected, and the resolver already follows tsconfig with `references: "auto"`. M8 closes the remaining, verified gaps:

- A repo whose packages are tied together only by tsconfig project references.
- A repo with several `package.json` files and no workspace tool.
- Bundler aliases (Vite, webpack) that are not in tsconfig `paths`.
- A measured cold index of a public repo of about 10,000 TypeScript files in about a minute. The current figure, about 5,000 files in 11 s, is extrapolated, not run at 10,000.

Spec sections touched: 3 (workspace discovery), 5, 13.

## M9 Recipes by agent (Path A)

### The rule

No framework- or ORM-specific code. Framework and data-access knowledge lives only in a repo's recipe, which an agent writes. Gantry ships the engine, generic helpers and the agent's prompt. A stack that scores below the bar is fixed in a generic helper or in the prompt, never with code for that stack. Spec section 1 gains this rule.

### Recipes

- **Recipe, not live inference.** Spec section 1 requires deterministic output. The agent writes a recipe into the data dir; the indexer applies it with `@ast-grep/napi` on every index. Same repo and same recipe version give the same graph (confirmed in `v2-recipes`).
- **Recipes run inside the existing adapter framework.** One generic recipe adapter implements the current `Adapter` interface (`extract`/`link`) and is registered where the hand-written adapters are today. The hand-written TanStack Router, TanStack Start, Hono, oRPC and Drizzle adapters are deleted once recipes reproduce `fixtures/adapters` and `fixtures/pnpm-turbo` (#203, #206, #247). `clients.ts` stays as the shared client-call matcher (it is not framework-specific) and is extended in M10 and M13.
- **What a recipe holds.** The dependencies it has classified (what each is, or that it is neither a framework nor data access); rules that emit route, page, router, mount, endpoint, client-call and table nodes and the existing `serves`, `handles`, `requests`, `reads`, `writes` and `contains` edges (sections 7, 9). Each rule names its language. No framework versions. A collection counts as a table.
- **Validation.** Each rule carries example snippets that must and must not match; a recipe is accepted only when all examples pass. A rule that matches nothing in the repo is a warning, not a rejection (the spike's correct rules matched nothing in 3 of 4 tuning sets). The agent sees match counts and samples and may revise.
- **Unresolved sites stay visible** as low-confidence nodes with a reason.

### Generic helpers

Rules alone are not enough (spike: Hono 0 of 7 endpoints with rules only, 7 of 7 with helpers). Recipes may name these helpers, which use the language's resolver, not the syntax tree:

- **Routes and endpoints** (from `v2-recipes`): name resolution, constant strings, mount graph (routers mounted under prefixes, across files; also nested route objects and nested JSX route elements, whose child paths join their parent's), call return, argument flow, and file-system routing (TanStack Router files, Next.js `app/` and `pages/`, React Router's `flatRoutes()`, Fastify's `@fastify/autoload` directories).
- **Data access** (#247; to be settled by the `v2-data-access` spike, #246): SQL text (table names and read or write from SQL in strings, template literals, tagged templates and `.sql` files), text rules (line and pattern rules for files with no syntax tree in the index, such as Prisma schemas and SQL migrations), model naming (a recipe-stated rule from a model, entity or struct name to its table: explicit map, snake case, plural), and method classes (a recipe-stated list of which methods on a client, repository or query builder read and which write).

A table named only at runtime is a low-confidence node with a reason, never a guess.

### The agent, on the fly

- **Who runs it.** A Claude Code subagent, started in the background as the describer is. No API key. Hooks never call a model.
- **When it runs.** At init (#204), on request (#205), and on its own whenever the index records a gap (#248). Gaps are recorded deterministically at index time:
  - a manifest dependency (`package.json`, `go.mod`) the recipe has not classified;
  - a client call with no matching endpoint;
  - a candidate route site (a call on an imported object whose first argument is a path-like string) or a candidate SQL site that no rule covers;
  - a rule that matched before and matches nothing now;
  - a tool query (`gantry_trace`, `gantry_node`) that stops at an unlinked call.

  When gaps are open, the SessionStart reminder and the sync skill start the agent.
- **Every change is checked.** Examples must pass; a dry run over the whole repo shows nodes added, removed and changed; a change that removes nodes some rule still supports is rejected.
- **Every change is recorded.** Recipe versions are kept in the data dir with their diff and the gaps they closed. The next Stop or SessionStart note has one line for the change, inside its 600 characters. `gantry recipe log` lists versions and `gantry recipe revert <version>` restores one.
- **No loops.** A gap the agent decides is not a route or table is dismissed with a reason; a gap is retried at most twice; runs have a turn cap and a daily cap.
- **Discovery prompt** includes the ast-grep pattern pitfalls the spikes found, for example that a Go one-argument selector call needs the `context` plus `selector` form.

### Evaluation, not wiring

Each stack is an evaluation case: a public fixture where it helps, a held-out public repo, hand labels, and the bar of at least 90% recall at 95% precision for routes, endpoints and tables, with recipes written by the agent unaided.

| Case                                                                                                  | Issue        |
| ----------------------------------------------------------------------------------------------------- | ------------ |
| React Router: data routers, JSX `<Route>` trees, framework mode (`routes.ts`, `flatRoutes()`)         | #240         |
| Fastify: shorthand and `route()` routes, `register` prefixes across files, `fastify-plugin`, autoload | #241         |
| oRPC, TanStack Start and Drizzle reproduce today's adapters                                           | #206         |
| Express, NestJS, Next.js                                                                              | #207 to #209 |
| Prisma, TypeORM, Kysely, Sequelize, MikroORM, Mongoose, raw SQL                                       | #249         |
| The framework report on unseen repos                                                                  | #210         |

`fixtures/react-router-fastify` (a pnpm monorepo with one web app per React Router mode, a Fastify API and a Drizzle package) is the first shared fixture: a page traces to its Fastify handler and table on public code. Its calls are literal `fetch` URLs, which link at low confidence until M10.

### Spike first

| Spike                    | Question                                                                                                                                                                                                                                       | Blocks                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `v2-recipe-agent` (#245) | Does a real subagent write working recipes unaided on at least 12 held-out public repos (8 TypeScript, 4 Go)? How stable are its recipes across runs, what does a run cost, and does a gap-triggered run extend a recipe without losing nodes? | #248, all evaluation cases |
| `v2-data-access` (#246)  | Do the four data-access helpers, with the existing ones, find tables, reads and writes for Drizzle, Prisma, TypeORM, Kysely, Sequelize, MikroORM, Mongoose, raw SQL, database/sql, sqlx, sqlc, GORM and ent?                                   | #247, #249, #250           |

New dependency: pin `@ast-grep/napi` 0.51.3 exactly (section 2; approved but not yet installed). Prebuilds cover macOS arm64 and x64, Linux arm64 and x64, and Windows x64; there is none for Windows arm64.

Spec sections touched: 1 (no framework or ORM code), 2, 3, 5 (recipe file, helpers), 7 (node kinds), 9 (recipe versions, gaps), 10 (`gantry recipe`), 11 (gap detection, agent runs), 13, 14 (notes), 16 (the agent and its triggers).

## M10 Call linking in one repo (Path A)

Runs straight after M9, before M8 (#242): it is what a frontend calling an API through a client instance, a wrapper or an env-var base URL needs next.

Today `clients.ts` matches literal `fetch`/`ky`/`axios` URLs by method and path. On public full-stack repos it linked 1 of 70 linkable calls; the spike prototype linked 70 of 70 with no wrong links, but only 35% on a held-out repo before one fix, so the numbers below are targets to measure on held-out repos. Everything here works and is tested inside one repo.

- **Client instances.** `axios.create`, `ky.create` and `ky.extend` are followed through imports, with each library's own URL joining rules.
- **Wrappers.** A function whose parameter supplies the start of the path or the method is inferred as a client wrapper; a recipe can list wrappers as an override.
- **Constant URLs.** A small evaluator reads consts, enums, `as const` objects, env members, `??`, concatenation, `new URL` and both branches of a conditional.
- **Base URLs.** The recipe maps `env:<NAME>`, `url:<origin>` and `path:<prefix>` to `{ workspace, prefix? }`, where `workspace` is a package in the repo (M13 lets it name a package in another repo). The prefix is required: in the held-out repo `VITE_API_URL` ends in `/api`, and the value is not in the repo (`.env*` is excluded as sensitive). The agent proposes the entries from the code, dev-server proxies and `.env.example`, and an unmatched call is a gap that starts it (#248).
- **Matching.** A literal segment beats a parameter. Several candidates, or a parameter against a literal segment, give a low-confidence "ambiguous" node with its candidates, never a link.
- **OpenAPI is out of V2.** Endpoints come from code only.

Spec sections touched: 5, 7, 9, 15.

## M11 Multirepo workspaces (Path B)

- **One store per workspace.** A workspace file lists repos by local path (no remote URLs). Its repos share one database with a repo column, so cross-repo edges, `trace` and search need no federated query layer. A repo used alone is a workspace of one.
- **Stable IDs gain a repo part** so file and symbol IDs stay unique across repos (section 6). This lands first.
- **Heal per repo.** Each repo's HEAD, hooks and working layer update only that repo's rows.
- **Sibling packages.** A dependency on a package that a sibling repo publishes resolves to that repo's source, not `node_modules`.
- **Across repos:** search, the function index, duplicate warnings (within one language) and the project map, which groups by repo.
- **Recipes per repo.** Each repo keeps its own recipe and gaps; the agent runs per repo.
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
- **Frameworks and data access** are M14 (Path A), not part of this milestone.

Spec sections touched: 2, 3 (`lang/`), 7 (`lang` field), 8, 9, 13, 17.

## M13 Cross-repo call linking (Path B)

- **Across repos** (after M11): the existing `clients.ts` matching runs over every repo in the workspace, on endpoints from whatever produces them (the shipped adapters now, recipes after M9). The existing `trace` and views then show page → call → handler → table across repos. No new trace views.
- M10's client forms (instances, wrappers, constants, base URLs) reach across repos once both milestones land; neither waits on the other.

Spec sections touched: 9, 15.

## M14 Go frameworks and data access (Path A)

After M10, and Path B's M12. The same engine, helpers and agent as TypeScript, with Go rules through the language interface; nothing Go-framework- or Go-ORM-specific.

- **Endpoints** (#211, #212, #213): net/http 1.22 method patterns, chi, gin, echo and fiber (spike: chi 100% precision and 94% recall, gin 100% and 100% on held-out code; echo and fiber not spiked).
- **Tables** (#250): database/sql, sqlx, sqlc, GORM and ent, through the data-access helpers (SQL text covers database/sql, sqlx and sqlc's `.sql` files; model naming covers GORM and ent).
- Each has a public fixture and a held-out public repo scored against hand labels, at the M9 bar.

Spec sections touched: 13, 16.

## M15 V2 release (Path A)

- Call linking scored on held-out public full-stack repos (needs M9's recipes, M10 and M13).
- The end-to-end case on public code: a TypeScript frontend repo and a Go backend repo in one workspace; a page traces to the Go handler that serves it and the tables it reads and writes (#231).
- README, install guide and Status table describe V2. Tag the release.

## Reworked for agent recipes and any ORM (#244)

- **Goal 3 is new:** any framework and any ORM, in TypeScript and Go, with no stack-specific code. It was "framework knowledge comes from an agent" with data access limited to Drizzle.
- **Recipes on the fly.** The agent was run at init and on request only, never on sync. It now also runs on its own when the index records a gap (#248), with every change checked, recorded, shown in the next note and revertible.
- **Any ORM.** Four generic data-access helpers (#247) and evaluation cases for TypeScript ORMs (#249) and Go data access (#250). "No new data-access frameworks in V2" is dropped.
- **Per-stack issues are evaluation cases.** #206 to #209, #240 and #241 keep their fixtures and bars; a miss is fixed in the helpers or the prompt.
- **echo and fiber** are back in V2 (#212), as evaluation cases.
- **M9** is renamed "Recipes by agent" and **M14** "Go frameworks and data access".
- **Two spikes come first** (#245, #246). Until they report, everything that depends on an agent writing recipes unaided, or on the data-access helpers, is a plan, not a measured result.
- **Multirepo stays in V2** (M11, M13), so the end-to-end case still crosses repos; it now reaches Go tables.
- **Lost or at risk:** a fixed, reviewable recipe per repo (it changes on its own; the log and revert are the check); repeatability across agent runs (measured in #245); Claude usage spent on background runs (capped per day); framework evals that pass on prompt tuning rather than held-out repos (the bar is on held-out repos only).

The #242 reorder still holds: Path A is M9 → M10 → M8 → M14 → M15, React Router and Fastify are the first framework cases, and `fixtures/react-router-fastify` is the first shared fixture.

## Changes from the draft

Accepted from the simplification review:

- Cut the draft's M12 contributor experience and M13 trial; V2 is tagged when the end-to-end case passes. Their open questions (Windows for the trial, trial size, feedback destination, "who to ask") are gone. Lost: contributor feedback before the tag.
- The six shipped adapters are replaced by recipes run through the existing adapter framework, and deleted. M9's gate is reproducing `fixtures/adapters`, not only `pnpm-turbo` routes.
- The draft's M11 (cross-repo contracts) is mostly built (`clients.ts` matching, `trace`, views 7 to 11). It shrinks to the linking gaps: single-repo gaps are M10 (Path A), cross-repo linking is M13 (Path B); no new trace views.
- Framework evals: three TypeScript (Express, NestJS, Next.js) and three Go (net/http, chi, gin) instead of ten. Lost: measured recall for Fastify, echo and fiber. (Superseded: Fastify came back in #242, echo and fiber in #244.)
- OpenAPI is out of V2. Lost: spec-versus-code drift reports.
- One store per workspace instead of a store per repo with a query layer. Lost: sharing one repo's store across workspaces.
- M7 is reduced to the gaps that remain (references-only, no workspace tool, bundler aliases, one benchmark).
- No Go helper binary; no formal conformance suite until Java; Go reuses the TypeScript duplicate thresholds.
- Discovery re-runs on request only; recipes hold no framework versions. (Superseded in #244: the agent also runs on gaps.)
- Workspace files hold local paths only.

Not accepted:

- Using the index-format re-index as the upgrade path for refactors. There are no users: format changes rebuild the index, and the re-index mechanism itself is removed in M7.
- Dropping base-URL config. The URL-linking spike showed a path prefix is needed and cannot be read from the repo; discovery proposes the config instead of the user writing it.
- Cutting data access from recipes. Drizzle tables are shipped behaviour; recipes must keep them when the hand-written adapter is deleted. (Widened in #244 to any ORM.)

Changed by the spikes (none was a no-go):

- Go no longer depends on framework recipes as a whole (draft: M10 needed M8): only Go frameworks need recipes, and they are Path A's M14, after Path B's M12. Milestone numbers in the spike reports refer to the draft.
- Recipe validation uses example snippets; zero matches is a warning (draft: drop rules that match nothing).
- Rules need five generic helpers, not only a file-naming helper.
- Go needs local type inference for concrete methods; interface calls are high confidence to the interface method; `implements` is computed by name at low confidence (draft: not computed).
- Hashing split: the language supplies token streams for five hashes; normalising stays per language.
- Base-URL config needs a prefix and same-origin keys.
- Package names and versions confirmed: `@ast-grep/napi` 0.51.3, `@ast-grep/lang-go` 0.0.6, `@ast-grep/lang-java` 0.0.7 (Java parses with no Java runtime installed).

## Out of scope for V2

- Languages other than TypeScript and Go. Java is next, through the M12 language interface.
- OpenAPI, gRPC, GraphQL and message queues as link sources.
- Remote repos in a workspace file.
- Committing a recipe to the repo, for CI or teammates.
- Any legacy fallback, migration or upgrade path.

## Still unverified

- A real subagent writing recipes unaided, and keeping them current on gaps (#245).
- The data-access helpers on any ORM (#246).
- Every framework and ORM as a recipe except the five spiked (TanStack Router, Hono, Express, chi, gin); net/http patterns; Fastify autoload; echo and fiber.
- How noisy gap detection is, and what background runs cost.
- Everything in M11.
- A 10,000-file cold index (extrapolated).
- Go `vendor/` and `go.work`; Go duplicate thresholds; Go descriptions.
- Windows arm64 (no ast-grep prebuild) and Linux musl.
