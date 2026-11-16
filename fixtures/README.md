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
