# Gantry Engineering Spec

The single source of truth for contracts. Every issue references sections here by number. If an issue conflicts with this spec, follow the spec and flag it in the PR. To change a contract, edit this file in the same PR and say so in the PR description.

Plan doc (background and rationale): https://claude.ai/artifact/7UCZZRCs4k45gPkKBfocmY

## 1. Ground rules

- **Repo:** `jbknick/architecture-visualization-cc-plugin` (public). The product, plugin, CLI and MCP server are named **Gantry**. Default branch `main`. One branch and PR per issue (`gantry/<issue-number>-<short-slug>`), stacked on its dependency's branch when that one isn't merged yet.
- **Public repo:** the test bed (Devprentice) is private. Never commit its code, fact sheets, descriptions, graph dumps or screenshots showing its code. Private eval data lives only in git-ignored `evals/private/`. Commit only scripts and aggregate numbers.
- **Toolchain:** Node 22 LTS, pnpm 9+, TypeScript strict, ESM (`"module": "NodeNext"`), vitest, Biome. Build with `tsc -b`; bundle CLI/MCP entry points with `tsup` into `plugin/dist/`.
- **Local quality gate:** `pnpm check` = `biome check . && tsc -b --noEmit && vitest run`. It must pass before a PR. There is no hosted CI; never add or wait for GitHub Actions.
- **Determinism:** index output is sorted and stable; no timestamps or random values inside graph content (timestamps only in `meta`, `usage_log`, `created_at`).
- **Target repo is read-only** except `.git/hooks/*` and local git config written by `gantry hooks install`. Never write files into a target repo's working tree.
- **Process I/O:** hooks and the MCP server log to stderr only. stdout is reserved for protocol / JSON output.
- **Fail open:** git hooks and Claude Code hooks must never block a commit or a tool call because Gantry failed. Catch, log to `<dataDir>/logs/`, exit 0.
- **Worker guard:** if env `GANTRY_WORKER=1`, every hook entry point exits 0 immediately with no output.
- **Dependencies:** only those in section 2 without justification in the PR.

## 2. Approved dependencies

Runtime: `oxc-parser`, `oxc-resolver`, `better-sqlite3`, `sqlite-vec` (pin exact version), `@modelcontextprotocol/sdk`, `zod`, `commander`, `ignore`, `picomatch`, `@huggingface/transformers`, `@parcel/watcher`, `ws`, `@ast-grep/napi`, `sigma`, `graphology`, `graphology-layout-forceatlas2`, `elkjs`, `react`, `react-dom`, `3d-force-graph`, `three`, `three-spritetext`. Later only: `ts-morph`.
Explorer 3D map (`packages/explorer/web`, lazy chunk only): `3d-force-graph` gives the orbit camera, picking and link rendering for the `map-3d` view; `three` is its renderer and draws the workspace islands and bundled arcs; `three-spritetext` makes the always-facing text labels. The default `city` style of the same view is a plain `three` scene (instanced boxes, tube arches, `OrbitControls` from `three/examples`, DOM labels) on the 2D project map's layout: no new dependency; `style=islands` selects the island rendering above.
Dev: `typescript`, `vitest`, `@biomejs/biome`, `tsup`, `tsx`, `vite`, `@vitejs/plugin-react`, `playwright` (explorer smoke tests only), `@types/three`.

## 3. Repo layout

```
architecture-visualization-cc-plugin/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json  vitest.config.ts
  packages/core/       indexing library (no CLI, no MCP)
    src/paths/ config/ workspace/ discover/ parse/ hash/ resolve/ store/ heal/
        search/ embed/ describe/ dup/ advice/ adapters/ review/ types.ts index.ts
  packages/cli/        `gantry` binary (commander), hook entry points, git hook installer, shim
  packages/mcp/        MCP stdio server
  packages/explorer/   server/ (http + ws for `gantry map`) and web/ (Vite + React)
  plugin/              Claude Code plugin directory (what gets installed)
    .claude-plugin/plugin.json  skills/  agents/  hooks/hooks.json  .mcp.json  bin/gantry  dist/
  fixtures/            synthetic repos for tests (see section 13)
  evals/               labelled-set scripts, seeded duplicates, recorded sessions, eval scripts (private data in evals/private/, git-ignored)
  docs/spikes/         M0 reports
  docs/milestones/     milestone reports
```

## 4. Paths and data

- Worktree root: `git rev-parse --show-toplevel`. `worktreeHash` = first 16 hex chars of sha256(realpath(root)).
- Data dir: `${CLAUDE_PLUGIN_DATA}/repos/<worktreeHash>/` when `CLAUDE_PLUGIN_DATA` is set, else `~/.gantry/data/repos/<worktreeHash>/`. Contents: `gantry.db`, `parse-cache.db` (disposable per-file parse results keyed by path and content hash; a pure accelerator that is not part of the store schema and is safe to delete), `config.json`, `catalog/`, `logs/`, `models/` (embedding model cache may live in `~/.gantry/models/` instead, shared).
- Global config: `~/.gantry/config.json`. Shim: `~/.gantry/bin/gantry`.
- `core/paths`: `resolvePaths(cwd: string): GantryPaths` returning `{ root, worktreeHash, dataDir, dbPath, configPath, catalogDir, logsDir, globalConfigPath, shimPath }`.
- Nested worktrees under the repo (e.g. `.claude/worktrees/*`) are excluded from discovery of the parent.

## 5. Config (zod, `core/config`)

Project config (`<dataDir>/config.json`) is deep-merged over global (`~/.gantry/config.json`) over defaults.

```ts
type TaskName =
  | "describe.init"
  | "describe.sync"
  | "describe.precommit"
  | "describe.retry"
  | "overview"
  | "explain";
type GantryConfig = {
  precommit: { mode: "off" | "timeboxed" | "strict"; budgetMs: number; maxFunctions: number }; // off, 8000, 50
  routing: Record<TaskName, { model: "haiku" | "sonnet" | "opus"; effort: "low" | "medium" | "high" }>;
  exclude: string[]; // extra globs, added to built-ins
  workspaces: { overrides: Record<string, { kind?: "app" | "package" }> };
  duplicates: {
    mode: "warn" | "block";
    ignore: string[];
    thresholds: { nearJaccard: number; codeVector: number; semantic: number };
  }; // 0.85, 0.96 (measured in M0), 0.60 (measured in M0): initial values, to be re-fit in M2 (#32)
  backlogReminderThreshold: number; // 100
  renameSuggestions: boolean; // false (measured in M0: Haiku flagged 0 of 23 misleading names, so precision is not measurable; stays false)
  views: { slices: string[] }; // ["apps/*/src/features/*", "apps/*/src/modules/*", "packages/*"]
};
```
Routing defaults: `describe.init|sync|precommit` haiku/low, `describe.retry` sonnet/low, `overview` sonnet/low, `explain` sonnet/medium.

**Built-in excludes:** `node_modules`, `dist`, `build`, `out`, `.next`, `.output`, `.turbo`, `.vercel`, `.wrangler`, `coverage`, `**/*.d.ts`, `**/*.gen.ts`, `**/routeTree.gen.ts`, nested worktrees, plus sensitive files `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `.npmrc`, `credentials*`, `secrets*`, `*.tfvars`. Everything git ignores is excluded. Only `.ts .tsx .mts .cts` are parsed.

## 6. Stable IDs

- Workspace `ws:<package name>` (e.g. `ws:@acme/ui`); root package `ws:.`
- File `file:<repo-relative posix path>`
- Symbol `sym:<path>#<name>`; class members `sym:<path>#<Class>.<member>`; default export without a name `#default`; a second symbol with the same id in one file gets `~2`, `~3` by source order.
- Route `route:<ws>:<path>`; endpoint `ep:<ws>:<METHOD> <path>` or `ep:<ws>:rpc <procedure.path>` or `ep:<ws>:fn <exportName>`; table `table:<name>`.

## 7. Core types (`core/src/types.ts`)

```ts
export type Layer = "main" | "working";
export type SymbolKind =
  | "function"
  | "method"
  | "component"
  | "hook"
  | "class"
  | "type"
  | "interface"
  | "enum"
  | "const";
export interface SymbolRecord {
  id: string;
  fileId: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  signature: string;
  startLine: number;
  endLine: number;
  loc: number;
  complexity: number;
  stmtCount: number;
  exactHash: string;
  shapeHash: string;
  minhash: Uint32Array; // 64 permutations
}
export type EdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "renders"
  | "uses_hook"
  | "extends"
  | "implements"
  | "references_type"
  | "depends_on"
  | "serves"
  | "handles"
  | "requests"
  | "reads"
  | "writes"
  | "similar_to";
export interface EdgeRecord {
  src: string;
  dst: string;
  kind: EdgeKind;
  confidence: "high" | "low";
  count: number;
  evidence: string[];
  fileId: string;
}
export interface FactSheet {
  contentKey: string;
  id: string;
  path: string;
  kind: SymbolKind;
  signature: string;
  doc: string | null;
  callees: string[];
  returnType: string | null;
  body: string;
} // body trimmed to 1,500 chars
export interface Description {
  behavior: string;
  searchTerms: string[];
  nameFits: boolean;
  suggestedName?: string;
}
```
**Function-like kinds** (get descriptions, duplicate checks): function, method, component, hook. A component is a PascalCase function returning JSX; a hook is a function named `use[A-Z]…`.
**contentKey** = `<exactHash>:<PROMPT_MAJOR>`; `PROMPT_MAJOR` starts at `p1`.

## 8. Description schema and checks

JSON Schema (used for `--json-schema`, MCP submit validation and tests): `behavior` string, ≤ 25 words and ≤ 200 chars; `searchTerms` 1–6 strings, each ≤ 30 chars; `nameFits` boolean; `suggestedName` required iff `nameFits` is false, must match `^[A-Za-z_$][\w$]*$`.
Checks run per function, in order: (1) schema; (2) length limits; (3) identifier check: every camelCase/PascalCase/snake_case token in `behavior` must appear in the fact sheet (excluding a stop-list of English words); (4) injection filter: reject or strip URLs and imperative text addressed to agents (patterns such as "ignore previous", "you must", "AI agents", "assistant", "delete", "run the"), then re-check length. A failed function is re-queued; after 2 failures it is routed to `describe.retry`.
The host repairs over-length `behavior` before check (2) fails the function (measured in M0): Haiku exceeded 25 words on 3 of 10 descriptions in the worker spike, and Sonnet on 4 of 20 retries in the describe spike, so the host truncates or re-asks once rather than trusting the model to count (the word limit is not expressible in the JSON Schema). Schema failures and missing `structured_output` go to the backlog.
Description prompt v1 (`PROMPT_MAJOR = p1`, measured in M0): `packages/core/src/describe/prompts/p1.md`, shared by the headless worker and the describer agent. With it Haiku/low passed schema 100%, 25-word limit 100% and identifier check 100% on 200 functions (measured in M0).
Templates without a model: re-exports, barrel files, type aliases, and one-statement functions (`Returns <expression>.`), provenance `template`.

## 9. SQLite schema v1 (`core/src/store/schema.sql`)

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);            -- schema_version, head_sha, indexed_at, last_refresh_at, vec_available, embed_model, embed_dim
CREATE TABLE workspaces(id TEXT PRIMARY KEY, name TEXT, dir TEXT, kind TEXT CHECK(kind IN ('app','package','unknown')),
  frameworks TEXT, deps TEXT, exports_map TEXT);                 -- json columns
CREATE TABLE files(id TEXT, layer TEXT CHECK(layer IN ('main','working')), path TEXT, workspace_id TEXT,
  content_hash TEXT, mtime_ms INTEGER, deleted INTEGER DEFAULT 0, PRIMARY KEY(id, layer));
CREATE TABLE symbols(id TEXT, layer TEXT, file_id TEXT, name TEXT, kind TEXT, exported INTEGER, signature TEXT,
  start_line INTEGER, end_line INTEGER, loc INTEGER, complexity INTEGER, stmt_count INTEGER,
  exact_hash TEXT, shape_hash TEXT, minhash BLOB, PRIMARY KEY(id, layer));
CREATE TABLE edges(src TEXT, dst TEXT, kind TEXT, layer TEXT, confidence TEXT, count INTEGER, evidence TEXT, file_id TEXT,
  PRIMARY KEY(src, dst, kind, layer));
CREATE INDEX symbols_file ON symbols(file_id, layer);            -- per-file replace without a table scan
CREATE INDEX edges_file ON edges(file_id, layer);
CREATE TABLE descriptions(content_key TEXT PRIMARY KEY, behavior TEXT, search_terms TEXT, name_fits INTEGER,
  suggested_name TEXT, provenance TEXT, model TEXT, prompt_version TEXT, created_at TEXT);
CREATE TABLE backlog(content_key TEXT PRIMARY KEY, symbol_id TEXT, priority INTEGER, status TEXT
  CHECK(status IN ('pending','claimed','failed')), claimed_by TEXT, claimed_at TEXT, attempts INTEGER DEFAULT 0, last_error TEXT);
CREATE TABLE usage_log(id INTEGER PRIMARY KEY, at TEXT, task TEXT, model TEXT, effort TEXT, functions INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cost_estimate_usd REAL, source TEXT);
CREATE TABLE dismissals(a TEXT, b TEXT, reason TEXT, PRIMARY KEY(a, b));
CREATE TABLE overviews(node_id TEXT PRIMARY KEY, text TEXT, input_key TEXT, model TEXT, created_at TEXT);
CREATE TABLE layouts(view TEXT, node_id TEXT, x REAL, y REAL, PRIMARY KEY(view, node_id));
CREATE VIRTUAL TABLE fts_symbols USING fts5(symbol_id UNINDEXED, name_tokens, suggested_name, path, behavior, search_terms);
-- migration v2 (embeddings; D = 768 for the M0 model, so the dimension is known):
-- CREATE VIRTUAL TABLE vec_descriptions USING vec0(content_key TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine);
-- CREATE VIRTUAL TABLE vec_code USING vec0(content_key TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine);
--   records meta.embed_model and meta.embed_dim; a changed model or dimension drops and recreates both tables and re-embeds.
--   `openStore` loads sqlite-vec first and writes meta.vec_available (1 or 0); if it cannot load, migration v2 creates no
--   tables, everything except vector search keeps working, and `ensureVecTables` creates them later where it can.
-- migration v3 (pages view): adapter_nodes(id, layer, kind, ws, label, file_id, data), PRIMARY KEY(id, layer)
```
Effective view = working rows override main rows for the same file id; a working `files` row with `deleted=1` hides the main file. WAL mode; writers take an exclusive lock via `BEGIN IMMEDIATE` with a 5 s busy timeout.
Backlog priority: exported functions and route/entry files 0, other exported 1, local 2.

## 10. CLI (`packages/cli`, binary `gantry`)

| Command                                                                                                            | Behavior                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gantry init [--estimate] [--exports-first]`                                                                       | Full deterministic index; with `--estimate` prints function count, templated count, projected tokens (about 950 in including cache and 250 out per function (measured in M0)), batches of 40 and rounds of 4; no model calls ever |
| `gantry index [--files <p...>] [--layer main\|working] [--dump]`                                                   | Deterministic index; `--dump` prints the sorted graph JSON (used by snapshot tests)                                                                                                                                               |
| `gantry heal [--from <sha>]`                                                                                       | Reconcile main graph to HEAD (section 11)                                                                                                                                                                                         |
| `gantry search <q> [--kind] [--json]`, `gantry node <id\|path:line> [--json]`                                      | Lookups                                                                                                                                                                                                                           |
| `gantry usage [--json]`, `gantry backlog [--json]`                                                                 | Usage summary; backlog counts                                                                                                                                                                                                     |
| `gantry hooks install`, `gantry hooks uninstall`, `gantry uninstall [--keep-data]`                                 | Section 12                                                                                                                                                                                                                        |
| `gantry hook <session-start\|post-tool-use\|pre-commit\|pre-push\|post-checkout\|post-merge\|post-rewrite> [args]` | Hook entry points                                                                                                                                                                                                                 |
| `gantry describe --staged`                                                                                         | Pre-commit describer (timeboxed/strict modes only)                                                                                                                                                                                |
| `gantry map [--port] [--no-open]`                                                                                  | Start explorer server                                                                                                                                                                                                             |
| `gantry review <base>...<head> \| --pr <n> [--json] [--open]`                                                      | Review data / open view                                                                                                                                                                                                           |
| `gantry trace <target> [--json]`                                                                                   | Page → API → table chain (M6)                                                                                                                                                                                                     |
| `gantry config get\|set <key> [value]`                                                                             | Project config                                                                                                                                                                                                                    |

**Estimate formula (measured in M0, headless Haiku/low on 200 real functions):** `inputTokens = 950 × toDescribe`, `outputTokens = 250 × toDescribe`, `batches = ceil(toDescribe / 40)`, `rounds = ceil(batches / 4)`. Sequential headless time is about 0.96 s per function (about 62 functions per minute, derived from 60 / 0.96). The worker spike's 125–165 output tokens per function came from short synthetic functions and is not used; the 4-at-a-time wall times were not measured with parallel calls. Describer-subagent (Path B) throughput is not measured; do not print a subagent time estimate until it is (see `docs/spikes/GO-NO-GO.md`).

## 11. Index lifecycle

- **Working layer:** updated (a) by the PostToolUse hook for the edited file, (b) by lazy refresh before every MCP call: `git status --porcelain=v1 -z` → re-index changed parseable files whose mtime differs from `files.mtime_ms`, (c) by the explorer watcher while `gantry map` runs.
- **Main layer / heal:** `meta.head_sha` vs `git rev-parse HEAD`; changed files = `git diff --name-status <old> <new>`; re-index those into main, delete removed, clear their working rows if the working tree now matches. Run by post-checkout, post-merge, post-rewrite, SessionStart and `gantry heal`.
- **Descriptions:** keyed by contentKey; any symbol whose contentKey has no description goes to the backlog. Never call a model during heal.
- **Pre-commit:** read staged blobs only (`git diff --cached --name-only -z` + `git show :<path>`), parse them in memory, run local duplicate + import checks, print findings to stderr (visible to Claude in Bash output) and enqueue new functions. Modes `timeboxed`/`strict` additionally run `gantry describe --staged`. Always exit 0.

## 12. Git hooks install

- Hooks: pre-commit, pre-push, post-checkout, post-merge, post-rewrite. Each is a 3-line sh script: `[ "$GANTRY_WORKER" = 1 ] || "$HOME/.gantry/bin/gantry" hook <name> "$@" </dev/null || true`, then chaining (below), then `exit 0`. `GANTRY_WORKER=1` skips only the Gantry call, so a chained user hook still runs; Gantry's stdin is `/dev/null` so the chained hook still receives git's stdin.
- If `core.hooksPath` is unset: write into `.git/hooks/` (use `git rev-parse --git-path hooks`); if a hook file already exists, rename it `<name>.gantry-prev` and chain to it.
- If `core.hooksPath` is set (husky/lefthook): create `<dataDir>/hooks/` wrapper scripts that run Gantry then exec the original `<hooksPath>/<name>` with the same args, and set local `git config core.hooksPath <dataDir>/hooks`, saving the previous value in `meta.prev_hooks_path`.
- Shim `~/.gantry/bin/gantry`: sh script with absolute paths to `node` and `plugin/dist/cli.js` resolved at install; if the target is missing it exits 0.
- `gantry hooks uninstall` / `gantry uninstall` restore everything exactly.

## 13. Fixtures and evals

`fixtures/single-pkg` (one package.json, ~15 files), `fixtures/pnpm-turbo` (apps/web TanStack Router file routes, apps/api Hono + oRPC, packages/db Drizzle sqliteTable, packages/ui, packages/utils with a misleading-name duplicate pair), `fixtures/nx` (2 projects + project.json). `evals/seeded-duplicates/` holds 10 cases (3 with misleading names) each as `{ existing, newCode, expected }`, written by hand (no Devprentice code). `evals/labelled/` holds the scripts that build the 200-function labelled set from Devprentice; the set itself (JSONL: factSheet, label behavior, nameFits) lives only in git-ignored `evals/private/`.

## 14. Hook I/O contracts

- **PostToolUse** (matcher `Write|Edit|MultiEdit`): stdin JSON with `tool_name`, `tool_input.file_path`, `cwd`. On findings, stdout exactly `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<≤600 chars>"}}`; on none, no stdout. Budget 1,500 ms warm on 2,000 files.
- **SessionStart:** heal, then print one plain-text line only if the index is missing or backlog ≥ `backlogReminderThreshold`.

## 15. MCP server (`packages/mcp`, server name `gantry`)

Every response is one JSON text block ≤ 4,000 chars; descriptions go in a field named `untrusted_description`. Lazy refresh (section 11) runs before each call.

| Tool                                           | Input                                                                                                                   | Output                                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gantry_find_similar`                          | `{ query?: string, code?: string, kind?: string, workspace?: string, limit?: number ≤10 }` (one of query/code required) | `{ matches: [{ id, name, kind, path, line, signature, import_path, tier: "exact"\|"near"\|"code_vector"\|"semantic", score, untrusted_description, advice: { situation, action, inline } }] }` |
| `gantry_browse`                                | `{ target: string }` (id or path)                                                                                       | `{ items: [{ id, name, kind, exported, path, line, untrusted_description }], catalog_path }`                                                                                                   |
| `gantry_search`                                | `{ query, kind?, workspace?, exported?, limit? }`                                                                       | `{ hits: [...] }`                                                                                                                                                                              |
| `gantry_node`                                  | `{ target: string }`                                                                                                    | `{ node, untrusted_description, signature, fan_in, fan_out, neighbors: { [kind]: string[] } }`                                                                                                 |
| `gantry_open_view`                             | `{ view, focus?, filters? }`                                                                                            | `{ url }`                                                                                                                                                                                      |
| `gantry_impact`                                | `{ paths?, symbol?, range? }`                                                                                           | `{ changed, callers_by_hop, crossings, notes }`                                                                                                                                                |
| `gantry_trace`                                 | `{ target }`                                                                                                            | `{ chain: [...] }`                                                                                                                                                                             |
| `gantry_get_overview` / `gantry_save_overview` | `{ node_id }` / `{ node_id, text }`                                                                                     | cached overview / saved                                                                                                                                                                        |
| `gantry_claim_batch` (describer only)          | `{ worker_id, size ≤ 40 }`                                                                                              | `{ batch_id, items: FactSheet[] }`                                                                                                                                                             |
| `gantry_submit_descriptions` (describer only)  | `{ batch_id, results: [{ content_key, description }] }`                                                                 | `{ accepted, rejected: [{ content_key, reason }] }`                                                                                                                                            |

Claims expire after 10 minutes and return to `pending`. Tool names as seen by Claude: `mcp__plugin_gantry_gantry__<tool>`.

## 16. Plugin (`plugin/`)

- `plugin.json`: name `gantry`, version, description.
- Skills: `reuse-first` (model-invoked, short description), `init`, `sync`, `map`, `review`, `explain`, `overview` (user-invoked only; confirm the exact frontmatter key in the Claude Code skills docs).
- Agents: `describer` (`model: haiku`, `effort: low`, `tools: mcp__plugin_gantry_gantry__gantry_claim_batch, mcp__plugin_gantry_gantry__gantry_submit_descriptions`, `background: true`, `maxTurns: 60`); `explainer` (`model: sonnet`, `effort: medium`, read-only Gantry tools).
- `hooks/hooks.json`: SessionStart → `"${CLAUDE_PLUGIN_ROOT}/bin/gantry" hook session-start`; PostToolUse matcher `Write|Edit|MultiEdit` → `... hook post-tool-use`.
- `.mcp.json`: `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`.
- Headless worker recipe (pre-commit modes only; confirmed in M0 on Claude Code CLI 2.1.325 with a claude.ai login, verdict WORKER OK): `GANTRY_WORKER=1 claude -p --model <m> --effort <e> --safe-mode --tools "" --disallowedTools "mcp__*" --strict-mcp-config --system-prompt-file <file> --no-session-persistence --output-format json --json-schema '<inline>'`, stdin = fact sheets (measured in M0). All flags work together unchanged.
  - `--json-schema` is mandatory (measured in M0): without it there is no `structured_output` (0 of 2 live runs) and no `StructuredOutput` tool. Read `structured_output`; if it is missing (model or schema failure) the functions go back to the backlog.
  - Keep both `--safe-mode` and `--strict-mcp-config` (measured in M0): each alone keeps MCP servers out; dropping both loaded 23 MCP servers (user plugin servers and account connectors). `GANTRY_WORKER=1` stays as the third line of defence. `--disallowedTools "mcp__*"` and `--no-session-persistence` had no visible effect on the loaded sets and stay as defence in depth.
  - `--system-prompt-file` works but is not listed in `claude --help`; re-check it on each CLI upgrade, fall back to `--system-prompt "$(cat <file>)"`.
  - Unset `CLAUDE_CODE_EFFORT_LEVEL` in the child env (measured in M0): it overrides `--effort` (about 7x output tokens and about 4x wall time with `max`). An invalid `--effort` only warns.
  - Binary resolution order (measured in M0: `claude` is not on `PATH` when run from the desktop app): config override, then `$CLAUDE_CODE_EXECPATH`, then `claude` on `PATH`.
  - Gate on `claude auth status` (prints JSON): proceed only when `loggedIn === true`; `false` means "no worker, enqueue only", not an error. Only a claude.ai login was tested; API-key, Bedrock and Vertex logins were not.
  - Budget (measured in M0, Haiku/low): about 3.3 s cold start, 1 / 10 / 40 sheets in about 2.7 / 7.0 / 16.3 s (median of 3), so about 0.4 s per extra function. Batches of 10 to 40 per call; 40 is the spec batch size. The host enforces the 25-word limit (section 8).

## 17. Duplicate tiers (initial thresholds, measured in M0 and re-fit in M2 (#32))

| Tier        | Rule                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| exact       | same `exactHash`, `stmtCount ≥ 3`                                                    |
| near        | same `shapeHash` or MinHash Jaccard ≥ 0.85, `stmtCount ≥ 6`, same parameter count ±1 |
| code_vector | cosine ≥ 0.96 (measured in M0) between normalized-code embeddings                    |
| semantic    | cosine ≥ 0.60 (measured in M0) between description embeddings, compatible signature  |

Embedding model (measured in M0): `jinaai/jina-embeddings-v2-base-code` (q8 ONNX, mean pooling, L2-normalized) for both descriptions and normalized code, dimension D = 768, so `vec_descriptions` and `vec_code` are `float[768]` (section 9 migration v2). The two thresholds are initial values from a small hand-written set (15 + 15 pairs per task), not final: code_vector 0.96 gave recall 93% and 7% false positives (1 of 15), semantic 0.60 gave recall 80% and 7% false positives; the old 0.92 and 0.85 gave 33% false positives and 0% recall. Re-fit both in M2 (#32) on real LLM-written descriptions.
Normalizer for `vec_code` (decided in M0, approved by the operator on 2026-11-14): rename local identifiers (parameters, `const`/`let` names, the function name) to `v1, v2, …`, drop comments, collapse whitespace, replace string and template literals with `"s"`, but keep property names after `.` and well-known globals (and any other identifier not declared inside the function, such as an imported helper). The function's own name is renamed too, recursive calls included. Renaming everything made `capitalize` and `decapitalize` identical (cosine 1.000); keeping them raised Jina's best accuracy from 93.3% to 96.7% (measured in M0).

Compare only within kind family (function/method together; component; hook). Skip tests, fixtures, generated files, barrels and `duplicates.ignore`. Dismissed pairs never alert. Budget: < 1 in 10 hook alerts false; alerts on < 5% of edits.

## 18. Reuse advice (deterministic)

"Reachable" = exported from the package's `exports` map (or `main`/`types` when no map). Situations: (1) reachable and caller's workspace depends on it → `inline: true`, action "Import it: import { X } from '<pkg>'"; (2) reachable, not a dependency → suggestion "Add the dependency" unless it creates a workspace cycle or a server/client boundary crossing (`"use client"` / server-only markers); (3) not reachable → suggestion "Export it or move it to a shared package"; (4) lives in another app → suggestion "Move it to a shared package"; (5) `nameFits=false` → suggestion "Rename to <suggestedName>" (only if config `renameSuggestions` is true); (6) new import of an undeclared workspace or npm package, or deep import past `exports` → `inline: true`, action "Declare it in <pkg>/package.json".

## 19. Definition of done (every issue)

1. Acceptance criteria met. 2. `pnpm check` passes. 3. New behavior has tests. 4. PR description: summary, the issue's Verify command output, screenshots for UI work (never showing private test-bed code). 5. No TODOs left for in-scope items. 6. The PR says `Closes #<issue>`. Milestone-level regression runs happen in the milestone's final issue, not in every issue.
