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

## nx
- `nx.json`, two projects with `project.json`: `apps/shop` and `libs/cart`.
- `tsconfig.base.json` path alias `@shop/cart`.

## react-router-fastify
Workspace (`apps/*`, `packages/*`) with three React Router apps, one per declaration mode, a Fastify API and a Drizzle package, for the route, endpoint and table recipes. Hand labels are in `evals/fixtures/labels/react-router-fastify.json` (label `file` values are relative to this fixture; routes declared in a config file are labelled with that file). Every route path is unique across the apps (each app owns its own URL space) so a label key is one path.
- `apps/web-data` (`react`, `react-router`): data mode. `src/router.tsx` has one `createBrowserRouter` with route objects using `path`, `index: true`, `element`, `Component`, three levels of `children`, a pathless layout route and `lazy: () => import("./routes/settings")`; the root route is `/app`. `src/memory.tsx` has a `createMemoryRouter` with `/preview` and `/preview/:postId`.
- `apps/web-declarative` (`react`, `react-router`): declarative mode. `src/App.tsx` has `<BrowserRouter><Routes>` with nested `<Route>` elements under `docs`, a pathless `<Route element={<Layout />}>`, an `index` route and `posts/*`, whose component `src/pages/PostsSection.tsx` holds a nested `<Routes>` (`/docs/posts`, `/docs/posts/:postId`, `/docs/posts/new`).
- `apps/web-framework` (`react-router`, `@react-router/dev`, `@react-router/fs-routes`): framework mode. `app/routes.ts` exports a `RouteConfig` with `route()`, `layout()`, `prefix()` and `index()`, plus `...(await flatRoutes({ rootDirectory: "routes/flat" }))` over `app/routes/flat/` (`_index.tsx`, `articles.tsx`, `articles._index.tsx`, `articles.$articleId.tsx`, `articles_.new.tsx`, `_auth.tsx`, `_auth.login.tsx`, `($lang).about.tsx`, `files.$.tsx`).
- Every web app has pages that call the API with a literal or template-literal URL (`fetch("/api/posts")`, `` fetch(`/api/posts/${id}`) ``, `fetch("/api/users", { method: "POST" })`); no URL is built by concatenation. The labels list each call under `link`.
- `apps/api` (`fastify`, `fastify-plugin`, `@fastify/autoload`, `@acme-rrf/db`): `src/server.ts` registers `src/plugins/db.ts` (wrapped in `fastify-plugin`), `postsRoutes` with `{ prefix: "/api/posts" }`, which registers `commentsRoutes` from another file with `{ prefix: "/:postId/comments" }`; shorthand `get`, `post`, `put`, `delete` (one `post` with an options object before the handler); `app.route({ method: ["GET", "HEAD"], url: "/api/stats", handler })`; `app.get(VERSION_PATH, ...)` with the path imported from `src/paths.ts`; handlers imported from `src/controllers/*.ts`; and `app.register(autoload, { dir: join(__dirname, "autoroutes"), options: { prefix: "/api" } })` over `src/autoroutes/users/index.ts` (the directory adds `/users`) and `src/autoroutes/health.ts`. 14 labelled endpoints.
- Runtime path (not labelled): `registerFeature(app, name)` in `src/server.ts` registers `` app.get(`/api/features/${name}`, ...) ``, a path built from a function parameter, so it cannot be known statically. It is left out of the label file on purpose; a recipe should report it as a low-confidence node with a reason.
- `packages/db` (`@acme-rrf/db`, `drizzle-orm`): `pgTable("posts")`, `pgTable("users")`, `pgTable("comments")`; `src/queries/*.ts` do `select().from`, `insert`, `update`, `delete` and one `innerJoin` (comments with users). Controllers call them, so a page reaches a table through an endpoint (for example `PostList` to `GET /api/posts` to `posts`).
