// Generated from cache.sql by hand: cache.sql is not bundled by tsup, so the DDL lives here and cache.test.ts
// asserts it equals cache.sql (the same arrangement as the index's schema.ts).
export const TEAM_CACHE_SCHEMA = `CREATE TABLE change_sets(id TEXT PRIMARY KEY, repo TEXT, source TEXT, state TEXT, estimated INTEGER, confidence REAL, owner TEXT, title TEXT, pr INTEGER, ref TEXT, head_ref TEXT, base_branch TEXT, head_sha TEXT, links TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE change_set_nodes(change_set_id TEXT, node_id TEXT, PRIMARY KEY(change_set_id, node_id));
CREATE INDEX change_set_nodes_node ON change_set_nodes(node_id);
CREATE TABLE change_set_reach(change_set_id TEXT, node_id TEXT, hop INTEGER, tier TEXT, via_hub INTEGER, PRIMARY KEY(change_set_id, node_id));
CREATE INDEX change_set_reach_node ON change_set_reach(node_id);
CREATE TABLE inflight(change_set_id TEXT, symbol_id TEXT, payload TEXT, PRIMARY KEY(change_set_id, symbol_id));
CREATE TABLE team_views(id TEXT PRIMARY KEY, name TEXT, spec TEXT);
CREATE TABLE team_groups(id TEXT PRIMARY KEY, name TEXT, spec TEXT);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
`;
