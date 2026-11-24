import type { Lang } from "../types.js";
import { CLOJURE_EXTENSIONS, CLOJURE_ID } from "./clojure/ids.js";
import { isPackLang, PACKS } from "./packs/index.js";

/**
 * The languages other than TypeScript, by id and extension, for shared code that must not load the language modules
 * (`lang/index.ts`): the packs, and Clojure, which has a module of its own.
 */

/** True for every language but TypeScript. Their workspaces come with their own `depends_on` edges. */
export const isNonTypeScriptLang = (lang: string): boolean => isPackLang(lang) || lang === CLOJURE_ID;

/** The language of a source path by its extension: a pack, Clojure, else TypeScript. */
export function langIdByExtension(p: string): Lang {
  const pack = PACKS.find((pk) => pk.extensions.some((x) => p.endsWith(x)));
  if (pack) return pack.id;
  return CLOJURE_EXTENSIONS.some((x) => p.endsWith(x)) ? CLOJURE_ID : "typescript";
}
