import { grammarAvailable } from "../engine/grammar.js";
import type { CallResolverFactory } from "../engine/module.js";
import { goPack } from "../packs/index.js";
import { GoCalls } from "./calls.js";
import { GoIndex } from "./resolve.js";

/** True when the Go grammar loaded on this platform. */
export const goAvailable = (): boolean => grammarAvailable(goPack);

/**
 * The call resolver the engine takes for the Go pack (`lang/packs/go.ts`): the call, `extends` and `implements` edges
 * from the package index and local type inference (`resolve.ts`, `calls.ts`). Its `calls` edges are level 2: the
 * resolver reads declared types, and also resolves names within a package.
 */
export const goCalls: CallResolverFactory = (ctx) => {
  const calls = new GoCalls(new GoIndex(ctx));
  return {
    targetAt: (fileId, start, end) => calls.targetAt(fileId, start, end),
    typeNameAt: (fileId, start, end) => calls.typeNameAt(fileId, start, end),
    edgesForFile: (fileId, parsed) =>
      calls.edgesForFile(fileId, parsed).map((e) => (e.kind === "calls" ? { ...e, level: 2 as const } : e)),
  };
};
