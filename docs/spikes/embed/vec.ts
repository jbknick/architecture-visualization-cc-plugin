/**
 * sqlite-vec spike. Usage: pnpm tsx docs/spikes/embed/vec.ts [dim=384] [rows=10000]
 * Loads sqlite-vec into better-sqlite3 via `sqliteVec.load(db)`, inserts random unit vectors into a vec0
 * table and times KNN top-10 queries.
 */
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const dim = Number(process.argv[2] ?? 384);
const rows = Number(process.argv[3] ?? 10_000);

function randomUnit(d: number): Float32Array {
  const v = new Float32Array(d);
  let n = 0;
  for (let i = 0; i < d; i++) {
    v[i] = Math.random() * 2 - 1;
    n += (v[i] as number) ** 2;
  }
  n = Math.sqrt(n);
  for (let i = 0; i < d; i++) v[i] = (v[i] as number) / n;
  return v;
}

const db = new Database(":memory:");
sqliteVec.load(db);
const { vec_version: vecVersion } = db.prepare("select vec_version() as vec_version").get() as {
  vec_version: string;
};

db.exec(`CREATE VIRTUAL TABLE vec_test USING vec0(content_key TEXT PRIMARY KEY, embedding float[${dim}])`);
const insert = db.prepare("INSERT INTO vec_test (content_key, embedding) VALUES (?, ?)");
const t0 = performance.now();
db.transaction(() => {
  for (let i = 0; i < rows; i++) insert.run(`k${i}`, Buffer.from(randomUnit(dim).buffer));
})();
const insertMs = performance.now() - t0;

const knn = db.prepare(
  "SELECT content_key, distance FROM vec_test WHERE embedding MATCH ? AND k = 10 ORDER BY distance",
);
knn.all(Buffer.from(randomUnit(dim).buffer)); // warm-up
const times: number[] = [];
for (let i = 0; i < 50; i++) {
  const q = Buffer.from(randomUnit(dim).buffer);
  const t = performance.now();
  const hits = knn.all(q);
  times.push(performance.now() - t);
  if (hits.length !== 10) throw new Error(`expected 10 hits, got ${hits.length}`);
}
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))] as number;
const avg = times.reduce((s, x) => s + x, 0) / times.length;

console.log(`node ${process.version} ${process.platform}/${process.arch}`);
console.log(`sqlite-vec ${vecVersion} loaded via sqliteVec.load(db) into better-sqlite3`);
console.log(`vec0 float[${dim}], ${rows} random unit vectors inserted in ${insertMs.toFixed(0)} ms`);
console.log(
  `KNN top-10 over ${rows} rows (50 queries): mean ${avg.toFixed(2)} ms, p50 ${pct(0.5).toFixed(2)} ms, p95 ${pct(0.95).toFixed(2)} ms, max ${times[times.length - 1]?.toFixed(2)} ms`,
);
console.log(`target < 50 ms: ${pct(0.95) < 50 ? "PASS" : "FAIL"}`);
db.close();
