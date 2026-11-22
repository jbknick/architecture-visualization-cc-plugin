import { grammarAvailable } from "../engine/grammar.js";
import { buildLanguage } from "../engine/module.js";
import type { LanguageModule } from "../index.js";
import { goPack } from "../packs/index.js";
import { GoCalls } from "./calls.js";
import { GoIndex } from "./resolve.js";

/** True when the Go grammar loaded on this platform. */
export const goAvailable = (): boolean => grammarAvailable(goPack);

/**
 * The Go language module: the engine over the Go pack (`lang/packs/go.ts`), with the call, `extends` and `implements`
 * edges from the package index and local type inference (`resolve.ts`, `calls.ts`). Its `calls` edges are level 2:
 * they come from types read from the syntax, not from names alone.
 */
export const go: LanguageModule = buildLanguage(goPack, (ctx) => {
  const calls = new GoCalls(new GoIndex(ctx));
  return {
    targetAt: (fileId, start, end) => calls.targetAt(fileId, start, end),
    typeNameAt: (fileId, start, end) => calls.typeNameAt(fileId, start, end),
    edgesForFile: (fileId, parsed) =>
      calls.edgesForFile(fileId, parsed).map((e) => (e.kind === "calls" ? { ...e, level: 2 as const } : e)),
  };
});
