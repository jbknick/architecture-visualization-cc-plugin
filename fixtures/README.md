# Fixtures

Synthetic, hand-written repos used by indexing tests. They are data, not part of the build: Biome and tsc ignore `fixtures/**`. No `node_modules`; imports of `hono`, `@orpc/server`, `drizzle-orm` and other third-party packages are intentionally unresolved. `materializeFixture` (in `packages/core/test/helpers/fixture.ts`) copies a fixture to a temp dir and makes it a git repo.

## single-pkg
One package, ~15 files.
- `tsconfig.json` `paths: { "@/*": ["src/*"] }`: path alias resolution (`src/greet.ts`, `src/main.ts`).
- `src/greet.ts`: default-exported function.
- `src/counter.ts`: class with methods and a getter.
- `src/index.ts`: barrel re-exports.
- `.env` (fake key) and `src/secrets.ts`: sensitive files, excluded by name (`secrets*`, `.env*`).
- `src/gen/api.gen.ts`: generated file, excluded.

## pnpm-turbo
Workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`) plus `turbo.json`.
- `apps/web`: TanStack Router file routes in `src/routes/` (`__root.tsx`, `index.tsx`, `posts.$postId.tsx`, `settings/profile.tsx`) using `createFileRoute`; `routeTree.gen.ts` (generated, excluded); components; `useDebounce` hook. Depends on `@acme/ui` and `@acme/utils`.
- Undeclared import: `apps/web/src/routes/posts.$postId.tsx` imports `@acme/db`, which is not in `apps/web/package.json`.
- `apps/api`: Hono routes `GET /posts/:id` and `POST /posts` (`src/app.ts`); oRPC router with `posts.list` and `posts.create` (`src/router.ts`). Depends on `@acme/db`.
- `packages/db`: Drizzle `sqliteTable('posts')` and `sqliteTable('users')`; queries doing `select().from(posts)` and `insert(posts)`.
- `packages/ui`: `Button`, `Card`; `exports` map exposes only `.` and `./button` (`src/internal.ts` is not reachable).
- `packages/utils`: `formatRelativeDate` and `parseTimestamp` (misleading-name near-duplicate, 8 statements each); internal non-exported `slugify` (`src/slug.ts`) and an exact copy in `apps/web/src/lib/slug.ts`.
- `.claude/worktrees/feature-x/`: nested worktree folder with a copy of one file, excluded.

## adapters
Workspace (`apps/*`, `packages/*`) for the framework adapters (#45).
- `apps/server` (`hono`): `createApp()` builds an app with `use("*", cors())`, `use("/api/*", ...)`, `get(HEALTH_PATH)` (a constant imported from `src/paths.ts`) and mounts `posts` (from `@demo/posts`) at `/api` and `users` at `/api/users`. `src/users.ts`: `new Hono().basePath("/v1").get("/", listUsers).post(createUser)`.
- `packages/posts` (`hono`): `GET /posts/:id` (named handler imported from `src/handlers.ts`), `POST /posts`, `on(["PUT", "PATCH"], "/posts/:id")`. `src/routes.test.ts` is a test harness app (skipped).
- `apps/web` (`@tanstack/react-start`, `@tanstack/react-router`): server functions `fetchPost` (GET, `inputValidator`, inline handler) and `savePost` (POST, `middleware([requireUser])`, named handler) in `src/server/posts.ts`; route `/posts/$postId` calls `fetchPost` in its `loader`; route `/` defines `countPosts` and calls it from its `beforeLoad` function.
- `packages/legacy`: uses `new Hono()` and `createServerFn` without depending on either, so no adapter reads it.

## tsconfig-extends-workspace
Workspace (`apps/*`, `packages/*`), no `node_modules`, for a tsconfig that extends a config a workspace package provides.
- `packages/config-typescript` (`@acme/config-typescript`): `exports` expose `./base.json` and `./nextjs.json`. `base.json` has `baseUrl: "."` and `paths` `~shared/*` pointing at `packages/shared/src/*`; `nextjs.json` extends `./base.json`.
- `apps/web/tsconfig.json` extends `@acme/config-typescript/nextjs.json` and sets its own `paths` `@/*`, which replace the base's. `apps/web/src/app/page.ts` imports `@/lib/format`.
- `apps/admin/tsconfig.json` extends the same file and sets no `paths`, so it inherits `~shared/*`. `apps/admin/src/main.ts` imports `~shared/date`.
- Both imports resolve with no `node_modules`, so `init` reports 0 unresolved.

## nx
- `nx.json`, two projects with `project.json`: `apps/shop` and `libs/cart`.
- `tsconfig.base.json` path alias `@shop/cart`.

## react-router-fastify
Workspace (`apps/*`, `packages/*`) with three React Router apps, one per declaration mode, a Fastify API and a Drizzle package. Used by the `react-router-fastify` dump snapshot and the hashing tests. Every route path is unique across the apps (each app owns its own URL space).
- `apps/web-data` (`react`, `react-router`): data mode. `src/router.tsx` has one `createBrowserRouter` with route objects using `path`, `index: true`, `element`, `Component`, three levels of `children`, a pathless layout route and `lazy: () => import("./routes/settings")`; the root route is `/app`. `src/memory.tsx` has a `createMemoryRouter` with `/preview` and `/preview/:postId`.
- `apps/web-declarative` (`react`, `react-router`): declarative mode. `src/App.tsx` has `<BrowserRouter><Routes>` with nested `<Route>` elements under `docs`, a pathless `<Route element={<Layout />}>`, an `index` route and `posts/*`, whose component `src/pages/PostsSection.tsx` holds a nested `<Routes>` (`/docs/posts`, `/docs/posts/:postId`, `/docs/posts/new`).
- `apps/web-framework` (`react-router`, `@react-router/dev`, `@react-router/fs-routes`): framework mode. `app/routes.ts` exports a `RouteConfig` with `route()`, `layout()`, `prefix()` and `index()`, plus `...(await flatRoutes({ rootDirectory: "routes/flat" }))` over `app/routes/flat/` (`_index.tsx`, `articles.tsx`, `articles._index.tsx`, `articles.$articleId.tsx`, `articles_.new.tsx`, `_auth.tsx`, `_auth.login.tsx`, `($lang).about.tsx`, `files.$.tsx`).
- Every web app has pages that call the API with a literal or template-literal URL (`fetch("/api/posts")`, `` fetch(`/api/posts/${id}`) ``, `fetch("/api/users", { method: "POST" })`); no URL is built by concatenation.
- `apps/api` (`fastify`, `fastify-plugin`, `@fastify/autoload`, `@acme-rrf/db`): `src/server.ts` registers `src/plugins/db.ts` (wrapped in `fastify-plugin`), `postsRoutes` with `{ prefix: "/api/posts" }`, which registers `commentsRoutes` from another file with `{ prefix: "/:postId/comments" }`; shorthand `get`, `post`, `put`, `delete` (one `post` with an options object before the handler); `app.route({ method: ["GET", "HEAD"], url: "/api/stats", handler })`; `app.get(VERSION_PATH, ...)` with the path imported from `src/paths.ts`; handlers imported from `src/controllers/*.ts`; and `app.register(autoload, { dir: join(__dirname, "autoroutes"), options: { prefix: "/api" } })` over `src/autoroutes/users/index.ts` (the directory adds `/users`) and `src/autoroutes/health.ts`. 14 endpoints with a static path.
- Runtime path: `registerFeature(app, name)` in `src/server.ts` registers `` app.get(`/api/features/${name}`, ...) ``, a path built from a function parameter, so it cannot be known statically.
- `packages/db` (`@acme-rrf/db`, `drizzle-orm`): `pgTable("posts")`, `pgTable("users")`, `pgTable("comments")`; `src/queries/*.ts` do `select().from`, `insert`, `update`, `delete` and one `innerJoin` (comments with users). Controllers call them, so a page reaches a table through an endpoint (for example `PostList` to `GET /api/posts` to `posts`).

## go-basic
Two Go modules, no TypeScript (`go.work` uses `.` and `./tools`). Used by the `go-basic` dump snapshot, the Go parser tests and the Go call-edge tests.
- `go.mod` (`example.com/gobasic`) with `cmd/server` (`package main`, so the workspace is an app), `internal/store` (struct `Store` with `Get` and `Put`, constructor `New`, interface `Reader`, a `_test.go` file; also `Mirror`, a second `Reader`, `Cache`, which embeds `Store`, `Warm`, `Lookup`, a call through `Reader`, and `Dump`, a call in a `range` over `[]*Store`), `internal/app` (`App.Run` calls `a.deps.Store.Put` through a field chain and `text.Slugify` by its plain import name; `cmd/server` calls it as `str.Slugify` through an aliased import), `internal/text` (`Slugify`, `trimDashes`, a `const` block with two names on one line, a `var`, a type alias, a method, two `init` functions in `init.go`).
- `internal/net/listen.go` and `listen_unix.go` (`//go:build unix`) both declare `listen`: two ids, one per file.
- `internal/gen/zz_generated.go`: generated header, indexed with the `generated` directive.
- `vendor/example.com/dep/dep.go`: skipped.
- `tools/go.mod` (`example.com/gobasic/tools`, requires the first module): a second workspace and a `depends_on` edge.

## java-basic
A two-module Maven project, no TypeScript (`pom.xml` at the root lists `core` and `app`). Used by the `java-basic` dump snapshot, the Java parser tests and the Java call-edge tests (`packages/core/src/lang/packs/java.*.test.ts`).
- `pom.xml` (`java-basic`): the parent. `core/pom.xml` (`core`) and `app/pom.xml` (`app`, which depends on `core`: a `depends_on` edge on `app/pom.xml`). `app` holds `Main.main`, so it is an app.
- `core` (`com.acme.core`): the interface `Greeter`; `PoliteGreeter` implements it and `LoudGreeter` extends `PoliteGreeter` (`extends` and `implements` edges from the declarations, `super.greet` and a call through the type name `Strings.shout`); `Strings` with a static `shout`; `Formatter` with two overloads of `format` (one and two parameters) and two of `pad` (`String` and `int`, both with one parameter). `src/test/` holds `StringsTest`, a test file.
- `app` (`com.acme.app`): `App` has a field typed by the interface `Greeter`, a `Formatter` field, a static import of `Strings.shout`, a private `log`, an inner class `Inner` that calls `log`, and a static nested class `Counter`; `Main` uses an on-demand import (`com.acme.core.*`) and a constructor call; `model/Person.java` is a record; `generated/Version.java` is a generated file by its path.
- The four call cases the snapshot shows, all level 2: an interface call (`App.run` to `Greeter.greet`, `high`); an overload (`Formatter.format` to `pad`, both overloads, `low` each, because both take one argument, while `format(text, 1)` and `formatter.format(hello)` pick their overload by the number of arguments, `high`); a static import (`App.run` to `Strings.shout`, `high`); an inner class (`App.Inner.ping` to the `App.log` of the class around it, `high`).
- `core/target/classes/.../Stale.java`: build output, skipped.

## python-basic
A `src/` layout package with a `pyproject.toml`, no TypeScript. Used by the `python-basic` dump snapshot, the Python parser tests and the Python call-edge tests (`packages/core/src/lang/packs/python.*.test.ts`).
- `pyproject.toml` (`python-basic`, depending on the external `requests`): one workspace. `src/acme/cli.py` holds the `if __name__ == "__main__":` guard, so it is an app.
- `src/acme`: `models.py` (`User`; `Admin(User)`), `store.py` (`Store` with `save` and `count`), `base.py` (`Base.audit`), `util.py` (`slug` calls the `clean` of its own file), `service.py` (`Service(Base)`; its `__init__` assigns `self.store = Store()`), `cli.py`, `proto_pb2.py` (a generated file by its path) and `__init__.py`. `tests/test_service.py` is a test file; `build/stale.py` and `.venv/lib/site.py` are skipped.
- The five call cases the snapshot shows: an annotated call (`cli.report` to `Store.count` and `Admin.revoke`, level 2, `high`); a constructor-flow call (`cli.main` assigns `service = Service()` and calls `service.run(...)`: level 3, `low`); a `self` attribute call (`Service.run` to `Store.save` through `self.store`, `Service.touch` to `Store.count`, and `self.touch()` and `self.audit()`, which the base class declares: level 3, `low`); a relative import (`from . import util`: `Service.run` to `util.slug`; `from .util import slug`: `cli.main` to `slug`; level 2, `high`); and an untyped parameter (`cli.describe` calls `thing.name()`), which has no edge. A call to a function of the same file (`slug` to `clean`) is level 2, `high`.

## csharp-basic
Two C# projects, no TypeScript, no .NET SDK needed. Used by the `csharp-basic` dump snapshot, the C# parser tests and the C# call-edge tests (`packages/core/src/lang/packs/csharp.*.test.ts`).
- `src/Core/Acme.Core.csproj`: named by its file name, `Acme.Core`. `src/App/App.csproj` (`<AssemblyName>Acme.App</AssemblyName>`, a `<ProjectReference>` to `Acme.Core.csproj`: a `depends_on` edge on `App.csproj`). `Program.Main` makes `Acme.App` an app.
- `src/Core` (`namespace Acme.Core;`): the interface `IGreeter`; `PoliteGreeter` implements it; `Strings.Shout`; `StringExtensions.Twice`, an extension method of `string`; `Report`, a partial class in two files (`Report.cs` holds the constructor and `Render`, `Report.Totals.cs` holds `Header`); `Schema.Designer.cs`, a generated file by its path; `obj/Debug/Stale.cs`, build output, skipped.
- `src/App` (`namespace Acme.App;`): `Program` has `using Acme.Core;` and `using static Acme.Core.Strings;`; `ProgramTests.cs` is a test file.
- The four call cases the snapshot shows, all level 2, `high`: an interface call (`Program.Run` to `IGreeter.Greet`, and no edge to `PoliteGreeter.Greet`); an extension method call (`Program.Run` to `StringExtensions.Twice`, on a `string` variable); a partial class call (`Report.Render` in `Report.cs` to `Report.Header` in `Report.Totals.cs`); a static using call (`Program.Run` to `Strings.Shout`). Also the constructor call `Program.Run` to `Report.Report`, a call on a local typed by `new`, a call through a field typed by the interface, and an `implements` edge from `PoliteGreeter` to `IGreeter`. `new PoliteGreeter()` makes no edge: the class declares no constructor.

## go-recipes
Four small Go modules (#368), each a repo of its own with a committed `.gantry/recipe.json` of Go rules. Used by `packages/core/src/recipe/go-recipes.test.ts`, which asserts the exact endpoints (method, full path, handler), tables, reads and writes of each and that `recipe check --nodes` lists the nodes the index stores.
- `nethttp`: a `ServeMux` app. Patterns with a method (`"GET /health"`) and without (`"/"`, which is `ALL`); a host pattern (`shop.example.com/`) that the rule's constraint leaves out; `registerUsers(mux)` called from `main`; a method value (`h.get`) and an inline handler; `registerLegacy`, which no call names; the rules set `uncalled`, so its route keeps the path it writes.
- `chi`: `chi.NewRouter()`, `Use`, `Mount("/api", apiRouter())` (a function that returns a router), `Mount("/users", users.Routes())` (a method that returns one), `Route` inside `Route`, `Group` with its own middleware, and `Handle` (method `ALL`).
- `gin`: `gin.Default()`, `Group` chains (`r.Group("/api")`, then `v1.Group("/users")` passed to `users.Register` in another package, whose parameter is the router), an inline handler.
- `sql`: raw SQL through `database/sql` (a string, a raw string over several lines, a `+` chain with a constant, a table named by a parameter, which is a run-time table); `db/migrations/*.up.sql` declares `users` and `posts`; a mapper-like `Orm` type whose `Define`, `Create` and `Find` the recipe classes as table, write and read; `db/queries/posts.sql` with `-- name:` blocks whose generated functions are in `db/gen/posts.sql.go`.

## overlay-groups
One package, `@demo/shop`, for the group boundary warnings (#289).
- `src/orders/invoice.ts` (`totalDue`), `src/catalog/price.ts` (`formatPrice`) and `src/catalog/cart.ts` (`cartTotal`, which imports and calls `totalDue`).
- `groups.json` is test data, not read by Gantry: group `orders` (`src/orders/**`, `mayUse: []`) and group `catalog` (`src/catalog/**`, `mayUse: ["orders"]`). `cart.ts` uses orders, which catalog lists, so it is not a crossing.
- `invoice.edited.txt` is the edit the tests apply to `src/orders/invoice.ts`: it imports and calls `formatPrice`, which Orders does not list.

## deep-radius
Since #294 the 610 users of `hub` are one hub entry (`hubs` of the `base` change, `consumersTotal` 610, 305 per app workspace) and not rows of `reachable`; `reachableTotal` still counts them.
Workspace (`apps/*`, `packages/*`) for the reachable tier of the blast radius (#293), with a feature overlay in `fixtures/deep-radius.feature/` (files copied over the tree on branch `feature`). `fixtures/deep-radius.review.json` is `gantry review main...feature --json` on it, indexed at `main`, in a directory named `repo`. Build the repo with `pnpm exec tsx scripts/fixture-repo.ts deep-radius <dest>`.
- Workspaces: `packages/core` (`@deep/core`, a package), `apps/web` and `apps/api` (apps).
- The feature branch changes the body of `packages/core/src/base.ts#base` and nothing else. Every edge in the chain below is `high` except `Runner.alphaLow` to `Runner.helper` (a `this.helper()` call), which is `low`.

| hop | node | how it uses the node one hop nearer |
| --- | --- | --- |
| 0 | `packages/core/src/base.ts#base` (exported) | |
| 1 | `packages/core/src/step1.ts#step1` | calls `base` |
| 2 | `packages/core/src/step2.ts#step2` | calls `step1` |
| 3 | `packages/core/src/step3.ts#step3`, `packages/core/src/hub.ts#hub` | each calls `step2` |
| 4 | `packages/core/src/step4.ts#step4`, `packages/core/src/runner.ts#Runner.helper`, and 610 one-line functions in `apps/web/src/hubUsers.ts` and `apps/api/src/hubUsers.ts` (608, the spike's hub threshold, plus 2) | `step4` and `Runner.helper` call `step3`; each user calls `hub` |
| 5 | `packages/core/src/zeta.ts#zetaHigh` (imports and calls `step4`), `packages/core/src/runner.ts#Runner.alphaLow` (calls `this.helper()`) | |
| 6 | `apps/web/src/routes/page.tsx#Page` (a component) | calls `zetaHigh` |

## multirepo
Two separate repos under one directory, for the multirepo workspace (#214); the multirepo issues that follow reuse it. Unlike the other fixtures it is not one repo: `gantry-workspace.json` is `{ "repos": [{ "path": "./web" }, { "path": "./api", "repo": "acme/api" }] }`, and `web/` and `api/` each become their own git repo (`materializeMultirepo()` in `packages/core/test/helpers/fixture.ts`; the directory that holds the file is not a repo).
- `web/` (repo name `web`; package `mr-web`, depending on `@mr/contracts` ^1.0.0 and `react`): `src/pages/posts.tsx` (a component that calls `fetch("/api/posts")` and renders with `formatDate` from `@mr/contracts`), `src/lib/slug.ts` (`makeSlug`, six statements, a near-copy of the api repo's `toSlug`), `src/lib/only-in-web.ts` (`debounceInput`).
- `api/` (repo name `acme/api`; a pnpm workspace: `pnpm-workspace.yaml` with `apps/*` and `packages/*`, and a private root package): `apps/server` (`mr-server`, depending on `hono` and `@mr/contracts`) with `src/index.ts` (a Hono app, `app.get("/api/posts", listPosts)`), `src/posts.ts` (`listPosts`), `src/slug.ts` (`toSlug`, six statements), `src/retry.ts` (`computeRetryDelay`, exists only here); `packages/contracts` (`@mr/contracts`, `"exports": { ".": "./src/index.ts" }`) with `formatDate` and `parseCursor`.
- `@mr/contracts` is declared by `web` but its source is in the other repo; sibling-package resolution resolves the import to `api/packages/contracts/src/index.ts` (`packages/core/src/resolve/sibling.test.ts`).

## bundler-aliases
A pnpm workspace (`apps/*`, `packages/*`) with no `node_modules` and no tsconfig `paths`: every alias lives in a bundler config, which the index reads as text and never runs. Every app declares `vite` or `webpack` in `devDependencies`, so a config's own `import ... from "vite"` is external. No source file imports another third-party package.
- `apps/vite-app/vite.config.ts`: object-form `resolve.alias` with `"@"` (`path.resolve(__dirname, "src")`) and `"~ui"` (`fileURLToPath(new URL("../../packages/ui/src", import.meta.url))`, pointing into `packages/ui`).
- `apps/vite-array/vite.config.mts`: array form `[{ find: "#lib", replacement: "/src/lib" }]` inside `defineConfig(() => ({ ... }))`; the leading `/` is relative to the app.
- `apps/webpack-app/webpack.config.js`: `module.exports` with `"@app"` (`path.resolve(__dirname, "src/")`) and `components$` (`path.join(__dirname, "src/components/index.ts")`, an exact alias).
- `apps/dynamic/vite.config.ts`: `alias: makeAliases()`, a computed value that cannot be read statically. Its two imports (`@dyn/one`, `@dyn/two`) are unresolved with reason `alias_not_static`.
- Counts: the three readable apps hold 10 import edges (`imports` edges whose source is in `apps/vite-app`, `apps/vite-array` or `apps/webpack-app`): 4 + 1 in `vite-app`, 2 + 1 in `vite-array`, 2 in `webpack-app`; the `+ 1` is each Vite config's import of `vite`. Imports of `node:` modules make no edge and are not counted. `gantry init` prints `unresolved:    2`, the two imports of `apps/dynamic/src/main.ts`.

## linking
Workspace (`apps/*`) for client calls through axios and ky instances (spec section 9, rules 4b and 4c), with a Hono recipe in `.gantry/recipe.json`.

- `apps/users-api` (`@fx/users-api`) mounts its `users` app at `/api`; `apps/billing` (`@fx/billing`) has `/health` and `/invoices`.
- `apps/web` (`@fx/web`): `src/features/users.ts` calls through instances and `fetch` with bases from the environment, constants and wrappers (a call whose URL starts with an environment member stays a `dynamic_url` gap; `relativeProxy` links); `src/lib/same-origin-http.ts` declares `rel`, `kyRel` and `kyRelAuth` with the base `/api`; `src/lib/index.ts` re-exports them; `src/features/same-origin.ts` and `src/features/reexport.ts` call them and link; `relFetch`, `relRequest` and `useRelFetch` in the same file are client wrappers (their bodies are `wrapper_body`), `getUser` is not; `src/lib/opaque.ts` holds `send`, listed in the recipe's `clientWrappers`; `src/features/same-origin-wrappers.ts` calls them and links.
- `apps/legacy-web` (`@fx/legacy-web`) sets `axios.defaults.baseURL = "/api"` and calls the default `axios`; `apps/web` never sets it.

## ts-references
A repo with no workspace tool: no `pnpm-workspace.yaml`, no `workspaces` field, no `project.json`, no `node_modules`. The packages are tied together only by tsconfig project references.
- Root: `package.json` (`ts-references-root`) and `tsconfig.json` with `"files": []` and `references` to `./packages/core`, `./packages/util` and `./apps/cli`.
- `packages/core` (`@refs/core`, `main` `dist/index.js`, `types` `dist/index.d.ts`; tsconfig `composite`, `outDir: "dist"`, `rootDir: "src"`): `src/index.ts` exports `parseLine` and `formatLine`.
- `packages/util` (no `package.json`, named by its directory; tsconfig `composite`): `src/strings.ts` exports `padLeft`.
- `apps/cli` (`@refs/cli`, depends on `@refs/core`; tsconfig references `../../packages/core` and `../../packages/util`): `src/main.ts` imports `@refs/core` and `../../../packages/util/src/strings`.
- Counts: four workspaces (`.`, `@refs/core`, `packages/util`, `@refs/cli`), four files in the dump, two `imports` edges (both from `main.ts`, both into `src/`), no edge into `dist/`.

## no-workspace-tool
A repo with several `package.json` files and no pnpm, npm, yarn, bun or Nx workspace config and no tsconfig references. Every directory holding a `package.json` is a workspace.
- Root: `package.json` (`plain-root`, no `workspaces`).
- `shared` (`@plain/shared`, `main` `src/index.ts`): `src/index.ts` exports `greet`.
- `server` (`@plain/server`) and `web` (`@plain/web`): each depends on `@plain/shared` and imports it from `src/`.
- `tools/scripts` (`@plain/scripts`, no dependencies): a nested folder.
- Counts: five workspaces (`.` and the four packages), two `imports` edges into `shared/src/index.ts`, two `depends_on` edges.

## scip
`pnpm-turbo.scip`, a SCIP index of `fixtures/pnpm-turbo` made once with scip-typescript, and a README with the command and the tool version. It is read by the precise-mode tests (`gantry index --scip`) and is not a repo of its own.
