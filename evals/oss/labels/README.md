# OSS evaluation labels

Hand labels for the OSS corpus (`evals/oss/repos.json`), one file per case. This page covers the call-linking
cases (`linking-*.json`). The other files hold route, endpoint, table and read/write labels and follow the schema
in spec section 13.

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

| Case                    | Repos (role)                                              | Frontend dir | Second-pass grep (after the first pass found these names)                   |
| ----------------------- | --------------------------------------------------------- | ------------ | --------------------------------------------------------------------------- |
| `linking-blogdev`       | `blogdev` (tuning)                                        | `client/src` | `rg -n "getAPI\(\|postAPI\(\|putAPI\(\|patchAPI\(\|deleteAPI\(" client/src` |
| `linking-insta`         | `insta` (tuning)                                          | `client/src` | `rg -n "BASE_URL\|axios\.(get\|post\|put\|patch\|delete)\(" client/src`     |
| `linking-conduit-hooks` | `conduit-hooks-web` + `conduit-express-ts` (tuning)       | `src`        | `rg -n "API\.(get\|post\|put\|patch\|delete)\(" src`                        |
| `linking-pos`           | `pos` (held-out)                                          | `apps/web`   | `rg -n "apiFetch\(\|bridgeFetch\(\|apiBase\(" apps/web`                     |
| `linking-conduit-redux` | `conduit-redux-web` + `conduit-express-prisma` (held-out) | `src`        | `rg -n "axios\.(get\|post\|put\|patch\|delete)\(" src`                      |

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
- **pos.** `apiFetch(path)` requests `` `${API_BASE}/api/v1${path}` ``, with `API_BASE` from `VITE_API_URL`
  (default `http://localhost:4000`). The print bridge calls go to a URL the user stores in `localStorage`
  and are `dynamic`; the service worker's `fetch(req)` forwards whatever request it was given (`dynamic`).
  The other frontend features read mock data and make no request.
- **conduit-redux.** Every request is in `src/services/conduit.ts`; `axios.defaults.baseURL` is
  `settings.baseApiUrl` (the deployed API origin plus `/api/`, dropped). `conduit-express-prisma` mounts all
  controllers under `/api` in `src/routes/routes.ts`.

### Counts at the pinned commits

| Case                    | Labels | Linkable | Null (reason)              |
| ----------------------- | -----: | -------: | -------------------------- |
| `linking-blogdev`       |     38 |       32 | 1 external, 5 wrapper_body |
| `linking-insta`         |     52 |       50 | 2 external                 |
| `linking-conduit-hooks` |     22 |       22 | none                       |
| `linking-pos`           |     14 |        6 | 2 wrapper_body, 6 dynamic  |
| `linking-conduit-redux` |     19 |       19 | none                       |

A case needs 20 linkable labels. `linking-conduit-redux` has 19: the maintainer accepted that, and the file
records it as `"minLinkable": { "count": 19, "reason": "..." }` (a per-case minimum below 20, never a global
one). `linking-pos` has 6 and is being replaced; `check-labels` reports it until then.
