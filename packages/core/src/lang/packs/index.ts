import { registerPacks } from "../engine/grammar.js";
import { goPack } from "./go.js";
import { javaPack } from "./java.js";

export { goPack, javaPack };

/** Every language pack, in a fixed order. TypeScript has its own module and no pack. */
export const PACKS = [goPack, javaPack] as const;

/** True when `lang` is the id of a language pack (every language but TypeScript). */
export const isPackLang = (lang: string): boolean => PACKS.some((p) => p.id === lang);

// All grammars load in one registration call, so the list is given to the engine before any file is parsed.
registerPacks(PACKS);
