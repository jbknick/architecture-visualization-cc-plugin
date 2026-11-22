import { registerPacks } from "../engine/grammar.js";
import { goPack } from "./go.js";

export { goPack };

/** Every language pack, in a fixed order. TypeScript has its own module and no pack. */
export const PACKS = [goPack] as const;

// All grammars load in one registration call, so the list is given to the engine before any file is parsed.
registerPacks(PACKS);
