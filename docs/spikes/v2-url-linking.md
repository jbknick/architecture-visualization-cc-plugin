# Spike: linking client calls to handlers when base URLs come from env vars

V2 plan, M11 (cross-repo contracts). Question: can method-and-path matching link frontend calls to backend handlers when the base URL is an env var (`fetch(`${process.env.API_URL}/users/${id}`)`, `axios.create({ baseURL: import.meta.env.VITE_API_URL })`), and what config does that need? First: what does today's `packages/core/src/adapters/clients.ts` (#47) already link?

## Setup

- Code base: `origin/main` at `5eee89d` (worktree). Versions: `oxc-parser` 0.158.0, `oxc-resolver` 11.24.2 (the workspace's own; no new dependencies, nothing installed for this spike). Node v26.13.0, macOS arm64.
- Script: `pnpm tsx docs/spikes/v2-url-linking/run.ts [--sosrs <frontend> <backend>] [--juga <repo>]`. Files: `run.ts` (cases, scoring), `proto.ts` (prototype matcher), `labels.ts` (hand labels), `fixtures/multi/` (synthetic fixture; Biome ignores `**/fixtures`). Not referenced from the root `tsconfig.json` and has no `*.test.ts`, so `tsc -b` and vitest do not see it; `pnpm biome check docs/spikes/v2-url-linking` passes.
- "Today" is the real pipeline: each case is materialised as a temp git repo and run through `indexRepo` (`layer: "main"`), then `requests` edges and `client_call` gap nodes are read from `dumpGraph`. A call counts as linked only when it gets exactly one endpoint.
- The prototype reads the same frontend files and matches against the same endpoints (the Hono `endpoint` nodes from today's graph).
- Cases (83 labelled call sites in all):
  - **A, fixture** (`fixtures/multi`, written for this spike): `apps/web` plus two backends, `apps/users-api` (Hono, routes mounted at `/api`) and `apps/billing` (Hono). 25 call sites, one or more per pattern in the table under Findings, 18 of them linkable.
  - **B, public, two separate repos**: `SOS-RS/frontend` at `9f7560cd28c879d25584547c935e073a1e66a8e3` (Vite + React, 275 TS files, axios instance with `baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000/'`) and `SOS-RS/backend` at `c48898ec056be355c0113767e6096447acac0980` (NestJS, 12 controllers, 34 endpoints). 34 call sites, 29 linkable.
  - **C, public monorepo, held out**: `boostcampwm-2024/web16-JuGa` at `4b3352b4664c754d2b5c7ec62bc3056bf8c88d4a` (`FE/` Vite + React using `fetch`, `BE/` NestJS, 13 controllers, 34 endpoints). 24 call sites, 23 linkable. I labelled it and ran it after the prototype was built on A and B.
- **No NestJS adapter exists**, so today's indexer finds 0 endpoints in B and C. To measure the matching on its own, `run.ts` reads the Nest controllers (`@Controller('x')` plus `@Get(':id')` and so on, by regex; the 34 + 34 counts match a manual grep) and writes them out as a Hono app in a second workspace. Today's adapter and the prototype then see the same endpoint set. Without that shim, today's result on B and C would be 0 links by construction.
- Labels: one person (this spike) read every request call site and wrote down the endpoint it hits, or none for external, ambiguous, wrapper-body and nonexistent targets. Request sites were found by grep for `fetch(`, `axios`, the instance name and the wrapper names. The prototype found exactly the labelled sites in B and C (58 results, 58 labels) and made no link at any unlabelled site.

## Results

| Case              | Run                                                            | Call sites | Linkable | Correct | Wrong endpoint | Link where none | Missed | Precision | Recall   |
| ----------------- | -------------------------------------------------------------- | ---------- | -------- | ------- | -------------- | --------------- | ------ | --------- | -------- |
| A fixture         | Today (`clients.ts`, real indexer)                             | 25         | 18       | 1       | 0              | 0               | 17     | 100%      | **6%**   |
| A                 | Prototype, no base config                                      | 25         | 18       | 1       | 0              | 0               | 17     | 100%      | 6%       |
| A                 | Prototype, base config, no wrapper inference                   | 25         | 18       | 15      | 0              | 0               | 3      | 100%      | 83%      |
| A                 | Prototype, full                                                | 25         | 18       | 18      | 0              | 0               | 0      | 100%      | **100%** |
| B SOS-RS          | Today                                                          | 34         | 29       | 0       | 0              | 0               | 29     | n/a       | **0%**   |
| B                 | Prototype, no base config                                      | 34         | 29       | 0       | 0              | 0               | 29     | n/a       | 0%       |
| B                 | Prototype, base config, no wrapper inference                   | 34         | 29       | 21      | 0              | 0               | 8      | 100%      | 72%      |
| B                 | Prototype, full                                                | 34         | 29       | 29      | 0              | 0               | 0      | 100%      | **100%** |
| C JuGa (held out) | Today                                                          | 24         | 23       | 0       | 0              | 0               | 23     | n/a       | **0%**   |
| C                 | Prototype, no base config                                      | 24         | 23       | 15      | 0              | 0               | 8      | 100%      | 65%      |
| C                 | Prototype, base config, no conditional branches (as first run) | 24         | 23       | 8       | 0              | 0               | 15     | 100%      | **35%**  |
| C                 | Prototype, full                                                | 24         | 23       | 23      | 0              | 0               | 0      | 100%      | 100%     |

Timings: indexing (whole pipeline) took 48 ms for A, 374 ms for B and 258 ms for C. The prototype matcher took 56 ms over B's 274 frontend files and 35 ms over C's 116.

How honest the 100% figures are:

- A and B were development data. The first prototype run marked every function with a parameter in its URL (`getOne(id)` building `/shelters/${id}`) as a wrapper, which gave A 8/18 and B 20/29. Changing the rule to "the parameter supplies the start of the path, or the method" gave 18/18 and 29/29.
- C was held out from the matcher, but I added `cond ? a : b` evaluation after reading C's code and before scoring it. The 35% row (8/23) is the true held-out number for the prototype as it was. The 100% row is after that one addition.
- Across all 83 sites and all runs there was **no wrong link and no link where none was expected**. Every miss was a missing link.

### Why today's matcher misses (per call site, from the run)

| Cause                                                                                                                                     | Sites     | Today's result                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| axios instance (`api.get(...)` where `api = axios.create(...)`), ky instance, axios config call on an instance                            | B 21, A 6 | not seen at all: only an imported `axios` / `ky` or global `fetch` is a client |
| wrapper call (`useFetch('/supporters')`, `apiFetch(path, init)`, `request(method, path)`)                                                 | B 8, A 3  | not seen                                                                       |
| URL in a const, a conditional (`PROD ? `${VITE_API_URL}/x` : '/api/x'`), a concatenation or `new URL`                                     | C 15, A 3 | `dynamic_url` gap node                                                         |
| base URL carries a path prefix (`VITE_API_URL=https://host/api`); today drops a leading `${base}` and matches `/news` against `/api/news` | C 8, A 2  | `no_endpoint` gap node                                                         |
| same path on two backends (`GET /health`)                                                                                                 | A 2       | both endpoints, `low` (ambiguous)                                              |
| relative path through the Vite dev proxy (`fetch("/api/users")`)                                                                          | A 1       | **linked**, today's only hit                                                   |

## Findings

1. **Method plus path segments with params as wildcards works** once the URL is evaluated properly. There were zero false links in 83 sites. Two rules carried it:
   - A literal segment beats a parameter (`/shelters/cities` over `/shelters/:id`, `/stocks/list/search` over `/:code`, `/users/me` over `/:id`): pick the candidate with the fewest wildcard segments.
   - Query and hash are dropped.

   A call whose parameter falls on an endpoint's literal segment is not a match. When it is the only kind of match it becomes "ambiguous" with candidates. That is the plan's "low confidence, candidates listed" case. Two such sites came up: C's `/stocks/trade-history/${id}/${viewMode}` (two candidates, `today` and `daily`, which only the union type narrows) and A's fully dynamic `${API}/${resource}/${id}`.
2. **Base URL to repo config is needed, and the plan's shape (env var name or literal prefix to repo) is not enough.** It needs a **path prefix**. In C (and in A by design), `VITE_API_URL`'s value ends in `/api`, so `${VITE_API_URL}/news` requests `/api/news`. The value is not in the repo: C tracks no `.env` file, and spec section 5 excludes `.env*` as sensitive anyway (`packages/core/src/config/index.ts:81`). The prefix has to come from config, filled in by the discovery agent or the user. In C the agent can infer it from the dev proxy (`vite.config.ts` proxies `/api` to the server) and the controllers' `/api/...` paths. The exact config used:
   - A: `{"env:VITE_API_URL": {repo: "@fx/users-api", prefix: "/api"}, "env:API_URL": {repo: "@fx/users-api", prefix: "/api"}, "env:VITE_BILLING_URL": {repo: "@fx/billing"}, "env:BILLING_URL": {repo: "@fx/billing"}, "url:http://localhost:4000": {repo: "@fx/billing"}, "path:/api": {repo: "@fx/users-api"}}`
   - B: `{"env:VITE_API_URL": {repo: "sosrs-api"}, "url:http://localhost:4000": {repo: "sosrs-api"}}`. Either entry alone suffices, because the `??` fallback literal is read too.
   - C: `{"env:VITE_API_URL": {repo: "juga-api", prefix: "/api"}, "path:/api": {repo: "juga-api"}}`

   So three key kinds are needed:
   - `env:<NAME>`, with several names per backend (A has `API_URL` and `VITE_API_URL` for one backend);
   - `url:<origin>`, for literals and `??` fallbacks;
   - `path:<prefix>`, for same-origin calls through a dev proxy or reverse proxy.

   Each maps to `{ repo, prefix? }`. The repo mapping is also what separates two backends that serve the same path. In A, `GET /health` linked to billing only through `BILLING_URL`. `${API_URL}/health` was correctly left unlinked: with the `/api` prefix it is `/api/health`, which no backend serves. That is a real frontend bug, and today's matcher would have linked it to both backends.
3. **Client instances must be tracked.** `axios.create({ baseURL })`, `ky.create({ prefixUrl })` and `ky.extend` produce instances, followed through imports and re-exports (B: `@/api` re-exports `./api`). Each instance carries its base. 21 of B's 29 linkable calls go through one. The join rules differ by API, and the prototype follows each:
   - axios and ky add the input to the base path.
   - `new URL("/x", base)` replaces the base path: in A it correctly resolves to `/orders/:id` and is not linked.
4. **Client wrapper functions: inference works, and a recipe list is only a fallback.** A function is a wrapper when one of its parameters supplies the start of the path, or the method. One that only fills a segment (`/users/${id}`) is an ordinary call with a `:param`. Each call of the wrapper then substitutes its argument (and its `init.method` or method argument) into the wrapper's URL template. Wrappers of wrappers work, because inference runs to a fixpoint. B's `useFetch` hook (8 call sites) and A's `apiFetch(path, init)` and `request(method, path)` were all inferred with no recipe. Calls inside a wrapper's body are not links; they are reported as `wrapper_body`. The M8 recipe's "client wrapper functions" field is still useful where inference cannot see the flow, for example a path passed through an object or a class field. This spike had no such case.
5. **URL evaluation needs a small constant evaluator.** Patterns that came up in the public code:
   - string literals and templates;
   - `+` concatenation;
   - local and top-level `const` (also imported);
   - TS `enum` members (B's `PaginatedQueryPath.Shelters`);
   - `as const` object members;
   - `process.env.X` and `import.meta.env.X`;
   - `a ?? b` and `a || b`;
   - `new URL(p, base)`;
   - **conditionals** (`import.meta.env.PROD ? `${VITE_API_URL}/x` : '/api/x'`, 15 of C's 23 linkable calls).

   For a conditional, evaluate both branches and link when the branches that match agree. In C the dev-proxy branch alone links 15 calls with no config at all, because it has one backend.
6. **Endpoints are the first blocker, not matching.** Both public backends are NestJS and today's indexer has no NestJS adapter, so today's recall is 0% on B and C before any matching question arises. M11 depends on M8 producing endpoints for NestJS, Express and the other frameworks, as the plan says. This spike used a decorator regex shim, which is not a recipe.
7. **Still unlinkable from syntax alone, and reported as gaps:**
   - a URL from a parameter of a function with no calls (A `fromProps`);
   - fully dynamic segments (A `${resource}/${id}`; C's `viewMode`, which needs types);
   - conditional external URLs (B `useViaCep`);
   - external origins (GitHub, viacep, a third-party CMS).

   Socket.io (`io(VITE_SOCKET_URL)` in C) is out of scope.
8. **Cross-repo needs nothing extra from the matcher.** B's frontend and backend are separate repos, combined here as two workspaces. The matcher only needs endpoints tagged with a repo, plus the base config. M9's workspace layer has to supply the endpoint set across stores.

### Limits

- Small sample: 83 call sites, 3 cases, 2 public projects, both axios or fetch with Vite env vars.
- Not covered: React Query or SWR keys, tRPC or GraphQL, generated OpenAPI clients, a Next.js server-side `fetch` with `process.env`, and class-based API clients (`this.http.get(...)`, Angular `HttpClient`).
- The labels and the fixture are mine. The prototype resolves imports with `oxc-resolver`, but it is a spike: a single scope chain, and constants evaluated through top-level declarations only.
- I did not try inferring the path prefix automatically (try each candidate prefix and keep the one under which most calls match an endpoint, as recipe validation does). It looks feasible for C but is unverified.

## Plan assumptions checked

| Assumption (V2 plan, M11 and M8)                                                                     | Status                                                                                      | Evidence                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Normalising both sides to method plus path segments with params as wildcards links calls             | **confirmed**, with two rules added: literal beats param, query dropped                     | 70/70 linkable sites linked, 0 false links (full prototype, A+B+C)                                                     |
| Base URLs map to repos through config of an env var name or literal prefix to repo                   | **refuted as stated**: a path prefix per base is also needed, and a same-origin `path:` key | C needs `prefix: "/api"`: 8 env-template calls fail without it (today's `no_endpoint` rows)                            |
| Exact matches are high confidence; several matches or a partly dynamic path are low, with candidates | **confirmed**                                                                               | C `tradeHistory` and A `fullyDynamic` come out ambiguous with candidates, never linked                                 |
| Network call sites come from M8 recipes, including "client wrapper functions"                        | **partly confirmed**: instances and wrappers are essential, and wrappers can be inferred    | B: 21/29 calls via an instance and 8/29 via a wrapper; recall 72% without wrappers, 100% with inferred wrappers        |
| Today's client-call matching (#47) is a base for M11                                                 | **confirmed as a base, insufficient as is**                                                 | 1/18, 0/29 and 0/23 linked; misses come from instances, wrappers, consts and conditionals, and the dropped base prefix |
| Endpoints come from M8 `handles` nodes                                                               | **unverified for M8, and a hard prerequisite**                                              | 0 NestJS endpoints today; the spike used a regex shim                                                                  |
| Syntax only, no type checker, is enough                                                              | **confirmed for this sample**, except union-typed path segments                             | 1 of 83 sites needed types                                                                                             |

## Verdict

**go-with-changes.** Method-and-path linking works on public code: 0 wrong links in 83 call sites. Today's `clients.ts` linked 1 of the 70 linkable calls. The changes:

1. Base config entries are `{ repo, prefix? }`, keyed by `env:<NAME>` (several per repo), `url:<origin>` and `path:<prefix>`. The discovery agent proposes them from the code, `vite.config` proxies and `.env.example`; the indexer cannot read `.env*`.
2. Track client instances (`axios.create`, `ky.create` and `ky.extend`) through imports, with each library's own URL join rules (axios and ky add to the base path; `new URL` with an absolute path replaces it).
3. Infer wrapper functions when a parameter supplies the start of the path or the method, and keep the recipe's wrapper list as an override. Report wrapper bodies as `wrapper_body`, not as calls.
4. Evaluate URLs with a constant evaluator: consts, enums, `as const` objects, env members, `??`, concatenation, `new URL`, and both branches of a conditional.
5. A literal segment beats a parameter. A parameter on a literal segment gives "ambiguous with candidates", never a link.
6. Order of work: NestJS and Express endpoints (M8) must exist before M11 can show any recall on typical backends.
