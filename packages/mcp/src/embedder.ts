import { existsSync } from "node:fs";
import { join } from "node:path";
import { EMBED_MODEL_ID, type Embedder, loadEmbedder, modelCacheDir } from "@gantry/core";

/**
 * Returns a function that gives the embedding model only when its files are already in the shared cache (it never
 * downloads), loading it once per process. Tools use it to embed a handful of new rows without making a call slow;
 * with no cache the rows wait for `gantry embed`.
 */
export function cachedEmbedder(): () => Promise<Embedder | undefined> {
  let loaded: Promise<Embedder | undefined> | undefined;
  return () => {
    const model = join(modelCacheDir(), EMBED_MODEL_ID, "onnx", "model_quantized.onnx");
    if (!existsSync(model)) return Promise.resolve(undefined);
    loaded ??= loadEmbedder({ allowRemote: false }).then((e) => (e.available ? e : undefined));
    return loaded;
  };
}
