# OSS evaluation labels

Hand labels for the OSS corpus (`evals/oss/repos.json`), one file per case. This page covers the call-linking
cases (`linking-*.json`). The other files hold route, endpoint, table and read/write labels and follow the schema
in spec section 13.

## Route, endpoint, table, read and write labels: conventions

Written down before the re-measurement of the recipe agent (#350) and not changed by it. The labels were written
by labeller agents, not by the recipe agent or the engine, by listing registration sites with `rg` and reading
each one. A repo's file lists only the kinds it has (`kinds`).

- **route**: a frontend page URL, one per distinct URL. Pathless layouts have no URL. API handlers are not routes.
- **endpoint**: method + full path after every prefix (mounts, global prefixes, controller and plugin prefixes,
  versions, route groups). `ALL` when the registration names no method. A mount is not an endpoint. Next.js
  `route.ts`: one endpoint per exported HTTP method function.
- **table**: the explicit name in the code (`@@map`, `pgTable("x")`, `@Entity("x")`, a Mongoose model name string,
  `CREATE TABLE x`, the keys of a Kysely database interface); otherwise the model or class name as written. Where
  a model and a migration name the same table, the model (or Kysely interface key) is used, except where the repo
  has no model (go-base and simplebank: the migrations). Once per table.
- **read** and **write**: a (file, table) pair: a file that queries a table and does not only declare it. A
  select, find or join reads; an insert, update, delete, create or save writes. A file that does both has one
  entry in each list.
- Left out: tests, e2e, storybook, docs, examples, mocks, scripts, generated and vendored code. tRPC and GraphQL
  procedures are not method + path and are not labelled. Health checks and catch-all handlers that real code
  registers are labelled.
- Path keys: the scorer treats `:param`, `[param]` and `{param}` as the same segment, a catch-all as `*`, and a
  path with and without a trailing slash as one key, so such variants are labelled once.

## Go cases (#277)

Four held-out Go repos, one per stack slot of the Go milestone. They replace the four Go repos that were used
for tuning (`go-base`, `golang-gin-realworld-example-app`, `nethttp`, `simplebank`) when a score has to be
read as unseen. All four were chosen and labelled before any scoring run, by reading the registration and
query sites with `rg` and then the code at each one; no label comes from Gantry's output and none was changed
after a run. Nothing from the repos is committed: only labels, counts and SHAs.

| Case                       | Repo and licence                                                                             | Stack                           | Labelled           | Counts                                   |
| -------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- | ------------------ | ---------------------------------------- |
| `hotel-bookings`           | `raihan2bd/hotel-bookings`, MIT, `56e92cfb8e3fed52804f4d6e62b78ee9edadfc58`                  | chi                             | endpoint           | 26 endpoints                             |
| `go-realworld-example-app` | `uptrace/go-realworld-example-app`, BSD-2-Clause, `94fc6d26f3206208de8f3c1d20799aa733fdb3c3` | gin                             | endpoint           | 19 endpoints                             |
| `realworld.go`             | `raeperd/realworld.go`, MIT, `c109ab8a966aa532287e8749994771a4d116ad7b`                      | net/http (1.22 method patterns) | endpoint           | 27 endpoints                             |
| `gopodder`                 | `cbrgm/gopodder`, Apache-2.0, `65c265576465c63cf7ee276ac956f63642196c9d`                     | sqlc                            | table, read, write | 7 tables, 7 reads, 7 writes (59 queries) |

Labeller: agent `claude-fable-5-2`, 2026-11-21. Maintainer spot check (every tenth label in sorted order): see
the pull request of #277.

Conventions added for these cases, on top of the ones above:

- **registration** is `<path>:<line>` of the call that registers the endpoint, in the label's `file`. For a
  call that spans lines it is the line where the call starts. It is read at the registration site, never
  from Gantry's output, and is never scored (like `handler`, `fns` and `unresolved`).
- **handler** is `<path>:<line>` of the `func` that declares the handler, also when the registration wraps it
  (`authenticate(handleGetUser(db, ...))` names `handleGetUser`). A handler that is a standard-library function
  (`pprof.Index`) or an inline expression (`http.StripPrefix(...)`) has no `handler`.
- A handler registered as a method value (`handlers.Repo.Home`) is labelled with the method's declaration.
- `Handle` / `HandleFunc` with a pattern that has no method (`"/debug/vars"`) and chi `Handle` are `ALL`. A
  pattern with a method (`"GET /health"`) is that method.
- A handler that returns another `http.ServeMux` is a mount: the outer registration (`mux.Handle("/debug/", handleGetDebug())`)
  is not an endpoint, and the patterns registered on the inner mux are, each with the path as written (the inner
  patterns already hold the full path).
- Group and `Route` prefixes are joined (`rwe.API.Group("/api")`, then `Group("")` in each package, then
  `g.GET("/users")` is `POST /api/users`). Middleware registrations (`Use`) are not endpoints.
- A host-qualified pattern (`router.HandleFunc("dreamsofcode.foo/", handle)`) is not labelled as an endpoint. This
  states what the existing `nethttp` labels do, which list `ALL /` and the four `/monster` routes and not that
  pattern; no label was changed. The reference recipe for `nethttp` leaves such patterns out with a `constraints`
  regex.
- For sqlc, the query file is the read/write file (as for `simplebank`): the generated `queries.sql.go` is
  generated code and the Go store only calls it. `fns` lists the query names with the line of their
  `-- name:` comment. A query that reads a second table in a subquery or join (`ListAccounts` reads `users`)
  is listed under both tables. A soft delete written as `UPDATE ... SET deleted` is a write. `db.Exec(schema)`
  only creates tables and is not a read or a write.
- `unresolved` is empty in all four cases: every path and table name could be read from the code.

Registration and query greps, run over the repo without tests, vendored and generated code. Every hit was
read; the ones that are not a registration (session `Get`, form `Get`) are not labelled.

| Case                       | Grep                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hotel-bookings`           | `rg -n "\.(Get\|Post\|Put\|Delete\|Patch\|Route\|Mount\|Group\|Handle\|HandleFunc)\(" cmd internal`                                                                                   |
| `go-realworld-example-app` | `rg -n "\.(GET\|POST\|PUT\|DELETE\|PATCH\|Group\|Any\|Handle\|Static)\(" .`                                                                                                           |
| `realworld.go`             | `rg -n "HandleFunc\(\|\.Handle\(" --glob '!vendor/**' --glob '!*_test.go' .`                                                                                                          |
| `gopodder`                 | `rg -n "^-- name:" gopodder/pggen/queries.sql` and `rg -n -i "SELECT \|INSERT INTO\|UPDATE \w+ SET\|DELETE FROM\|\.Exec\(\|\.Query\(" --glob '*.go' .` outside `pggen/queries.sql.go` |

Site-by-site comparison of the greps above with the labels (every hit was read):

| Case                       | Grep hits                             | Registrations labelled       | Hits that are not an endpoint                                                                                                                                          |
| -------------------------- | ------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hotel-bookings`           | 119 (96 outside `*_test.go`)          | 26 of 26, all in `routes.go` | 1 `mux.Route("/admin", ...)` prefix; 69 session, form and query `Get` / `Put` calls; 23 in tests (12 repeat the routes on a test mux, 11 are client and session calls) |
| `go-realworld-example-app` | 22                                    | 19 of 19                     | 3 `Group` calls that only set a prefix (`rwe/router.go:25`, `org/init.go:8`, `blog/init.go:9`)                                                                         |
| `realworld.go`             | 38 (the 14 vendored hits are removed) | 27 of 27, all in `main.go`   | 1 mount (`mux.Handle("/debug/", handleGetDebug())`); 10 in `docs/prompts/*.md`, planning notes that repeat a registration already labelled in `main.go`, not code      |

No unlabelled registration was found, so `unresolved` stays empty in all three. `gopodder` has no endpoints; its
query sites are in the table above.

**Shortfall.** The issue asks for at least 20 endpoints per held-out router case. `go-realworld-example-app`
has 19 at the pinned commit: the grep finds 19 registration calls and all 19 are labelled. The repo is not
replaced. One more URL is reachable without a registration: `GET /api/articles/feed` is served by `showArticle`,
which hands over to `listArticlesFeed` when the slug is `feed` (`blog/article_api.go:48`). It is not labelled
because the conventions label registrations; with it the case would have 20. The maintainer rules on both at the
spot check.

`pnpm tsx evals/oss/check-labels.ts <case>...` checks these files against the clones (spec section 13): every
file exists, and every handler and function line is inside its file and holds a `func` or the function's name.
For an endpoint with a `registration`, the line must be in the label's `file` and hold the method (unless
`ALL`), the last literal segment of the path and the name of the function the `handler` line declares. The scorer
(`scripts/eval-lib.ts`) reads label files with a strict schema, so a key it does not know is an input error
(exit 2), and `registration` is not part of any scoring key. It does not check that the label is right; that is
the maintainer's spot check.

## TypeScript data-access cases (#269)

Nine held-out TypeScript repos, one per data-access stack, labelled with `table`, `read` and `write` before any
recipe for them exists. None is a tuning repo. Each label was written by reading the table definitions and
every access call with `rg` and then the code at each hit; no label comes from Gantry's output and none was
changed after a run. Nothing from the repos is committed: only labels, counts and SHAs. A collection counts as a
table.

| Case                                           | Repo and licence                                                                                           | Stack                         | Tables | Reads | Writes |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- | -----: | ----: | -----: |
| `taxonomy`                                     | `shadcn-ui/taxonomy`, MIT, `298a8857c7128a0d121e7f699dfd729f23b3966d`                                      | Prisma (blocks)               |      5 |     6 |      4 |
| `saas-starter`                                 | `nextjs/saas-starter`, MIT, `6e33e58b1e553a41fe22e6b941a7229a002de361`                                     | Drizzle (blocks)              |      5 |    10 |      7 |
| `react-tanstarter`                             | `dotnize/react-tanstarter`, Unlicense, `7faa622c492fc3f699dc959afc69a76205bb1774`                          | Drizzle, TanStack Start       |      4 |     0 |      0 |
| `graphile-worker`                              | `graphile/worker`, MIT, `b4f1b41c7abd747586879bf68a46a5a22897fa96`                                         | raw SQL through `pg` (blocks) |      5 |     7 |     16 |
| `nestjs-realworld-typeorm`                     | `lujakob/nestjs-realworld-example-app`, ISC, `c1c2cc4e448b279ff083272df1ac50d20c3304fa`                    | TypeORM                       |      5 |     8 |      5 |
| `fastify-api-boilerplate-jwt`                  | `Tony133/fastify-api-boilerplate-jwt`, MIT, `a081ab3dc687e1cd8f75ed4f4bb131f5181aa60d`                     | Kysely                        |      1 |     5 |      5 |
| `sequelize-typescript-example`                 | `RobinBuschmann/sequelize-typescript-example`, ISC, `cb1e675c9cd8a6df8955c81a3dedfb02b7cc4a31`             | Sequelize                     |      5 |     2 |      3 |
| `nestjs-realworld-mikro-orm`                   | `mikro-orm/nestjs-realworld-example-app`, MIT, `3bb628edebc95da30adcbeeb2ecb33158c3dbc95`                  | MikroORM                      |      4 |     7 |      5 |
| `node-express-mongoose-typescript-boilerplate` | `saisilinus/node-express-mongoose-typescript-boilerplate`, MIT, `278143db5b01d5281649a968c18b40ae709f2ec7` | Mongoose                      |      2 |     5 |      3 |

Labeller: agent `claude-sonnet-5-5`, 2026-11-21, not the author of any recipe or helper. Maintainer spot check
(every tenth label in sorted order, `--sample 10`): pending, see the pull request of #269. The label files
`taxonomy`, `react-tanstarter` and `nestjs-realworld-typeorm` also hold the route and endpoint labels of the
framework cases below (#268) in the same file, unchanged.

Conventions, on top of the ones above:

- A `read` / `write` entry is a file that queries the table. For an ORM repository or model the table is the
  entity the repository or model stands for. `find*`, `count`, `findAndCount` and query builders read; `create`,
  `save`, `insert`, `update`, `delete`, `destroy`, `remove`, `upsert`, `flush` and `persist` write. A SQL
  `UPDATE` or `DELETE` writes only the table it changes; a table that appears only in its `WHERE` (a sub-select
  in `delete ... where id not in (select ... from jobs)`) is read. A relation that is loaded or changed through
  a collection is labelled for the entity the call is made on, not for the join table.
- Left out, as in the other cases: tests, e2e, docs, examples, mocks, one-off scripts, seed files and generated
  code. SQL files (migrations, stored-function bodies) are not access sites: the labelled sites are the
  TypeScript calls.
- A site whose table cannot be read from the code at that line (a library that queries inside itself, a stored
  function, a model chosen at run time) is a runtime-only site: it is not in `read` / `write` and is listed
  below in the same "- `<case>` `<file>:<line>`: <reason>" form the framework cases use, which
  `labels-check.ts` reads.

Per-case naming rule and runtime-only sites:

| Case                                           | Naming rule                                                                                                                                                                                                                                                                                     | Runtime-only sites (listed below)                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taxonomy`                                     | Prisma `model X`: the `@@map` value (`accounts`, `sessions`, `users`, `verification_tokens`, `posts`). A model access `db.user` is the table of model `User`.                                                                                                                                   | `lib/auth.ts:17`: the NextAuth Prisma adapter queries four tables inside the library.                                                                                                                                                    |
| `saas-starter`                                 | The string in `pgTable("name")`. An access names the table variable (`teamMembers` is `team_members`). `db.select().from(x)` and joins read; `insert`, `update`, `delete` write. `lib/db/seed.ts` is a script and left out.                                                                     | none                                                                                                                                                                                                                                     |
| `react-tanstarter`                             | The string in `pgTable("name")` (`user`, `session`, `account`, `verification`).                                                                                                                                                                                                                 | `src/lib/auth/auth.ts:15`: the better-auth Drizzle adapter does every query. The repo has no query of its own, so it has no `read` or `write` label.                                                                                     |
| `graphile-worker`                              | `CREATE TABLE` in the migrations, after the renames of `sql/000016.sql`: `_private_jobs`, `_private_job_queues`, `_private_tasks`, `_private_known_crontabs`; plus `migrations`, created in `src/migrate.ts`.                                                                                   | `src/helpers.ts:35,101` and `src/workerUtils.ts:41,51,61,83`: calls of stored functions (`add_job`, `add_jobs`, `complete_jobs`, `permanently_fail_jobs`, `reschedule_jobs`, `force_unlock_workers`) whose bodies are in the migrations. |
| `nestjs-realworld-typeorm`                     | `@Entity("x")` is `x`; `@Entity()` is the class name in snake case (`Comment` is `comment`). The implicit join table of `UserEntity.favorites` has no entity and is not labelled.                                                                                                               | none                                                                                                                                                                                                                                     |
| `fastify-api-boilerplate-jwt`                  | The keys of the Kysely `Database` interface (`users`).                                                                                                                                                                                                                                          | none                                                                                                                                                                                                                                     |
| `sequelize-typescript-example`                 | `@Table` with no options: the model class name as Sequelize pluralises it (`Movie` is `Movies`, `MovieActor` is `MovieActors`).                                                                                                                                                                 | `lib/routes/actors.ts:29,37`, `lib/routes/movies.ts:17,25`: `Model.scope(req.query.scope)` picks scopes at run time, and the scopes join other tables. `MovieGenres` is never queried by name.                                           |
| `nestjs-realworld-mikro-orm`                   | `@Entity()` with no options: the class name in snake case (`article`, `comment`, `tag`, `user`). The pivot tables `user_to_follower` and `user_favorites` have no entity and are not labelled. A change to a `Collection` is a write of the owning entity (`user`). `src/seeders/` is left out. | none                                                                                                                                                                                                                                     |
| `node-express-mongoose-typescript-boilerplate` | `mongoose.model("Name", schema)`, the collection as Mongoose pluralises it (`User` is `users`, `Token` is `tokens`).                                                                                                                                                                            | `src/modules/paginate/paginate.ts:69,70`: the paginate plugin queries whichever model it is attached to (`this`).                                                                                                                        |

Grep used to enumerate (run over each clone, tests and node_modules left out; every hit was read):
`rg -n "^model |@@map|pgTable\(|sqliteTable\(|mysqlTable\(|@Entity\(|define\(|@Table\(|model\(|CREATE TABLE"` for
definitions, and for accesses `prisma|db\.\w+\.(find\w*|count|aggregate|groupBy|create\w*|update\w*|upsert|delete\w*)`,
`db\.(select|insert|update|delete)|\.(from|innerJoin|leftJoin)\(`, `getRepository|Repository\b|\.(find|findOne\w*|save|insert|update|delete|remove)\(`,
`selectFrom|insertInto|updateTable|deleteFrom`, `\.(findAll|findByPk|create|update|destroy)\(`,
`\bem\.|nativeDelete|flush\(`, `\.(find|findOne|create|updateOne|deleteOne|deleteMany|countDocuments)\(` and SQL
strings with `select|insert into|update|delete from`.

`pnpm tsx evals/oss/labels-check.ts <case>` also scans the clone for these table definitions and calls with fixed
patterns per stack (`dataHits` in `scripts/eval-label-scan.ts`) and prints `<k> unlabelled candidates`; it must be
0. `--sample 10` prints every tenth label (tables at their definition, reads and writes at their call) for the
spot check.

**Limits of the scan.** The data scan skips an access call whose table name matches no `table` label, so a table
whose definition it does not recognise (an implicit join table, for example) hides its accesses too; and a call
that names no table (`em.flush`, `$queryRaw`, `sequelize.query`) counts as covered by any label of that kind in
the same file. The file-level table check of a read or write label is a loose substring test (singular, plural,
underscores dropped). The scan and the maintainer's spot check are what guard the labels.

**Left out, and why** (for the maintainer to rule on at the spot check):

- Seed scripts: `lib/db/seed.ts` of `saas-starter` and the seeders of `nestjs-realworld-mikro-orm`
  (`src/seeders/`). They are one-off scripts, and scripts are left out in every case.
- Implicit join tables: `user_favorites_article` (`nestjs-realworld-typeorm`), `user_to_follower` and
  `user_favorites` (`nestjs-realworld-mikro-orm`). They have no entity or table definition of their own to
  label; a change to the collection is a write of the owning entity.
- Migration SQL and stored-function bodies (`graphile-worker`'s `sql/` files). The labelled sites are the
  TypeScript calls; the stored-function calls are runtime-only lines below.
- `react-tanstarter` has 4 tables and no reads or writes: every query goes through the better-auth Drizzle
  adapter, a library, and the repo has no query of its own.

Runtime-only sites of the data-access cases:

- `taxonomy` `lib/auth.ts:17`: `PrismaAdapter(db)`, the NextAuth adapter queries accounts, sessions, users and verification_tokens inside the library
- `react-tanstarter` `src/lib/auth/auth.ts:15`: `drizzleAdapter(db)`, the better-auth adapter does every query of the repo, so it has no read or write label
- `graphile-worker` `src/helpers.ts:35`: calls the stored function add_job; the tables it writes are named in the migrations, not here
- `graphile-worker` `src/helpers.ts:101`: calls the stored function add_jobs; the tables it writes are named in the migrations, not here
- `graphile-worker` `src/workerUtils.ts:41`: calls the stored function complete_jobs; the tables it writes are named in the migrations, not here
- `graphile-worker` `src/workerUtils.ts:51`: calls the stored function permanently_fail_jobs; the tables it writes are named in the migrations, not here
- `graphile-worker` `src/workerUtils.ts:61`: calls the stored function reschedule_jobs; the tables it writes are named in the migrations, not here
- `graphile-worker` `src/workerUtils.ts:83`: calls the stored function force_unlock_workers; the tables it writes are named in the migrations, not here
- `sequelize-typescript-example` `lib/routes/actors.ts:29`: the scope comes from the query string; the scopes include the movies and genres tables
- `sequelize-typescript-example` `lib/routes/actors.ts:37`: the scope comes from the query string; the scopes include the movies and genres tables
- `sequelize-typescript-example` `lib/routes/movies.ts:17`: the scope comes from the query string; the scopes include the actors and genres tables
- `sequelize-typescript-example` `lib/routes/movies.ts:25`: the scope comes from the query string; the scopes include the actors and genres tables
- `node-express-mongoose-typescript-boilerplate` `src/modules/paginate/paginate.ts:69`: the paginate plugin counts documents of whichever model it is attached to; the model is `this`
- `node-express-mongoose-typescript-boilerplate` `src/modules/paginate/paginate.ts:70`: the paginate plugin finds documents of whichever model it is attached to; the model is `this`

## TypeScript framework cases (#268)

Nine held-out repos, one or more per framework case of the recipe milestone. All were pinned and labelled before
any recipe for them exists, by reading the registration sites with `rg` and then the code at each one; no label
comes from Gantry's output. Nothing from the repos is committed: only labels, counts and SHAs.

| Case                       | Repo and SHA                                                                                      | Stack                | Labelled        | Counts                                          | Maintainer spot check |
| -------------------------- | ------------------------------------------------------------------------------------------------- | -------------------- | --------------- | ----------------------------------------------- | --------------------- |
| `react-router-templates`   | `remix-run/react-router-templates`, `338a991a4c4d2474ea8d3699cfcd5a77a27c9424`                    | React Router         | route           | 2 routes                                        | pending               |
| `conduit-redux-web`        | `angelguzmaning/ts-redux-react-realworld-example-app`, `cb397562724ea7f53758d5511c220690b99fe2f5` | React Router (JSX)   | route           | 9 routes                                        | pending               |
| `fastify-demo`             | `fastify/demo`, `895908e4e706b896aa3991f3f6507617edddb1dd`                                        | Fastify, autoload    | endpoint        | 14 endpoints                                    | pending               |
| `express-typescript`       | `edwinhern/express-typescript`, `983fa0413659cd921c5754b00f7817903eb91364`                        | Express              | endpoint        | 4 endpoints                                     | pending               |
| `nestjs-realworld-typeorm` | `lujakob/nestjs-realworld-example-app`, `c1c2cc4e448b279ff083272df1ac50d20c3304fa`                | NestJS               | endpoint        | 21 endpoints                                    | pending               |
| `taxonomy`                 | `shadcn-ui/taxonomy`, `298a8857c7128a0d121e7f699dfd729f23b3966d`                                  | Next.js              | route, endpoint | 14 routes, 9 endpoints                          | pending               |
| `start-ui-web`             | `BearStudio/start-ui-web`, `368718acf5fcdd8bbee2776e5eb473647ea50950`                             | oRPC, TanStack Start | route, endpoint | 20 routes, 39 endpoints (18 rpc, 2 fn, 19 HTTP) | pending               |
| `react-tanstarter`         | `dotnize/react-tanstarter`, `7faa622c492fc3f699dc959afc69a76205bb1774`                            | TanStack Start       | route, endpoint | 4 routes, 3 endpoints (1 fn, 2 HTTP)            | pending               |
| `hono-open-api-starter`    | `w3cj/hono-open-api-starter`, `0d5f3bf523f525667d58edb38011e377e5898fc4`                          | Hono, zod-openapi    | endpoint        | 8 endpoints                                     | pending               |

Labeller: agent `claude-sonnet-5-5`, 2026-11-21 (not the author of any recipe or matcher). The maintainer spot check
(every tenth label in id order, from `pnpm tsx evals/oss/labels-check.ts <case> --sample 10`) is listed in the pull
request of #268 and is recorded here when done; until then every row says `pending`.

Conventions added for these cases, on top of the ones above:

- **registration** is `<path>:<line>` of the call that registers the endpoint, in the label's `file`; for a call
  that spans lines, the line where it starts (`createRoute({`, `fastify.get(`, `export async function GET(`, a
  decorator `@Get('x')`, a `handlers` key `POST: ...`). It is absent for an endpoint with no call of its own
  (Hono `app.doc("/doc")` is labelled without one) and for `rpc` and `fn` labels, whose schema has no such field.
  `handler` is not given for these cases (most handlers are inline or built by a factory).
- **Prefixes.** A Fastify autoload directory under `routes/` is a prefix (`routes/api/tasks/index.ts` is
  `/api/tasks`; `routes/home.ts` directly under `routes/` adds none). A NestJS path is the global prefix
  (`setGlobalPrefix('api')`), the controller prefix and the method path. A route file's own `file` holds the
  call but not the whole path, so the check looks at the registration call, not at the last path segment.
- **Next.js.** `page.tsx` is a route (route groups `(x)` dropped, `[x]`, `[...x]`, `[[...x]]` as written);
  layouts are not labelled; `route.ts` has one endpoint per exported HTTP method function; `pages/api/**` is one
  endpoint with method `ALL`. `app/api/auth/[...nextauth]/_route.ts` is not served (the file name is not
  `route.ts`) and is not labelled.
- **TanStack.** One route per URL; a pathless layout (`_auth`, `_guest`) and a layout file whose URL an index
  route also has (`login/route.tsx` next to `login/index.tsx`) are not labelled. A file route with only
  `server.handlers` is an API handler: one endpoint per handler key, path as the route id spells it (`$` for a
  splat), and not a route. oRPC: `rpc <router key>.<procedure key>` for every procedure of the `router` object.
  Server functions: `fn <const name>` of every `createServerFn` site, exported or not.
- **Left out.** Routes that a plugin serves from its options (`swagger` `routePrefix` and `static` `prefix` in
  `fastify-demo`, `SwaggerModule.setup('/docs')` in `nestjs-realworld-typeorm`, `swaggerUi.serve` in
  `express-typescript`), and Next.js metadata files (`robots.ts`, `opengraph-image.jpg`). No path is computed at
  run time in any of the nine repos, so `unresolved` is empty everywhere.

**Replacement.** `gothinkster/react-redux-realworld-example-app` (`ee72eba4056392c95a27bc48d385d3f54ba38a18`) was
planned for the JSX `<Route>` case. At that commit it has no TypeScript file (38 JavaScript files, 0 `.ts` or
`.tsx`), so Gantry cannot index it and it does not use the stack the case needs. It is not pinned. The case uses
`conduit-redux-web` instead, already pinned as held-out, which has a JSX `<Route>` tree in TypeScript. It is
smaller (9 routes in one `Switch`, no nesting) and was already used for call-linking; the pin gains the
`react-router` stack entry.

**Few labels.** `react-router-templates` has two URLs at the pinned commit (`/` in three framework-mode templates
and `/about` in the data-mode one); `express-typescript` has four endpoints. Both are what the repos register.

Registration greps, run over each repo without tests, build output and vendored code. Every hit was read.

| Case                       | Grep                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `react-router-templates`   | `rg -n "createBrowserRouter\|<Route\b\|route\(\|index\(\|layout\(\|prefix\(\|flatRoutes" --type ts`, plus `path:` in the data-mode config |
| `conduit-redux-web`        | `rg -n "<Route\b\|createBrowserRouter" --type ts` (`*.tsx` is included)                                                                   |
| `fastify-demo`             | `rg -n "\.(get\|post\|put\|patch\|delete\|all\|options\|head\|route\|on)\(" src` and `rg -n "register\(\|prefix\|autoload" src`           |
| `express-typescript`       | `rg -n "\.(get\|post\|put\|patch\|delete\|all\|route\|use)\(\|Router\(" src`                                                              |
| `nestjs-realworld-typeorm` | `rg -n "@Controller\(\|@(Get\|Post\|Put\|Patch\|Delete\|All\|Options\|Head)\(\|setGlobalPrefix\|RouterModule" src`                        |
| `taxonomy`                 | `rg --files app pages` and `rg -n "^export (async )?(function\|const) (GET\|POST\|PUT\|PATCH\|DELETE)" app/api`                           |
| `start-ui-web`             | `rg -n "createFileRoute\|createServerFn\|handlers:" src`, and the keys of each `src/server/routers/*.ts` object                           |
| `react-tanstarter`         | `rg -n "createFileRoute\|createServerFn\|handlers" src`                                                                                   |
| `hono-open-api-starter`    | `rg -n "createRoute\|\.(get\|post\|put\|patch\|delete\|all\|route\|on\|openapi\|doc)\(" src`                                              |

`pnpm tsx evals/oss/labels-check.ts <case>` runs the label checks of `check-labels` and then a scan of the same
kind of patterns over the clone, and prints every candidate site that no label covers and this page does not list.
It fails (exit 1) while one is left, and when this page lists a site the scan no longer finds. A site is listed
below as "- `<case>` `<file>:<line>`: <reason>" when it is not an endpoint or route or is a second place for a URL
that is already labelled once.

- `react-router-templates` `node-custom-server/app/routes.ts:3`: the same URL `/` as `default/app/routes.ts:3`, labelled once
- `react-router-templates` `unstable_rsc-framework-mode/app/routes.ts:3`: the same URL `/` as `default/app/routes.ts:3`, labelled once
- `react-router-templates` `unstable_rsc-data-mode-vite/src/routes/config.ts:7`: the pathless root layout of the data-mode template, no URL of its own
- `conduit-redux-web` `src/components/App/App.tsx:87`: the `GuestOnlyRoute` wrapper, which forwards the `path` of each use; the uses at lines 30 to 35 are labelled
- `conduit-redux-web` `src/components/App/App.tsx:101`: the `UserOnlyRoute` wrapper, same as above; the uses at lines 36 to 44 are labelled
- `fastify-demo` `src/plugins/app/tasks/tasks-repository.ts:104`: a knex `.delete()` query, not a route
- `fastify-demo` `src/routes/api/tasks/index.ts:132`: a repository `.delete(id)` call inside a handler, not a route
- `fastify-demo` `src/routes/api/tasks/index.ts:298`: a file manager `.delete(filename)` call inside a handler, not a route
- `express-typescript` `src/index.ts:18`: `process.on("SIGINT")`, a signal handler
- `express-typescript` `src/index.ts:19`: `process.on("SIGTERM")`, a signal handler
- `hono-open-api-starter` `src/app.ts:16`: `app.route("/", route)`, a mount of routers whose routes are labelled
- `hono-open-api-starter` `src/lib/create-app.ts:31`: `.route("/", router)`, a mount for tests and app creation
- `hono-open-api-starter` `src/routes/tasks/tasks.handlers.ts:86`: a Drizzle `db.delete(tasks)` query, not a route
- `start-ui-web` `src/routes/app/route.tsx:8`: layout of `/app`, whose URL is labelled once at `src/routes/app/index.tsx`
- `start-ui-web` `src/routes/login/route.tsx:8`: layout of `/login`, whose URL is labelled once at `src/routes/login/index.tsx`
- `start-ui-web` `src/routes/manager/route.tsx:8`: layout of `/manager`, whose URL is labelled once at `src/routes/manager/index.tsx`
- `react-tanstarter` `src/routes/_auth/app/route.tsx:7`: layout of `/app`, whose URL is labelled once at `src/routes/_auth/app/index.tsx`
- `react-tanstarter` `src/routes/_auth/route.tsx:9`: pathless layout `_auth`, no URL
- `react-tanstarter` `src/routes/_guest/route.tsx:6`: pathless layout `_guest`, no URL

## Call-linking labels

A `linking-<case>.json` file lists every request call site of a case's frontend, with the endpoint it reaches in
the backend or `null` and a reason. The labels were written before any matcher or reference recipe for these
cases exists, by reading the code at each site, and are never generated from the tool they score.

```json
{
  "case": "linking-blogdev",
  "repos": [{ "name": "blogdev", "sha": "<40 hex, equal to repos.json>" }],
  "labelledBy": "...",
  "requests": [
    {
      "repo": "blogdev",
      "file": "client/src/redux/actions/blogAction.ts",
      "line": 135,
      "method": "PUT",
      "path": "/api/blog/:id",
      "expect": { "repo": "blogdev", "workspace": "blogdev", "method": "PUT", "path": "/api/blog/:id" }
    },
    {
      "repo": "blogdev",
      "file": "client/src/utils/ImageUpload.ts",
      "line": 21,
      "method": "POST",
      "path": "https://api.cloudinary.com/v1_1/devat-channel/upload",
      "expect": null,
      "reason": "external"
    }
  ]
}
```

- `line` is the line where the call expression starts (`axios.get(`, `getAPI(`, `apiFetch<T>(`), also when its
  arguments continue on later lines. For a wrapper (`getAPI`, `apiFetch`) the site is the call of the wrapper, in
  the caller's file; the call inside the wrapper's body is its own site with `reason` `wrapper_body`.
- `method` and `path` are what the call requests, after the client's base URL and the wrapper's prefix:
  an origin (`https://host`) is dropped when it is the project's own backend, params are written `:name`, the
  query string is dropped. `ANY` stands for a method that comes from the caller (a wrapper body).
- `expect` is the endpoint that handles it: `repo` and `workspace` (the `name` in the `package.json` that owns
  the handler's file), and `method` and `path` as the backend serves them, the full path after every router
  prefix (`app.use("/api", ...)`, `router.use("/articles", ...)`). `null` means no endpoint in the case's
  backend, with `reason` one of `external` (a third-party host), `dynamic` (the URL is only known at run time),
  `wrapper_body` (the path is the wrapper's parameter), `no_such_endpoint`, `ambiguous`.
- Where a literal route and a parameter route could both match (`/articles/feed` and `/articles/:slug`),
  the label names the one Express picks: the first registered, which in these backends is the literal.
- Test files (`*.test.*`) are not request sites and are not labelled.

### Self-check and scoring

- `pnpm tsx evals/oss/check-labels.ts <case>...` checks that every `file:line` exists in the clone, that the
  line holds a call, and that the case has at least 20 linkable (non-null) labels. It prints
  `ok <case> <n> labels` and exits 0, or `FAIL <case> ...` with the problems and exits 1.
- `pnpm eval:score <case>` runs `index --dump` in the clone of each repo of the case and prints
  `{ case, bar, repos, requests: { labelled, predicted, matched, precision, recall, wrongHigh, pass }, missed, extra, pass }`.
  A link is a `requests` edge to an endpoint node, matched on repo, file, the call line (the edge's
  `evidence`) and the endpoint. `wrongHigh` counts high-confidence links the labels do not have. The bar is
  recall 0.90, precision 0.95 and `wrongHigh` 0. Each repo is indexed on its own, so a link from a frontend repo
  to a backend in another repo (`linking-conduit-hooks`, `linking-conduit-redux`) is out of reach until the
  cross-repo milestone; those two cases start at recall 0 by construction.

### Method, per case

Every case starts the same way. Run the first pass over the frontend directory, list the client instances and
wrappers it finds, run a second pass for each of their names, then read every hit and the backend's routers.

```sh
cd ~/Dev/gantry-oss/<name>@<sha7>
rg -n "fetch\(|axios|\bky\b" <frontend dir>
rg -n "<wrapper or instance names found in the first pass>" <frontend dir>
rg -n "router\.(get|post|put|patch|delete)|\.route\(|\.use\(" <backend dir>
```

| Case                    | Repos (role)                                              | Frontend dir          | Second-pass grep (after the first pass found these names)                       |
| ----------------------- | --------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `linking-blogdev`       | `blogdev` (tuning)                                        | `client/src`          | `rg -n "getAPI\(\|postAPI\(\|putAPI\(\|patchAPI\(\|deleteAPI\(" client/src`     |
| `linking-insta`         | `insta` (tuning)                                          | `client/src`          | `rg -n "BASE_URL\|axios\.(get\|post\|put\|patch\|delete)\(" client/src`         |
| `linking-conduit-hooks` | `conduit-hooks-web` + `conduit-express-ts` (tuning)       | `src`                 | `rg -n "API\.(get\|post\|put\|patch\|delete)\(" src`                            |
| `linking-meetmind`      | `meetmind-ai` (held-out, client and server in one repo)   | `meetmind-client/src` | `rg -n "\bapi\.(get\|post\|put\|patch\|delete)\(\|\bapi\(" meetmind-client/src` |
| `linking-conduit-redux` | `conduit-redux-web` + `conduit-express-prisma` (held-out) | `src`                 | `rg -n "axios\.(get\|post\|put\|patch\|delete)\(" src`                          |

Notes by case:

- **blogdev.** All calls go through `getAPI`, `postAPI`, `patchAPI`, `putAPI`, `deleteAPI` in
  `client/src/utils/FetchData.ts`, which request `` `/api/${url}` `` (CRA `proxy`). The server mounts the
  routers of `server/routes/` under `/api` in `server/index.ts`. The Cloudinary upload is `external`.
- **insta.** Calls are `axios.<verb>(`${BASE_URL}/...`)` with `BASE_URL` a constant in
  `client/src/utils/baseUrl.ts` whose value is the project's deployed origin plus `/api`; the origin is
  dropped, as the backend mounts each router under `/api/<name>` in `server/src/index.ts`. Cloudinary and
  Facebook Graph calls are `external`.
- **conduit-hooks.** `src/api/APIUtils.ts` sets `axios.defaults.baseURL` to the deployed Conduit API
  origin plus `/api` and exports `axios` as `API`; the origin is dropped. `conduit-express-ts` mounts
  `MainRouter` at `/api`; its `users` router is mounted at `/`, so `/api/user` and `/api/users` are served.
- **meetmind.** One axios instance, `api` in `meetmind-client/src/services/api.ts`, with `baseURL` from
  `VITE_API_URL` (default `http://localhost:5000/api`); every call passes a literal or template path. The two
  `api(original)` calls in its 401 interceptor retry whatever request failed (`dynamic`). The server mounts
  `auth`, `users`, `meetings`, `tasks` and `admin` routers under `/api` in `meetmind-server/src/app.ts`.
  This case replaced `pos`, which had only 6 linkable sites (7 `apiFetch` calls, the rest mock data).
- **conduit-redux.** Every request is in `src/services/conduit.ts`; `axios.defaults.baseURL` is
  `settings.baseApiUrl` (the deployed API origin plus `/api/`, dropped). `conduit-express-prisma` mounts all
  controllers under `/api` in `src/routes/routes.ts`.

### Counts at the pinned commits

| Case                    | Labels | Linkable | Null (reason)              |
| ----------------------- | -----: | -------: | -------------------------- |
| `linking-blogdev`       |     38 |       32 | 1 external, 5 wrapper_body |
| `linking-insta`         |     52 |       50 | 2 external                 |
| `linking-conduit-hooks` |     22 |       22 | none                       |
| `linking-meetmind`      |     31 |       29 | 2 dynamic                  |
| `linking-conduit-redux` |     19 |       19 | none                       |

A case needs 20 linkable labels. `linking-conduit-redux` has 19: the maintainer accepted that, and the file
records it as `"minLinkable": { "count": 19, "reason": "..." }` (a per-case minimum below 20, never a global
one).
