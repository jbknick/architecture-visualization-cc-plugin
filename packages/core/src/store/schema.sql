CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE repos(name TEXT PRIMARY KEY, root TEXT, head_sha TEXT);
CREATE TABLE workspaces(id TEXT PRIMARY KEY, repo TEXT NOT NULL, name TEXT, dir TEXT, kind TEXT CHECK(kind IN ('app','package','unknown')),
  frameworks TEXT, deps TEXT, exports_map TEXT);
CREATE TABLE files(id TEXT, layer TEXT CHECK(layer IN ('main','working')), repo TEXT NOT NULL, path TEXT, workspace_id TEXT,
  content_hash TEXT, mtime_ms INTEGER, deleted INTEGER DEFAULT 0, directives TEXT, lang TEXT NOT NULL, PRIMARY KEY(id, layer));
CREATE TABLE symbols(id TEXT, layer TEXT, file_id TEXT, name TEXT, kind TEXT, exported INTEGER, signature TEXT,
  start_line INTEGER, end_line INTEGER, loc INTEGER, complexity INTEGER, stmt_count INTEGER,
  exact_hash TEXT, shape_hash TEXT, minhash BLOB, near_minhash BLOB, renamed_hash TEXT, lang TEXT NOT NULL, PRIMARY KEY(id, layer));
CREATE TABLE edges(src TEXT, dst TEXT, kind TEXT, layer TEXT, confidence TEXT, count INTEGER, evidence TEXT, file_id TEXT, level INTEGER, text_file_id TEXT, source TEXT,
  PRIMARY KEY(src, dst, kind, layer));
CREATE INDEX symbols_file ON symbols(file_id, layer);            -- per-file replace without a table scan
CREATE INDEX edges_file ON edges(file_id, layer);
CREATE TABLE adapter_nodes(id TEXT, layer TEXT CHECK(layer IN ('main','working')), kind TEXT, ws TEXT,
  label TEXT, file_id TEXT, data TEXT, PRIMARY KEY(id, layer));
CREATE INDEX adapter_nodes_file ON adapter_nodes(file_id, layer);
CREATE TABLE pending_files(session_id TEXT, repo TEXT NOT NULL, path TEXT, baseline TEXT, created_at TEXT,
  reindexed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, repo, path));
CREATE TABLE descriptions(content_key TEXT PRIMARY KEY, behavior TEXT, search_terms TEXT, name_fits INTEGER,
  suggested_name TEXT, provenance TEXT, model TEXT, prompt_version TEXT, created_at TEXT);
CREATE TABLE backlog(content_key TEXT PRIMARY KEY, symbol_id TEXT, priority INTEGER, status TEXT
  CHECK(status IN ('pending','claimed','failed')), claimed_by TEXT, claimed_at TEXT, attempts INTEGER DEFAULT 0, last_error TEXT);
CREATE TABLE usage_log(id INTEGER PRIMARY KEY, at TEXT, task TEXT, model TEXT, effort TEXT, functions INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cost_estimate_usd REAL, source TEXT);
CREATE TABLE overviews(node_id TEXT PRIMARY KEY, text TEXT, input_key TEXT, model TEXT, created_at TEXT);
CREATE VIRTUAL TABLE fts_symbols USING fts5(symbol_id UNINDEXED, name_tokens, suggested_name, path, behavior, search_terms);
