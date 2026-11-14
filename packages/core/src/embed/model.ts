import { homedir } from "node:os";
import { join } from "node:path";
import { EMBED_DIM, EMBED_MODEL_ID } from "./vec.js";

export type EmbedKind = "query" | "document" | "code";

export interface Embedder {
  dim: number;
  modelId: string;
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
  /** False for the offline fallback, whose vectors are all zeros and must not be stored. */
  available?: boolean;
}

export const EMBED_BATCH_SIZE = 32;
/** Longest text sent to the model, in characters. Longer bodies are cut: code beyond this adds cost, not signal. */
export const MAX_EMBED_CHARS = 8000;

/** Shared model cache (spec section 4). `GANTRY_MODELS_DIR` overrides it, mainly for tests. */
export function modelCacheDir(): string {
  return process.env.GANTRY_MODELS_DIR || join(homedir(), ".gantry", "models");
}

export interface LoadOptions {
  cacheDir?: string;
  /** Allow downloading the model when it is not in the cache. Default true. */
  allowRemote?: boolean;
}

let warned = false;
function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`gantry: ${msg}\n`);
}

/** Embedder that returns zero vectors: used when the model cannot be loaded (no cache, no network). */
export function offlineEmbedder(): Embedder {
  return {
    dim: EMBED_DIM,
    modelId: EMBED_MODEL_ID,
    available: false,
    embed: async (texts) => texts.map(() => new Float32Array(EMBED_DIM)),
  };
}

/**
 * Loads the Jina code model (q8 ONNX, mean pooling, L2-normalized, no prefixes for any kind) through
 * transformers.js. Falls back to the offline embedder, with one warning, if it cannot be loaded.
 */
export async function loadEmbedder(opts: LoadOptions = {}): Promise<Embedder> {
  try {
    // Lazy: onnxruntime is heavy and only needed when something is actually embedded.
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = opts.cacheDir ?? modelCacheDir();
    env.allowRemoteModels = opts.allowRemote ?? true;
    const extractor = await pipeline("feature-extraction", EMBED_MODEL_ID, { dtype: "q8" });
    return {
      dim: EMBED_DIM,
      modelId: EMBED_MODEL_ID,
      available: true,
      async embed(texts) {
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
          const batch = texts.slice(i, i + EMBED_BATCH_SIZE).map((t) => t.slice(0, MAX_EMBED_CHARS));
          const t = await extractor(batch, { pooling: "mean", normalize: true });
          const data = t.data as Float32Array;
          const dim = t.dims[t.dims.length - 1] as number;
          for (let j = 0; j < batch.length; j++)
            out.push(Float32Array.from(data.subarray(j * dim, (j + 1) * dim)));
        }
        return out;
      },
    };
  } catch (err) {
    warnOnce(
      `embedding model ${EMBED_MODEL_ID} is not cached and could not be downloaded (${
        err instanceof Error ? err.message : String(err)
      }); vector search is off until it is available`,
    );
    return offlineEmbedder();
  }
}

let singleton: Promise<Embedder> | null = null;

/** Process-wide embedder: loads once on first use; the model cache is `~/.gantry/models`. */
export function getEmbedder(): Promise<Embedder> {
  singleton ??= loadEmbedder();
  return singleton;
}

/** Test hook: forget the cached embedder (and the one-time warning). */
export function resetEmbedderForTests(): void {
  singleton = null;
  warned = false;
}
