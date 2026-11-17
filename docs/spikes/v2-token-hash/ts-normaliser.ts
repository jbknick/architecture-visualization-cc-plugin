// The TypeScript language module's half: today's oxc Walker, unchanged, ending at the token streams.
// To avoid a second copy of ~500 lines, the current packages/core/src/hash/index.ts is loaded as a patched copy
// (its internal `analyze` exported, imports made absolute) written to a temp dir. Nothing in packages/ is edited.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TokenStreams } from "./shared-hash.js";

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, "../../../packages/core/src");

interface Analysis {
  tokens: string[];
  shape: string[];
  rootNames: ReadonlySet<string>;
}
type Analyze = (source: string, range: { start: number; end: number }, lang: "ts" | "tsx") => { a: Analysis };

let analyzeFn: Analyze | null = null;

export async function loadTsNormaliser(): Promise<void> {
  const original = readFileSync(join(coreSrc, "hash/index.ts"), "utf8");
  const oxc = createRequire(join(coreSrc, "../package.json")).resolve("oxc-parser");
  const patched = original
    .replace('from "oxc-parser"', `from ${JSON.stringify(pathToFileURL(oxc).href)}`)
    .replace(
      'from "../parse/ast.js"',
      `from ${JSON.stringify(pathToFileURL(join(coreSrc, "parse/ast.ts")).href)}`,
    )
    .replace("\nfunction analyze(", "\nexport function analyze(");
  if (!patched.includes("export function analyze(")) throw new Error("hash/index.ts no longer has analyze()");
  const file = join(mkdtempSync(join(tmpdir(), "spike-token-hash-")), "hash-copy.ts");
  writeFileSync(file, patched);
  const mod = (await import(pathToFileURL(file).href)) as { analyze: Analyze };
  analyzeFn = mod.analyze;
}

/** TypeScript's token streams for a symbol range. `selfRefs` marks unresolved references to the symbol's own name. */
export function tsStreams(
  source: string,
  range: { start: number; end: number },
  lang: "ts" | "tsx",
): TokenStreams {
  if (!analyzeFn) throw new Error("call loadTsNormaliser() first");
  const { a } = analyzeFn(source, range, lang);
  const selfRefs: number[] = [];
  a.tokens.forEach((t, i) => {
    if (t.startsWith("I:") && a.rootNames.has(t.slice(2))) selfRefs.push(i);
  });
  return { exact: a.tokens, shape: a.shape, selfRefs };
}
