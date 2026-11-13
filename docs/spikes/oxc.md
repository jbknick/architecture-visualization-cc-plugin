# Spike: oxc import-binding graph on the test bed

Issue #3, milestone M0. Question: how fast and how complete is an `oxc-parser` + `oxc-resolver` import-binding graph on a real pnpm/Turborepo monorepo, before M1 builds the production one?

This report is public. It contains counts, generalised path shapes and public module names only. No test-bed code, file names, feature names or internal package names appear here. Raw detail (real specifiers and file paths) is written to git-ignored `evals/private/` by the script.

## Setup

- Versions (pinned exactly in `packages/core/package.json`): `oxc-parser` 0.158.0, `oxc-resolver` 11.24.2.
- Machine: Apple M3 Pro, Node v26.13.0, macOS arm64. Test bed cloned to `/tmp/devprentice`, `pnpm install --frozen-lockfile` only; nothing else written there.
- Script: `pnpm tsx docs/spikes/oxc/run.ts /tmp/devprentice` (helpers and tests in `docs/spikes/oxc/analyze.ts`, `analyze.test.ts`). Optional `--runs N` (default 3) and `--private-out <file>`.
- Files: `git ls-files '*.ts' '*.tsx' '*.mts' '*.cts'` (1,538), minus spec section 5 excludes (`*.d.ts`, `*.gen.ts`, `dist`, `node_modules`, sensitive names, and so on) = **1,529 parsed**. About 660 of these are unit, worker, e2e or other test files, so non-test source is roughly 870 files. The "about 1,086" in the issue understates the total.
- Resolver options: `conditionNames: ["import","types","default"]`, `extensions: [".ts",".tsx",".mts",".cts",".js"]`, `tsconfig: "auto"`, plus `builtinModules: true` (see Findings). Fresh `ResolverFactory` per run, so every run is cold.
- No type checker. Call sites are mapped by name only: callee root identifier, shadowed by any name declared inside the enclosing top-level function, else matched to an import binding, else to a top-level declaration of the file, else "global".

## Results

| Metric                                                                                                  | Value                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Files parsed                                                                                            | 1,529 (0 with parse errors)                                   |
| Top-level functions (function declarations and const arrow/function expressions, incl. default exports) | 5,418                                                         |
| Imports (7,477 static, 76 dynamic with literal specifier, 18 re-exports)                                | 7,571                                                         |
| Resolved to a repo file                                                                                 | 4,923                                                         |
| Resolved to node_modules                                                                                | 2,171                                                         |
| Node builtins                                                                                           | 296                                                           |
| Unresolved                                                                                              | 181                                                           |
| **% of all imports resolved**                                                                           | **97.6%**                                                     |
| Repo-internal imports (relative, alias or workspace specifiers)                                         | 4,937                                                         |
| **% of repo-internal imports resolved**                                                                 | **99.7%** (4,923 of 4,937)                                    |
| Call sites inside function bodies                                                                       | 36,405                                                        |
| Mapped to an imported binding                                                                           | 11,392 (31.3%)                                                |
| Mapped to a top-level declaration                                                                       | 7,078 (19.4%)                                                 |
| Callee root declared in local scope (parameter, inner const, nested function)                           | 12,673 (34.8%)                                                |
| Callee root is a global / unknown                                                                       | 5,262 (14.5%)                                                 |
| **% of call sites mapped to a binding (import or top-level)**                                           | **50.7%**                                                     |
| % mapped, excluding local-scope callees                                                                 | 77.8%                                                         |
| % mapped to a binding whose import also resolved                                                        | 45.3%                                                         |
| Imported-binding calls, by import target                                                                | 4,257 repo, 4,831 node_modules, 314 builtin, 1,990 unresolved |

Timings, median of 3 runs (raw end-to-end runs: 1,328 / 1,207 / 1,204 ms in one session; later sessions 1,180 to 1,238 ms):

| Phase                                                                                | ms          |
| ------------------------------------------------------------------------------------ | ----------- |
| Parse total (`parseSync` plus the AST walk that collects facts; file reads excluded) | about 1,110 |
| Resolve total (7,571 `resolveFileSync` calls)                                        | about 45    |
| End-to-end (git ls-files, read, parse, resolve, walk)                                | about 1,200 |

### Acceptance targets

- Repo-internal imports resolved >= 95%: **met, 99.7%**.
- End-to-end < 20 s: **met, about 1.2 s** (16x headroom), single-threaded, cold resolver.

### Reading the call-site number

The 50.7% headline is a ceiling set by the method, not a resolver weakness. Of the 36,405 calls:

- 34.8% call something declared inside the same function (callbacks, parameters, inner helpers, method chains on locals). Without types these can never map to a graph edge. They are not misses; they are intra-function.
- 14.5% are calls on JavaScript or platform globals (the top ones, by count: `crypto`, `JSON`, `Object`, `String`, `Promise`, `Date`, `Number`, `Array`). Correctly unmapped.
- Of the calls whose root is not locally declared, **77.8% map to an import binding or top-level declaration** and the remaining 22.2% are the globals above.

Member chains are counted by their root identifier (`ns.fn()` maps to the `ns` binding; `imp().then()` counts both calls). Method calls on values returned from an import (`db.select().from()`) therefore attribute to the imported root, which is the useful granularity for `calls` and `uses_hook` edges, but it cannot say which exported member was called. M1 should keep the member path (`ns.fn`) as edge evidence.

## Unresolved imports

181 unresolved (2.4%), 6 groups. Specifiers are redacted to their public shape.

| Count | Specifier                                           | Reason                                                                                                                              |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 165   | `cloudflare:*` (Workers runtime scheme)             | Virtual runtime-provided module. Not a file; correct to leave unresolved.                                                           |
| 7     | relative path, `.js` suffix into a generated folder | Generated i18n compiler output is untracked, so absent after a plain install.                                                       |
| 6     | workspace package subpath                           | Subpath exports of the repo's i18n package that did not resolve from a plain install (consistent with generated, untracked output). |
| 1     | relative `routeTree.gen`                            | TanStack Router generated tree; untracked, and spec section 5 excludes it anyway.                                                   |
| 1     | `hast`                                              | Types-only package (`@types/hast`); no runtime entry.                                                                               |
| 1     | `mdast`                                             | Types-only package (`@types/mdast`); no runtime entry.                                                                              |

Only 14 of the 181 are repo-internal, and all 14 trace to generated, untracked output. Zero path aliases, `?query` suffixes or asset imports failed.

### Findings and concrete fixes for M1

1. **Set `builtinModules: true`.** Without it every `node:*` import reports "Cannot find module" (296 false unresolved). With it, `result.builtin` is set and they classify as builtin.
2. **`realpath` the repo root before comparing.** The resolver returns real paths (`symlinks` on). On macOS `/tmp` is `/private/tmp`, so a naive `startsWith(root)` classified every repo file as outside the repo (0% resolved on the first run). Use `fs.realpathSync(root)`, and compare after normalising separators.
3. **Treat `<scheme>:` specifiers as virtual**, not unresolved failures: `cloudflare:*`, `virtual:*`, `bun:`, `data:`. Keep `node:` for builtins.
4. **Generated files:** add a "generated, expected missing" class for spec-section-5 excluded files (`*.gen.ts`, `routeTree.gen.ts`) and for imports into gitignored output. These should be a separate count, not resolution failures. If the user has run their codegen, the resolver already follows them.
5. **Types-only packages:** when a bare specifier fails and `node_modules/@types/<name>` exists, classify as `node_modules` (types). Fixes the `hast`/`mdast` pair.
6. **tsconfig auto-discovery works** per package (`tsconfig: "auto"` with `resolveFileSync(file, request)`); alias imports resolved with no extra configuration here. `extensionAlias` for `.js` to `.ts` was not needed on this repo, but NodeNext-style repos importing `./x.js` for `x.ts` should set `extensionAlias: { ".js": [".ts", ".tsx", ".js"] }`.
7. **Pass the importing file, not a directory,** to `resolveFileSync`; that is what makes tsconfig discovery per-package.
8. Monorepo deps resolve through pnpm symlinks straight to workspace source (they come back as repo files), so workspace-to-workspace `imports` edges need no special mapping, as long as the dependency's `exports` point at source or built output exists.

## TanStack Router file routes (for M3 pages view)

- Count: 53 `createFileRoute(...)` calls in 53 files, plus 4 files creating a root route (`createRootRoute*`). All route files are in one app's `src/routes/` folder (`apps/<name>/src/routes/`); 34 sit directly in it, 19 in subfolders below it.
- Naming (counts of route files): 22 plain single-segment names, 14 flat dotted names (`a.b` style nesting), 15 flat dotted names carrying a `$param` segment, 1 `index`, 1 directory-route `route` file, plus the `__root` file. Pathless layouts use a leading underscore (19 route paths contain a `/_segment`), `$param` paths: 15. The `-` ignore prefix is not used.
- `createFileRoute("<path>")({...})`: the string argument is the route path and is the primary key for `route:<ws>:<path>` IDs. It is a string literal in every case, so a static read suffices. The generated `routeTree.gen.ts` is untracked and spec-excluded; route identity should come from the `createFileRoute` argument, not the generated tree.
- Option keys seen in the options object: `component` (39), `head` (20), `validateSearch` (14), `beforeLoad` (12), `server` (8), `headers` (6), `loader` (6), `notFoundComponent` (6), `errorComponent` (4), `staleTime` (4), `ssr` (3), `pendingComponent` (2). `server` and `headers` indicate TanStack Start server routes (HTTP handlers on a route file): M3 should treat a route with `server` as both a page and an endpoint candidate.
- `createServerFn`: 0 uses.

## Locations for M6 (paths generalised: workspace and feature folder names replaced)

- **Hono:** 11 files import `hono`: 5 in `apps/<name>/src/`, 4 in `packages/<name>/src/`, 2 in a feature subfolder of a package. Middleware imports `hono/cookie`, `hono/cors`, `hono/http-exception`, `hono/body-limit`. Detected by the `hono` import plus `new Hono(...)`.
- **oRPC routers:** 131 files import `@orpc/server`: 60 directly under `packages/<name>/src/`, 19 under `packages/<name>/src/routers/`, 46 in feature subfolders of packages (`packages/<name>/src/<feature>/`), 6 under `apps/<name>/src/`. `@orpc/server/fetch` (6 imports) is the HTTP adapter. No file calls `implement()`; routers are built from the `os` builder chain, so detection must be by `@orpc/server` import plus a `.handler(...)` chain. Client side: `@orpc/client` (56 files), `@orpc/client/fetch` (48), `@orpc/tanstack-query` (1).
- **Drizzle:** 73 `sqliteTable(...)` definitions in 12 files, all in one package at `packages/<name>/src/schema/` (one package owns all table definitions).

## Deviations and notes

- **Path-level detail withheld from the report.** The issue asks for "paths only" for the M6 locations, but the project rules forbid committing private file paths from the test bed. Paths here are generalised (`apps/<name>/src/routes/`). Exact paths are in the git-ignored private output (`--private-out evals/private/oxc-spike.json`).
- **Top-20 unresolved specifiers.** Only 6 distinct groups exist, so the table is the full list. Internal specifiers are redacted to shape.
- **Nodes counted.** "Functions" are top-level function declarations and top-level const arrow/function expressions only (class methods and nested functions are not counted), as the issue specifies. Dynamic imports with non-literal arguments are not counted as imports.
- The script lives at `docs/spikes/oxc/` with its own `tsconfig.json` (referenced from the root solution) so that `tsc -b` type-checks it, and `vitest.config.ts` now also picks up `docs/spikes/**/*.test.ts`. `tsx` was added as a root dev dependency (approved in spec section 2).
