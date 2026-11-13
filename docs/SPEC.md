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

Runtime: `oxc-parser`, `oxc-resolver`, `better-sqlite3`, `sqlite-vec` (pin exact version), `@modelcontextprotocol/sdk`, `zod`, `commander`, `ignore`, `picomatch`, `@huggingface/transformers`, `@parcel/watcher`, `ws`, `@ast-grep/napi`, `sigma`, `graphology`, `graphology-layout-forceatlas2`, `elkjs`, `react`, `react-dom`. Later only: `ts-morph`.
Dev: `typescript`, `vitest`, `@biomejs/biome`, `tsup`, `tsx`, `vite`, `@vitejs/plugin-react`, `playwright` (explorer smoke tests only).

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
- Data dir: `${CLAUDE_PLUGIN_DATA}/repos/<worktreeHash>/` when `CLAUDE_PLUGIN_DATA` is set, else `~/.gantry/data/repos/<worktreeHash>/`. Contents: `gantry.db`, `config.json`, `catalog/`, `logs/`, `models/` (embedding model cache may live in `~/.gantry/models/` instead, shared).
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
  }; // 0.85, 0.92, 0.85
  backlogReminderThreshold: number; // 100
  renameSuggestions: boolean; // false until M0 measures nameFits precision
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
Templates without a model: re-exports, barrel files, type aliases, and one-statement functions (`Returns <expression>.`), provenance `template`.

## 9. SQLite schema v1 (`core/src/store/schema.sql`)

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);            -- schema_version, head_sha, indexed_at, last_refresh_at
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
-- created after the embedding dimension D is known (migration v2):
-- CREATE VIRTUAL TABLE vec_descriptions USING vec0(content_key TEXT PRIMARY KEY, embedding float[D]);
-- CREATE VIRTUAL TABLE vec_code USING vec0(content_key TEXT PRIMARY KEY, embedding float[D]);
-- migration v3 (pages view): adapter_nodes(id, layer, kind, ws, label, file_id, data), PRIMARY KEY(id, layer)
```
Effective view = working rows override main rows for the same file id; a working `files` row with `deleted=1` hides the main file. WAL mode; writers take an exclusive lock via `BEGIN IMMEDIATE` with a 5 s busy timeout.
Backlog priority: exported functions and route/entry files 0, other exported 1, local 2.

## 10. CLI (`packages/cli`, binary `gantry`)

| Command                                                                                                            | Behavior                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gantry init [--estimate] [--exports-first]`                                                                       | Full deterministic index; with `--estimate` prints function count, templated count, projected tokens (500 in, 150–200 out per function until M0 measures it), batches of 40 and rounds of 4; no model calls ever |
| `gantry index [--files <p...>] [--layer main\|working] [--dump]`                                                   | Deterministic index; `--dump` prints the sorted graph JSON (used by snapshot tests)                                                                                                                              |
| `gantry heal [--from <sha>]`                                                                                       | Reconcile main graph to HEAD (section 11)                                                                                                                                                                        |
| `gantry search <q> [--kind] [--json]`, `gantry node <id\|path:line> [--json]`                                      | Lookups                                                                                                                                                                                                          |
| `gantry usage [--json]`, `gantry backlog [--json]`                                                                 | Usage summary; backlog counts                                                                                                                                                                                    |
| `gantry hooks install`, `gantry hooks uninstall`, `gantry uninstall [--keep-data]`                                 | Section 12                                                                                                                                                                                                       |
| `gantry hook <session-start\|post-tool-use\|pre-commit\|pre-push\|post-checkout\|post-merge\|post-rewrite> [args]` | Hook entry points                                                                                                                                                                                                |
| `gantry describe --staged`                                                                                         | Pre-commit describer (timeboxed/strict modes only)                                                                                                                                                               |
| `gantry map [--port] [--no-open]`                                                                                  | Start explorer server                                                                                                                                                                                            |
| `gantry review <base>...<head> \| --pr <n> [--json] [--open]`                                                      | Review data / open view                                                                                                                                                                                          |
| `gantry trace <target> [--json]`                                                                                   | Page → API → table chain (M6)                                                                                                                                                                                    |
| `gantry config get\|set <key> [value]`                                                                             | Project config                                                                                                                                                                                                   |

## 11. Index lifecycle

- **Working layer:** updated (a) by the PostToolUse hook for the edited file, (b) by lazy refresh before every MCP call: `git status --porcelain=v1 -z` → re-index changed parseable files whose mtime differs from `files.mtime_ms`, (c) by the explorer watcher while `gantry map` runs.
- **Main layer / heal:** `meta.head_sha` vs `git rev-parse HEAD`; changed files = `git diff --name-status <old> <new>`; re-index those into main, delete removed, clear their working rows if the working tree now matches. Run by post-checkout, post-merge, post-rewrite, SessionStart and `gantry heal`.
- **Descriptions:** keyed by contentKey; any symbol whose contentKey has no description goes to the backlog. Never call a model during heal.
- **Pre-commit:** read staged blobs only (`git diff --cached --name-only -z` + `git show :<path>`), parse them in memory, run local duplicate + import checks, print findings to stderr (visible to Claude in Bash output) and enqueue new functions. Modes `timeboxed`/`strict` additionally run `gantry describe --staged`. Always exit 0.

## 12. Git hooks install

- Hooks: pre-commit, pre-push, post-checkout, post-merge, post-rewrite. Each is a 3-line sh script: `[ "$GANTRY_WORKER" = 1 ] && exit 0; "$HOME/.gantry/bin/gantry" hook <name> "$@" || true; exit 0`, plus chaining (below).
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
- Headless worker recipe (pre-commit modes only): `GANTRY_WORKER=1 claude -p --model <m> --effort <e> --safe-mode --tools "" --disallowedTools "mcp__*" --strict-mcp-config --system-prompt-file <file> --no-session-persistence --output-format json --json-schema '<inline>'`, stdin = fact sheets; read `structured_output` (may be missing → backlog); unset `CLAUDE_CODE_EFFORT_LEVEL`; check `claude auth status` first. M0 confirms which flags work together.

## 17. Duplicate tiers (initial thresholds, tuned in M2)

| Tier        | Rule                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| exact       | same `exactHash`, `stmtCount ≥ 3`                                                    |
| near        | same `shapeHash` or MinHash Jaccard ≥ 0.85, `stmtCount ≥ 6`, same parameter count ±1 |
| code_vector | cosine ≥ 0.92 between normalized-code embeddings                                     |
| semantic    | cosine ≥ 0.85 between description embeddings, compatible signature                   |

Compare only within kind family (function/method together; component; hook). Skip tests, fixtures, generated files, barrels and `duplicates.ignore`. Dismissed pairs never alert. Budget: < 1 in 10 hook alerts false; alerts on < 5% of edits.

## 18. Reuse advice (deterministic)

"Reachable" = exported from the package's `exports` map (or `main`/`types` when no map). Situations: (1) reachable and caller's workspace depends on it → `inline: true`, action "Import it: import { X } from '<pkg>'"; (2) reachable, not a dependency → suggestion "Add the dependency" unless it creates a workspace cycle or a server/client boundary crossing (`"use client"` / server-only markers); (3) not reachable → suggestion "Export it or move it to a shared package"; (4) lives in another app → suggestion "Move it to a shared package"; (5) `nameFits=false` → suggestion "Rename to <suggestedName>" (only if config `renameSuggestions` is true); (6) new import of an undeclared workspace or npm package, or deep import past `exports` → `inline: true`, action "Declare it in <pkg>/package.json".

## 19. Definition of done (every issue)

1. Acceptance criteria met. 2. `pnpm check` passes. 3. New behavior has tests. 4. PR description: summary, the issue's Verify command output, screenshots for UI work (never showing private test-bed code). 5. No TODOs left for in-scope items. 6. The PR says `Closes #<issue>`. Milestone-level regression runs happen in the milestone's final issue, not in every issue.
