# Spike: agent-written ast-grep recipes vs the built-in adapters

V2 plan, M8 (framework discovery) and M10 (Go frameworks through M8). Question: can a recipe (ast-grep rules plus a short list of named helpers) reproduce the TanStack Router and Hono adapters on the fixtures, and find routes in other TypeScript and Go frameworks on public code? What can rules not express?

## Setup

- Versions: `@ast-grep/napi` 0.51.3 (with `@ast-grep/napi-darwin-arm64` 0.51.3), `@ast-grep/lang-go` 0.0.6 (ships a prebuilt `parser.so` for macOS arm64; its `postinstall` was blocked by npm's script policy and was not needed). Installed with `npm install --no-audit --no-fund` inside `docs/spikes/v2-recipes/` (own `package.json`, exact versions); not part of the pnpm workspace, root and package manifests untouched.
- Machine: Apple M3 Pro, macOS arm64, Node v26.13.0, pnpm 10.31.0. Code base: `origin/main` at `5eee89d`.
- Public repos, cloned to `/private/tmp/claude-501/gantry-spikes/` (`--depth 1`):
  - `gothinkster/node-express-realworld-example-app` at `30b68e1e881462b2f4164ea09ab4c4f5699c7b0b` (Express, TypeScript, 31 source files).
  - `go-chi/chi` at `c64ed7d6635f33a8b2feaff7dcfa55677023ac7d` (`_examples/` and `middleware/`, 23 files that import chi).
  - `gin-gonic/examples` at `2661f002ee5de912f23b03ec293c8ab741170d5e` (44 files that import gin).
- Script: `pnpm tsx docs/spikes/v2-recipes/run.ts [--scratch <dir>]` from the repo root. It writes `results.json`; run `pnpm fmt` afterwards so Biome accepts it.
  - `engine.ts`: the recipe runner. `recipes/*.json`: five recipes (TanStack Router 3 rules, Hono 7, Express 5, chi 8, gin 3). `labels/*.json`: hand labels. `reference.ts`: indexes a fixture with the real indexer (`indexRepo` + `dumpGraph`) and returns the adapter nodes and edges to diff against.
- Recipe format (JSON). Each rule names a `language`, optional `files` globs, an ast-grep `rule` and `constraints` (passed to `findAll` unchanged), and an `emit`: `router` (a constructor, optional `base` path), `mount` (`parent`, `prefix`, `child`, optional `childIsScope` for `r.Route("/x", func(r) {...})`), `endpoint` (`receiver`, `method`, `path`, `handler`, optional `pathFromChain`), `middleware`, or `route` (`id`, `options`). Captures are metavariable names. A recipe also lists `when` (package dependency or file import), `passthrough` (chain methods that return the same router, such as `With` or `.get().post()`) and the `helpers` it uses.
- Each recipe was run twice: with its helpers, and rules only (`helpers: []`, so a path is the literal of its own call). Timings are the median of 3 runs. Determinism means the three outputs were byte-identical.
- I wrote the recipes, acting as the agent would. No Claude Code subagent was run, so whether an agent writes these unaided is **unverified**. I tuned the recipes on the scored examples. The held-out sets below were labelled afterwards and the recipes were not changed for them, except for the one revision described under the chi held-out results.

## Results

### Fixtures vs the adapters (reference: the real indexer on the same fixture)

| Scenario                                     | Recipe with helpers                                                          | Rules only                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| TanStack routes, `pnpm-turbo` (4 routes)     | ids, URL paths, `serves` and `contains` edges: 4/4, 4/4, 4/4, 3/3, no extras | ids 4/4; URL path 3/4 (root reads `__root__`); `serves` 0/4; `contains` 0/3                    |
| TanStack routes, `adapters` (4 routes)       | 4/4, 4/4, 4/4, 3/3, no extras                                                | same as above: 4/4, 3/4, 0/4, 0/3                                                              |
| Hono, `pnpm-turbo` (2 endpoints)             | endpoints 2/2, `handles` 2/2                                                 | 2/2, 2/2 (no mounts in this app)                                                               |
| Hono, `adapters` (7 endpoints, 3 middleware) | endpoints 7/7, `handles` 7/7, middleware ids 3/3, no extras                  | endpoints **0/7** (6 found, all with wrong prefix or workspace), `handles` 0/7, middleware 3/3 |

The Hono rules-only run loses the `/api` and `/api/users` mounts across files, the `.basePath("/v1")` and the imported `HEALTH_PATH` constant, and it names the sub-app's own package as the workspace instead of the app that serves it. The `legacy` package (imports `hono` without declaring it) is correctly skipped by `when.dependency`. Not reproduced: Hono middleware `serves` edges (middleware nodes match; the pattern matching over endpoint paths was not written), oRPC, Drizzle and TanStack Start (not in scope).

### Other frameworks vs hand labels (method + full path)

| Set                                                         | Labels | Recipe with helpers: P / R                                        | Rules only: P / R                  |
| ----------------------------------------------------------- | -----: | ----------------------------------------------------------------- | ---------------------------------- |
| Express realworld (tuning)                                  |     20 | 100% / 100%                                                       | 5% / 5% (every `/api` prefix lost) |
| chi `_examples/rest`, `versions`, `todos-resource` (tuning) |     33 | 100% / 100%                                                       | 25% / 12%                          |
| gin `group-routes`, `versioning` (tuning)                   |      9 | 100% / 100% (first draft: 0 found, see Findings 1)                | 0% / 0%                            |
| **chi held-out** (all other chi registrations in the repo)  |     35 | **100% / 94%** after one revision; first draft 100% / 43% (15/35) | not run                            |
| **gin held-out** (all other literal-path gin registrations) |     63 | **100% / 100%**, no recipe change                                 | not run                            |

The tuning sets cover chi `Route`/`Mount` nesting (including one sub-router mounted under three versions: 3 x 2 endpoints), `r.With(mw).Get`, `T{}.Routes()` mounts, gin `Group` variables, groups of groups and groups passed as function arguments (`addUserRoutes(v1)`). The two chi held-out misses are `fileserver`, where the path is a function parameter that is changed at runtime (`path += "*"`). They are reported as `unresolved` with a reason rather than guessed, as the plan requires.

### Timing and determinism

| Run                           |    Files |            ms (median of 3) |
| ----------------------------- | -------: | --------------------------: |
| TanStack or Hono on a fixture | 15 to 30 |                  1.1 to 5.4 |
| Express realworld             |       31 |                        30.7 |
| chi, whole repo               |       23 | 33.7 (tree-sitter parse 10) |
| gin examples, whole repo      |       44 |              26.3 (parse 6) |

That is roughly 0.6 to 1.5 ms per qualifying file, single-threaded, including a second parse of each file by tree-sitter. All 22 checked runs (each 3 times) were deterministic.

### Rule match counts (the plan's validation step)

Rules that legitimately matched nothing on a repo where the recipe still worked:

- Hono on `pnpm-turbo`: 5 of 7 rules (`base-path`, `route-chained-no-path`, `route-on`, `mount`, `middleware`).
- chi on `_examples/rest`: 4 of 8 (`group-scope`, `route-method`, `route-method-func`, `handle-any`).
- TanStack: `root-route-with-context` on every fixture.

Rules that were broken and matched nothing:

- The gin draft's `group` rule.
- The chi draft's `group-scope` rule.

## Findings

1. **Go patterns fail silently in two common shapes.** With `@ast-grep/lang-go` 0.0.6:
   - `$P.Group($F)` (a selector call with one argument) matches nothing, even with a literal receiver (`r.Group($F)`). Probably tree-sitter-go reads the pattern as a type conversion.
   - `$P.Group($X, $$$MW)` does not match when `$$$MW` is empty.

   Both cost a full miss on the first draft: gin 0/9, and the chi `Group` endpoints missing. Fixes are `{ "pattern": { "context": "func _() { $P.Group($F) }", "selector": "call_expression" } }` and an `any` of the one- and many-argument forms. The TypeScript patterns written the same way (`$APP.$M($H)`) worked. The same quirk hides the single-argument `r.Header.Get(h)`, which makes precision look better than the rule deserves.
2. **"Every rule matches at least one site" is the wrong acceptance test.** It cannot tell a rule for a construct this repo doesn't use yet from a broken pattern (see the match counts above). Dropping zero-match rules would delete valid rules. Because the plan re-runs discovery only when framework dependencies change, a later `.on()` or `r.Group()` would then be silently missed. Each rule should instead carry agent-written example snippets that must match, and snippets that must not, checked when the recipe is accepted (like ast-grep's own rule tests). Zero matches in the repo is a warning, shown to the agent, not a reason to drop the rule.
3. **Per-site rules are easy; full paths are not.** Rules alone found every registration site in every set, but full paths came out right only where there was no prefix:
   - Hono `adapters` 0/7.
   - Express 1/20.
   - chi 4/33.
   - gin 0/9.

   Prefix composition, mount following and receiver checking account for nearly all of the value. None of them can be expressed in ast-grep rules, which match one file and one tree at a time.
4. **What needed a helper.** Each helper below is generic: no framework names inside, and shared by all five recipes and both languages, except where noted.
   - `resolve-names`: identifier to declaration. It covers block scopes, function parameters, TS imports and re-exports through workspace packages (`@demo/posts` to `src/index.ts` to `export { posts } from "./routes"`), TS default exports, and Go package scope across a directory's files.
   - `const-strings`: a path that is an identifier reads its `const`, including an imported one (`HEALTH_PATH`).
   - `mount-graph`: routers, mounts and base paths are composed into every full path (one sub-router mounted three times gives three paths). A registration counts only if its receiver resolves to a router the recipe declared, which is the "receiver must be a Hono app" check, in generic form. The workspace is the one of the top router in the chain.
   - `call-return`: a mounted `articleRouter()`, `createApp()` or Go `usersResource{}.Routes()` is the router that function or method returns.
   - `param-flow`: a router passed as an argument flows into the callee's parameter (gin `addUserRoutes(v1)`, chi `FileServer(r, ...)`).
   - Recipe options rather than helpers: `passthrough` chain methods (`r.With(mw).Get`, `new Hono().basePath(..).get(..).post(..)`), `pathFromChain` (Hono's `.post(h)` reusing the previous path), and `childIsScope` (chi `Route`/`Group` closures).
   - `tanstack-file-routes`, the one framework-specific helper. It wraps the existing `mapRouteFile`, `urlPathOfRouteId` and `parentRouteId` from `core/src/adapters/tanstack-routes.ts`: file name to route id, URL path rules (pathless `_x`, groups, trailing `_`, `[x]` escapes, `-` ignores, `.lazy`), and the parent route. `routesDirectory` from `tsr.config.json` or the Vite plugin option was not exercised; the fixtures use the default, and the recipe used a `**/src/routes/**` glob. A real recipe needs `routesDirectoryFor` as part of the helper.
   - Reading a component or handler name from an options object (`{ component: X }`) and mapping it to a `sym:` id was done in engine code. A recipe-level `prop` capture would make it declarative.
5. **Those helpers are the language module's job anyway.** Name resolution and imports are the plan's "import resolution" and "call edges" rows of the M10 language interface. The recipe engine should take them from the language module rather than re-implementing them on the tree-sitter tree, as this spike did. For TypeScript that means the oxc-based resolver and symbol table the indexer already has. The tree-sitter TS tree here is a second parse of every file, used only for rule matching.
6. **Determinism holds** (22 of 22 checked runs byte-identical), so the M8 claim "same repo and same recipe give the same graph" is achievable with this design.
7. **Cost.** About 1 ms per qualifying file single-threaded, with the `when` prefilter limiting runs to files of packages that use the framework. That is affordable next to the M7 target (10,000 files in about a minute), but it is a second parse of TypeScript files: oxc for symbols, tree-sitter for recipes.
8. **Not measured.**
   - An actual subagent writing these recipes from scratch.
   - Next.js app router (file-system routes, which would be another file-naming helper like TanStack's).
   - Fastify and NestJS. NestJS decorators would add the class prefix from `@Controller('x')`, which needs a "decorator on enclosing class" step the engine lacks.
   - echo, fiber and net/http 1.22 patterns.
   - A held-out TypeScript repo. The Express result is on its tuning repo only.

## Plan assumptions checked

| Assumption (V2 plan, M8 and M10)                                                                                                                             | Verdict                  | Evidence                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The TanStack Router adapter can be re-expressed as a recipe that reproduces its routes on `fixtures/pnpm-turbo`, with file-naming logic as a built-in helper | Confirmed                | 4/4 routes, URL paths, `serves` and `contains` on both fixtures, using the existing `mapRouteFile`/`urlPathOfRouteId`/`parentRouteId` as the named helper                                |
| "File-naming logic that rules cannot express stays as a built-in helper": file naming is the only thing that needs one                                       | Refuted                  | Rules alone get 0/4 `serves` and 0/3 `contains` on the fixtures. Hono endpoints also need name resolution, imports, const strings and mount composition: 0/7 without them, 7/7 with them |
| A recipe "emits `adapter_nodes` and `serves`/`handles`/`requests` edges" from rules                                                                          | Confirmed with changes   | Nodes and `handles`/`serves` edges are reproduced, but only through the five generic helpers. The recipe format needs router, mount and endpoint emits, not just per-rule node output    |
| Validation: "every rule parses and matches at least one site", otherwise it is dropped                                                                       | Refuted                  | Valid rules matched 0 sites in 3 of 4 tuning sets; broken rules also matched 0                                                                                                           |
| "Framework discovery for Gin ... is then a recipe, not code"                                                                                                 | Confirmed with changes   | chi 33/33 and gin 9/9 on tuning, held-out chi 33/35 and gin 63/63, but with the same generic helpers plus Go name resolution and `param-flow`                                            |
| Deterministic output (spec section 1) under recipes                                                                                                          | Confirmed                | 22/22 checked runs identical (3 repetitions each)                                                                                                                                        |
| `@ast-grep/napi` (spec section 2) runs Go through a grammar package                                                                                          | Confirmed                | `@ast-grep/lang-go` 0.0.6 loaded with `registerDynamicLanguage` on napi 0.51.3; prebuilt parser, no build step                                                                           |
| Dynamic URLs stay visible with a reason                                                                                                                      | Confirmed (for handlers) | The two chi `fileserver` routes are listed as `unresolved: path is not a literal or const string`                                                                                        |

## Verdict

**Go-with-changes.** Recipes reproduce both adapters on the fixtures and score 94 to 100% recall at 100% precision on public chi and gin code, deterministically, at about 1 ms per file. The changes:

1. Add the five generic helpers listed above, built on the language module's resolver rather than on the tree-sitter tree. Add router, mount and endpoint emit kinds to the recipe format.
2. Keep framework helpers for file-system routing (TanStack now, Next.js later) and give the TanStack one `routesDirectory` support.
3. Replace "match at least one site" with per-rule example snippets that must and must not match, and treat zero repo matches as a warning.
4. Ship a short pattern-pitfall guide in the discovery agent's prompt: Go one-argument selector calls need `context` + `selector`, and an empty `$$$` after a comma does not match.
5. Score on held-out repos, not on the ones the recipe was written from.
