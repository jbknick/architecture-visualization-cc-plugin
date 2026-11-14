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

/** Texts per model forward pass and per committed batch. Chosen from the realistic-body benchmark (see the PR for #23). */
export const EMBED_BATCH_SIZE = 8;
/** Safety cap on any text sent to the model, in characters; callers cut far earlier (`CODE_EMBED_MAX_CHARS`). */
export const MAX_EMBED_CHARS = 8000;
/** Tokenizer `max_length` (truncation is always on): one huge input can never exceed this many tokens. */
export const EMBED_MAX_TOKENS = 512;

/** Shared model cache (spec section 4). `GANTRY_MODELS_DIR` overrides it, mainly for tests. */
export function modelCacheDir(): string {
  return process.env.GANTRY_MODELS_DIR || join(homedir(), ".gantry", "models");
}

export interface LoadOptions {
  cacheDir?: string;
  /** Allow downloading the model when it is not in the cache. Default true. */
  allowRemote?: boolean;
  /** Texts per forward pass inside `embed`. Default `EMBED_BATCH_SIZE`. */
  batchSize?: number;
  /** Tokenizer `max_length`. Default `EMBED_MAX_TOKENS`. */
  maxTokens?: number;
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
    const batchSize = Math.max(1, opts.batchSize ?? EMBED_BATCH_SIZE);
    const maxTokens = opts.maxTokens ?? EMBED_MAX_TOKENS;
    // The pipeline tokenizes with `truncation: true` but no `max_length`, which falls back to the model's
    // 8,192-token limit. Pin it so the cost per text is bounded.
    const tokenizer = extractor.tokenizer as unknown as (
      texts: string[],
      o: Record<string, unknown>,
    ) => unknown;
    (extractor as unknown as { tokenizer: unknown }).tokenizer = Object.assign(
      (texts: string[], o: Record<string, unknown>) =>
        tokenizer(texts, { ...o, truncation: true, max_length: maxTokens }),
      tokenizer,
    );
    return {
      dim: EMBED_DIM,
      modelId: EMBED_MODEL_ID,
      available: true,
      async embed(texts) {
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += batchSize) {
          const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, MAX_EMBED_CHARS));
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
