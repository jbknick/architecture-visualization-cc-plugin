import * as sqliteVec from "sqlite-vec";
import type { Database, Store } from "../store/repo.js";

/** Embedding model chosen in M0 (spec section 17) and the dimension of its vectors. */
export const EMBED_MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
export const EMBED_DIM = 768;

export type VecTable = "vec_descriptions" | "vec_code";
export const VEC_TABLES: readonly VecTable[] = ["vec_descriptions", "vec_code"];

/** Loads the sqlite-vec extension into `db`. Returns false (never throws) when it cannot be loaded. */
export function loadVec(db: Database): boolean {
  try {
    sqliteVec.load(db);
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

/** True when the extension is loaded on this connection. */
export function vecLoaded(db: Database): boolean {
  try {
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

/** Whether this process loaded sqlite-vec for the store (`meta.vec_available` is written by `openStore`). */
export function vecAvailable(store: Store): boolean {
  return store.getMeta("vec_available") === "1";
}

/** Vector to the BLOB sqlite-vec expects: little-endian float32, regardless of host byte order. */
export function vecToBlob(v: Float32Array): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i] as number, i * 4);
  return buf;
}

export function blobToVec(b: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(buf.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

const createSql = (table: VecTable, dim: number): string =>
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(content_key TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`;

function getMeta(db: Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)
    ?.value;
}

function putMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Creates both vec tables for `dim` and records `meta.embed_model` / `meta.embed_dim`. When the recorded
 * model or dimension differs, both tables are dropped and recreated empty (the caller re-embeds).
 * Returns true when the tables were (re)created from scratch or changed.
 */
function ensureOnDb(db: Database, dim: number, modelId: string): boolean {
  const model = getMeta(db, "embed_model");
  const recordedDim = getMeta(db, "embed_dim");
  let rebuilt = false;
  if (
    (model !== undefined && model !== modelId) ||
    (recordedDim !== undefined && recordedDim !== String(dim))
  ) {
    for (const t of VEC_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    rebuilt = true;
  }
  for (const t of VEC_TABLES) db.exec(createSql(t, dim));
  putMeta(db, "embed_model", modelId);
  putMeta(db, "embed_dim", String(dim));
  return rebuilt;
}

/**
 * Store migration v2 (called by the migration runner inside its transaction). Creates the vec tables for
 * the M0 model when sqlite-vec is loaded; otherwise does nothing, and `ensureVecTables` creates them later
 * on a machine where the extension works. The schema version is recorded either way.
 */
export function applyVecMigration(db: Database): void {
  if (!vecLoaded(db)) return;
  ensureOnDb(db, EMBED_DIM, EMBED_MODEL_ID);
}

/**
 * Creates `vec_descriptions` and `vec_code` if missing and records `meta.embed_model` and
 * `meta.embed_dim`. If the recorded model or dimension differs, drops and recreates both so the rows
 * get re-embedded. No-op when sqlite-vec is unavailable. Returns true when existing vectors were dropped.
 */
export function ensureVecTables(store: Store, dim: number, modelId: string = EMBED_MODEL_ID): boolean {
  if (!vecAvailable(store)) return false;
  return store.tx(() => ensureOnDb(store.db, dim, modelId));
}

/** Content keys already stored in `table`. */
export function storedKeys(store: Store, table: VecTable): Set<string> {
  if (!vecAvailable(store)) return new Set();
  try {
    const rows = store.db.prepare(`SELECT content_key FROM ${table}`).all() as { content_key: string }[];
    return new Set(rows.map((r) => r.content_key));
  } catch {
    return new Set();
  }
}

/** Replaces the vectors of `rows` in `table` (vec0 has no upsert: delete, then insert). */
export function putVectors(
  store: Store,
  table: VecTable,
  rows: { contentKey: string; vector: Float32Array }[],
) {
  if (!vecAvailable(store) || rows.length === 0) return;
  store.tx(() => {
    const del = store.db.prepare(`DELETE FROM ${table} WHERE content_key = ?`);
    const ins = store.db.prepare(`INSERT INTO ${table} (content_key, embedding) VALUES (?, ?)`);
    for (const r of rows) {
      del.run(r.contentKey);
      ins.run(r.contentKey, vecToBlob(r.vector));
    }
  });
}

/** The stored vector for `contentKey`, or undefined (no vectors, no such row, table missing). */
export function getVector(store: Store, table: VecTable, contentKey: string): Float32Array | undefined {
  if (!vecAvailable(store) || !VEC_TABLES.includes(table)) return undefined;
  try {
    const row = store.db.prepare(`SELECT embedding FROM ${table} WHERE content_key = ?`).get(contentKey) as
      | { embedding: Buffer }
      | undefined;
    return row ? blobToVec(row.embedding) : undefined;
  } catch {
    return undefined;
  }
}

/** Every stored vector of `table` by content key (one scan; for batch jobs such as the similar_to rebuild). */
export function allVectors(store: Store, table: VecTable): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!vecAvailable(store) || !VEC_TABLES.includes(table)) return out;
  try {
    const rows = store.db.prepare(`SELECT content_key, embedding FROM ${table}`).all() as {
      content_key: string;
      embedding: Buffer;
    }[];
    for (const r of rows) out.set(r.content_key, blobToVec(r.embedding));
  } catch {
    // table missing: no vectors
  }
  return out;
}

/**
 * K nearest vectors of `vector` in `table`, nearest first. `distance` is the cosine distance from vec0
 * (`1 - cosine`); `cosine` is the similarity. Returns [] when vectors are unavailable or the table is
 * empty or missing: every consumer must treat "no vectors yet" as "no neighbours".
 */
export function knn(
  store: Store,
  table: VecTable,
  vector: Float32Array,
  k: number,
): { contentKey: string; distance: number; cosine: number }[] {
  if (!vecAvailable(store) || !VEC_TABLES.includes(table) || k < 1) return [];
  try {
    const rows = store.db
      .prepare(
        `SELECT content_key, distance FROM ${table} WHERE embedding MATCH ? AND k = ${Math.floor(k)} ORDER BY distance`,
      )
      .all(vecToBlob(vector)) as { content_key: string; distance: number }[];
    return rows
      .map((r) => ({ contentKey: r.content_key, distance: r.distance, cosine: 1 - r.distance }))
      .sort((a, b) => a.distance - b.distance || (a.contentKey < b.contentKey ? -1 : 1));
  } catch {
    return [];
  }
}
