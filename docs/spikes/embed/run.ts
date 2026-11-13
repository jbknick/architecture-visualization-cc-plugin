/**
 * Embedding bake-off. Usage: pnpm tsx docs/spikes/embed/run.ts [--models a,b] [--json out.json]
 * Downloads each candidate (q8 ONNX) into ~/.gantry/models on first use, then reports per model:
 * dimension, load time, ms/embedding (batch 32) and same-vs-different separation for descriptions,
 * raw code, and normalized code.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";
import {
  accuracyAt,
  cosine,
  normalizeCode,
  type Pair,
  parsePairs,
  type Separation,
  separation,
} from "./lib.ts";

const here = dirname(fileURLToPath(import.meta.url));
env.cacheDir = join(homedir(), ".gantry", "models");

interface Candidate {
  id: string;
  /** Prefix prepended to every text (model card rules). */
  prefix: string;
}

const CANDIDATES: Candidate[] = [
  { id: "Xenova/all-MiniLM-L6-v2", prefix: "" },
  { id: "Xenova/bge-small-en-v1.5", prefix: "" },
  // Both sides of a pair are stored documents, so "search_document:" (see nomic model card).
  { id: "nomic-ai/nomic-embed-text-v1.5", prefix: "search_document: " },
  { id: "jinaai/jina-embeddings-v2-base-code", prefix: "" },
];

type Embedder = (texts: string[]) => Promise<number[][]>;

async function load(c: Candidate): Promise<Embedder> {
  const extractor = await pipeline("feature-extraction", c.id, { dtype: "q8" });
  return async (texts) => {
    const out = await extractor(
      texts.map((t) => c.prefix + t),
      { pooling: "mean", normalize: true },
    );
    return out.tolist() as number[][];
  };
}

const ms = (t0: number) => performance.now() - t0;

async function msPerEmbedding(embed: Embedder, texts: string[]): Promise<number> {
  const batch = Array.from({ length: 32 }, (_, i) => texts[i % texts.length] as string);
  await embed(batch); // warm-up
  const runs = 5;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await embed(batch);
  return ms(t0) / (runs * batch.length);
}

export interface TaskResult extends Separation {
  /** Accuracy at the spec default threshold for this tier. */
  accuracyAtSpec: number;
  specThreshold: number;
  /** Cosine per pair, in pairs.jsonl order within the kind. */
  scores: { topic: string; same: boolean; cosine: number }[];
  /** Recall (same pairs >= t) and false-positive rate (different pairs >= t) per threshold. */
  sweep: { threshold: number; recall: number; falsePositiveRate: number }[];
}

interface ModelResult {
  model: string;
  dim?: number;
  coldLoadMs?: number;
  warmLoadMs?: number;
  msPerEmbeddingDescriptions?: number;
  msPerEmbeddingCode?: number;
  descriptions?: TaskResult;
  codeRaw?: TaskResult;
  codeNormalized?: TaskResult;
  codeNormalizedSemi?: TaskResult;
  skipped?: string;
}

async function withSpec(
  embed: Embedder,
  pairs: Pair[],
  map: (s: string) => string,
  spec: number,
): Promise<TaskResult> {
  const vecs = await embed(pairs.flatMap((p) => [map(p.a), map(p.b)]));
  const same: number[] = [];
  const diff: number[] = [];
  const scores: TaskResult["scores"] = [];
  pairs.forEach((p, i) => {
    const s = cosine(vecs[2 * i] as number[], vecs[2 * i + 1] as number[]);
    (p.same ? same : diff).push(s);
    scores.push({ topic: p.topic, same: p.same, cosine: Math.round(s * 1e4) / 1e4 });
  });
  const sweep = [];
  for (const t of [
    0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99,
  ]) {
    sweep.push({
      threshold: Math.round(t * 1000) / 1000,
      recall: same.filter((x) => x >= t).length / same.length,
      falsePositiveRate: diff.filter((x) => x >= t).length / diff.length,
    });
  }
  return {
    ...separation(same, diff),
    accuracyAtSpec: accuracyAt(same, diff, spec),
    specThreshold: spec,
    scores,
    sweep,
  };
}

async function evaluate(c: Candidate, pairs: Pair[]): Promise<ModelResult> {
  const desc = pairs.filter((p) => p.kind === "description");
  const code = pairs.filter((p) => p.kind === "code");
  const result: ModelResult = { model: c.id };
  try {
    let t0 = performance.now();
    await load(c); // first call may download
    result.coldLoadMs = ms(t0);
    t0 = performance.now();
    const embed = await load(c); // from disk cache
    result.warmLoadMs = ms(t0);
    const probe = await embed(["probe"]);
    result.dim = (probe[0] as number[]).length;
    const descTexts = desc.flatMap((p) => [p.a, p.b]);
    const codeTexts = code.flatMap((p) => [normalizeCode(p.a), normalizeCode(p.b)]);
    result.msPerEmbeddingDescriptions = await msPerEmbedding(embed, descTexts);
    result.msPerEmbeddingCode = await msPerEmbedding(embed, codeTexts);
    result.descriptions = await withSpec(embed, desc, (s) => s, 0.85);
    result.codeRaw = await withSpec(embed, code, (s) => s, 0.92);
    result.codeNormalized = await withSpec(embed, code, (s) => normalizeCode(s), 0.92);
    result.codeNormalizedSemi = await withSpec(
      embed,
      code,
      (s) => normalizeCode(s, { keepMembersAndGlobals: true }),
      0.92,
    );
  } catch (err) {
    result.skipped = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
  return result;
}

const f = (x: number | undefined, d = 3) => (x === undefined ? "-" : x.toFixed(d));

function row(label: string, t: TaskResult | undefined): string {
  if (!t) return `| ${label} | - | - | - | - | - | - | - |`;
  return `| ${label} | ${f(t.meanSame)} | ${f(t.meanDiff)} | ${f(t.minSame)} | ${f(t.maxDiff)} | ${f(t.bestThreshold)} | ${f(t.bestAccuracy * 100, 1)}% | ${f(t.accuracyAtSpec * 100, 1)}% @ ${t.specThreshold} |`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const only = arg("--models")?.split(",");
  const jsonOut = arg("--json");
  const pairs = parsePairs(readFileSync(join(here, "pairs.jsonl"), "utf8"));
  const results: ModelResult[] = [];
  for (const c of CANDIDATES.filter((x) => !only || only.includes(x.id))) {
    console.error(`evaluating ${c.id} ...`);
    results.push(await evaluate(c, pairs));
  }

  console.log(
    `node ${process.version} on ${process.platform}/${process.arch}, dtype q8, cache ${env.cacheDir}\n`,
  );
  console.log(
    "| model | dim | cold load (s, incl. download) | warm load (s) | ms/emb desc (b32) | ms/emb code (b32) |",
  );
  console.log("|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.skipped) console.log(`| ${r.model} | SKIPPED: ${r.skipped} | | | | |`);
    else
      console.log(
        `| ${r.model} | ${r.dim} | ${f((r.coldLoadMs ?? 0) / 1000, 1)} | ${f((r.warmLoadMs ?? 0) / 1000, 2)} | ${f(r.msPerEmbeddingDescriptions, 2)} | ${f(r.msPerEmbeddingCode, 2)} |`,
      );
  }
  for (const r of results.filter((x) => !x.skipped)) {
    console.log(`\n### ${r.model} (D=${r.dim})`);
    console.log(
      "| task | mean cos same | mean cos diff | min same | max diff | best threshold | best accuracy | accuracy at spec |",
    );
    console.log("|---|---|---|---|---|---|---|---|");
    console.log(row("descriptions", r.descriptions));
    console.log(row("code raw", r.codeRaw));
    console.log(row("code normalized (strict)", r.codeNormalized));
    console.log(row("code normalized (keep members+globals)", r.codeNormalizedSemi));
  }
  if (args.includes("--detail")) {
    for (const r of results.filter((x) => !x.skipped)) {
      for (const [label, t] of [
        ["descriptions", r.descriptions],
        ["code normalized (strict)", r.codeNormalized],
        ["code normalized (keep members+globals)", r.codeNormalizedSemi],
      ] as const) {
        if (!t) continue;
        console.log(`\n#### ${r.model}: ${label}, threshold sweep`);
        console.log("| threshold | recall (same >= t) | false-positive rate (different >= t) |");
        console.log("|---|---|---|");
        for (const w of t.sweep)
          console.log(
            `| ${f(w.threshold, 3)} | ${f(w.recall * 100, 0)}% | ${f(w.falsePositiveRate * 100, 0)}% |`,
          );
        console.log(
          `\nper pair (${label}): ${t.scores.map((x) => `${x.same ? "S" : "D"}:${x.topic}=${x.cosine.toFixed(3)}`).join(", ")}`,
        );
      }
    }
  }
  if (jsonOut)
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2)}\n`,
    );
}

await main();
