import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeForEmbedding } from "../hash/index.js";
import { openStore } from "../store/index.js";
import {
  EMBED_DIM,
  EMBED_MODEL_ID,
  type Embedder,
  getEmbedder,
  knn,
  modelCacheDir,
  putVectors,
} from "./index.js";

/**
 * Tests that need the real model. They use the model already in the shared cache (`~/.gantry/models`)
 * and are skipped, not downloaded, when it is absent: `pnpm check` never touches the network.
 */
const cached = existsSync(join(modelCacheDir(), EMBED_MODEL_ID, "onnx", "model_quantized.onnx"));
if (!cached) {
  process.stderr.write(
    `embed: model ${EMBED_MODEL_ID} not found in ${modelCacheDir()}; skipping real-model tests ` +
      "(run `pnpm tsx docs/spikes/embed/run.ts` once to download it)\n",
  );
}

interface Pair {
  kind: "description" | "code";
  same: boolean;
  topic: string;
  a: string;
  b: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const pairs: Pair[] = readFileSync(join(here, "../../../../docs/spikes/embed/pairs.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Pair);

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
};

/** Best accuracy over all thresholds (score >= threshold predicts "same"), as in the M0 report. */
function bestAccuracy(same: number[], diff: number[]): number {
  let best = 0;
  for (const t of [...same, ...diff]) {
    const ok = same.filter((s) => s >= t).length + diff.filter((s) => s < t).length;
    best = Math.max(best, ok / (same.length + diff.length));
  }
  return best;
}

const whole = (s: string) => ({ start: 0, end: s.length });

describe.skipIf(!cached)("real model (jina-embeddings-v2-base-code, q8)", () => {
  let embedder: Embedder;
  beforeAll(async () => {
    embedder = await getEmbedder();
  }, 120_000);

  it("loads from the cache with D = 768 and returns unit-length vectors", async () => {
    expect(embedder.available).toBe(true);
    expect(embedder.dim).toBe(EMBED_DIM);
    const [v] = await embedder.embed(["function add(a, b) { return a + b; }"], "code");
    expect(v?.length).toBe(768);
    expect(dot(v as Float32Array, v as Float32Array)).toBeCloseTo(1, 3);
  });

  it("KNN returns a function's own vector first with cosine ~ 1", async () => {
    const store = openStore(":memory:");
    try {
      const codes: string[] = pairs
        .filter((p) => p.kind === "code")
        .map((p) => normalizeForEmbedding(p.a, whole(p.a), "ts"));
      codes.splice(0, codes.length, ...new Set(codes)); // distinct texts only: equal code shares one vector
      const vecs = await embedder.embed(codes, "code");
      putVectors(
        store,
        "vec_code",
        vecs.map((vector, i) => ({ contentKey: `k${i}:p1`, vector })),
      );
      for (const i of [0, 7, codes.length - 1]) {
        const hit = knn(store, "vec_code", vecs[i] as Float32Array, 3)[0];
        expect(hit?.contentKey).toBe(`k${i}:p1`);
        expect(hit?.cosine).toBeGreaterThan(0.999);
      }
    } finally {
      store.close();
    }
  });

  it("reproduces the M0 accuracy on pairs.jsonl within 2 points (code 96.7%, descriptions 90.0%)", async () => {
    const accuracy = async (kind: Pair["kind"], prep: (s: string) => string, as: "code" | "document") => {
      const ps = pairs.filter((p) => p.kind === kind);
      const va = await embedder.embed(
        ps.map((p) => prep(p.a)),
        as,
      );
      const vb = await embedder.embed(
        ps.map((p) => prep(p.b)),
        as,
      );
      const scores = ps.map((p, i) => ({
        same: p.same,
        s: dot(va[i] as Float32Array, vb[i] as Float32Array),
      }));
      return bestAccuracy(
        scores.filter((x) => x.same).map((x) => x.s),
        scores.filter((x) => !x.same).map((x) => x.s),
      );
    };
    const code = await accuracy("code", (s) => normalizeForEmbedding(s, whole(s), "ts"), "code");
    const desc = await accuracy("description", (s) => s, "document");
    process.stderr.write(
      `embed: pairs.jsonl best-threshold accuracy code ${(code * 100).toFixed(1)}%, descriptions ${(desc * 100).toFixed(1)}%\n`,
    );
    expect(code).toBeGreaterThanOrEqual(0.967 - 0.02);
    expect(desc).toBeGreaterThanOrEqual(0.9 - 0.02);
  }, 120_000);

  // Short snippets only (25.7 ms each): real bodies cost more, see bench.test.ts for realistic sizes.
  // Opt-in (about 30 s): GANTRY_EMBED_BENCH=1 pnpm vitest run packages/core/src/embed/model.test.ts
  it.skipIf(process.env.GANTRY_EMBED_BENCH !== "1")(
    "embeds 1,000 code snippets in under 30 s (acceptance)",
    async () => {
      const base = pairs
        .filter((p) => p.kind === "code")
        .flatMap((p) => [p.a, p.b])
        .map((s) => normalizeForEmbedding(s, whole(s), "ts"));
      const texts = Array.from({ length: 1000 }, (_, i) => `${base[i % base.length]} // ${i}`);
      const t0 = performance.now();
      const out = await embedder.embed(texts, "code");
      const ms = performance.now() - t0;
      process.stderr.write(
        `embed: 1000 code snippets in ${(ms / 1000).toFixed(2)} s (${(ms / 1000).toFixed(1)} ms each)\n`,
      );
      expect(out).toHaveLength(1000);
      expect(ms).toBeLessThan(30_000);
    },
    120_000,
  );
});
