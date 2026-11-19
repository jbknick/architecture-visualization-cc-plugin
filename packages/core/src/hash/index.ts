import { langOfPath, languageModule } from "../lang/index.js";
import { hashStreams, type SymbolHashes } from "./shared.js";

export { hashStreams, MINHASH_PERMUTATIONS, minhashJaccard, type SymbolHashes } from "./shared.js";

/**
 * The five hashes of the code in `range` of the file at `path`, with the token streams of the language that owns
 * the path. `range` is a symbol body range from the parser (UTF-16 offsets into `source`).
 */
export function hashSymbol(
  source: string,
  range: { start: number; end: number },
  path: string,
): SymbolHashes {
  return hashStreams(languageModule(langOfPath(path)).streams(source, range, path));
}

/**
 * Code text for the embedding tier (spec section 17): the language module decides what is kept. For TypeScript, local
 * identifiers become `v1, v2, …`, comments and layout are dropped and string and template literals become `"s"`.
 * The hash token streams are unaffected.
 */
export function normalizeForEmbedding(
  source: string,
  range: { start: number; end: number },
  path: string,
): string {
  return languageModule(langOfPath(path)).embeddingText(source, range, path);
}
