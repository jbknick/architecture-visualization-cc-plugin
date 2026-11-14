import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { normalizeForEmbedding } from "../hash/index.js";
import {
  CODE_EMBED_MAX_CHARS,
  EMBED_MAX_TOKENS,
  EMBED_MODEL_ID,
  loadEmbedder,
  modelCacheDir,
} from "./index.js";

/**
 * Deterministic generator of realistic function bodies: `lines` source lines of mixed statements (loops,
 * branches, calls, object building, template strings). Pure function of (name, lines, seed).
 */
export function syntheticFunction(name: string, lines: number, seed: number): string {
  let s = seed >>> 0 || 1;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
  const vars = ["acc", "total", "item", "row", "key", "value", "result", "count", "index", "entry"];
  const calls = ["normalize", "lookup", "format", "validate", "merge", "emit", "resolveName", "toKey"];
  const out: string[] = [
    `export async function ${name}(input: Record<string, unknown>[], options: Options) {`,
  ];
  out.push("  const results: Result[] = [];", "  let count = 0;");
  let depth = 1;
  while (out.length < lines - 2) {
    const pad = "  ".repeat(depth);
    const v = vars[rnd(vars.length)] as string;
    const c = calls[rnd(calls.length)] as string;
    switch (rnd(7)) {
      case 0:
        out.push(`${pad}for (const ${v}${out.length} of input) {`);
        depth++;
        break;
      case 1:
        out.push(`${pad}if (options.${v} && count > ${rnd(50)}) {`);
        depth++;
        break;
      case 2:
        out.push(`${pad}const ${v}${out.length} = await ${c}(options.${v}, ${rnd(100)});`);
        break;
      case 3:
        out.push(
          `${pad}results.push({ id: \`${v}-\${count}\`, label: ${c}("${v}"), score: ${rnd(1000)} / 10 });`,
        );
        break;
      case 4:
        out.push(`${pad}count += ${c}(input.length) ?? ${rnd(9)}; // update the running count`);
        break;
      case 5:
        out.push(`${pad}if (!${c}(options)) throw new Error("invalid ${v} at step ${rnd(99)}");`);
        break;
      default:
        if (depth > 1) {
          depth--;
          out.push(`${"  ".repeat(depth)}}`);
        } else out.push(`${pad}count++;`);
    }
  }
  while (depth > 1) {
    depth--;
    out.push(`${"  ".repeat(depth)}}`);
  }
  out.push("  return { results, count };", "}");
  return out.join("\n");
}

const normalized = (name: string, lines: number, i: number): string => {
  const src = syntheticFunction(name, lines, i * 7919 + lines);
  return normalizeForEmbedding(src, { start: 0, end: src.length }, "ts");
};

describe("syntheticFunction (bench generator)", () => {
  it("is deterministic and has about the requested number of lines", () => {
    expect(syntheticFunction("f", 80, 3)).toBe(syntheticFunction("f", 80, 3));
    expect(syntheticFunction("f", 80, 3)).not.toBe(syntheticFunction("f", 80, 4));
    for (const n of [20, 80, 300]) {
      const lines = syntheticFunction("f", n, 1).split("\n").length;
      expect(lines).toBeGreaterThanOrEqual(n - 2);
      expect(lines).toBeLessThanOrEqual(Math.ceil(n * 1.2) + 20);
    }
  });

  it("normalized 80- and 300-line bodies exceed the truncation budget; 20 lines usually fits", () => {
    expect(normalized("f", 300, 1).length).toBeGreaterThan(CODE_EMBED_MAX_CHARS);
    expect(normalized("f", 80, 1).length).toBeGreaterThan(CODE_EMBED_MAX_CHARS);
  });
});

const cached = existsSync(join(modelCacheDir(), EMBED_MODEL_ID, "onnx", "model_quantized.onnx"));

// Opt-in, about 5 minutes: GANTRY_EMBED_BENCH=1 pnpm vitest run packages/core/src/embed/bench.test.ts
describe.skipIf(!cached || process.env.GANTRY_EMBED_BENCH !== "1")(
  "embedding cost on realistic bodies",
  () => {
    it("reports ms per function by body size, before and after truncation, at batch sizes 8 and 32", async () => {
      // Fewer functions for the long bodies: the untruncated 300-line case costs seconds per function.
      const countFor = (lines: number): number => (lines >= 300 ? 8 : 16);
      const out = (line: string): void => {
        process.stderr.write(`${line}\n`);
        if (process.env.GANTRY_EMBED_BENCH_OUT)
          appendFileSync(process.env.GANTRY_EMBED_BENCH_OUT, `${line}\n`);
      };
      const t0 = performance.now();
      const sample = normalized("warm", 20, 0);
      const norm = performance.now() - t0;
      process.stderr.write(
        `bench: normalizing one 20-line function took ${norm.toFixed(1)} ms (first call)\n`,
      );
      // GANTRY_EMBED_BENCH_AFTER=1 skips the slow untruncated runs and adds batch size 16.
      const afterOnly = process.env.GANTRY_EMBED_BENCH_AFTER === "1";
      for (const batch of afterOnly ? [8, 16, 32, 8, 16, 32] : [8, 32]) {
        // before: no character cut beyond the old 8,000 safety cap, tokenizer limit 8,192
        const before = await loadEmbedder({ batchSize: batch, maxTokens: 8192 });
        // after: 1,500 characters, 512 tokens
        const after = await loadEmbedder({ batchSize: batch, maxTokens: EMBED_MAX_TOKENS });
        await after.embed([sample], "code"); // warm up the runtime once
        await before.embed([sample], "code");
        for (const lines of [20, 80, 300]) {
          const N = countFor(lines);
          const full = Array.from({ length: N }, (_, i) => normalized(`fn${i}`, lines, i + 1));
          const avgChars = Math.round(full.reduce((a, t) => a + t.length, 0) / N);
          for (const [variant, emb, texts] of [
            ["before", before, full],
            ["after", after, full.map((t) => t.slice(0, CODE_EMBED_MAX_CHARS))],
          ] as const) {
            if (afterOnly && variant === "before") continue;
            const ts = performance.now();
            const v = await emb.embed([...texts], "code");
            const ms = (performance.now() - ts) / N;
            expect(v).toHaveLength(N);
            out(
              `${lines} lines | ${avgChars} chars | ${variant} | batch ${batch} | n=${N} | ${ms.toFixed(1)} ms/function`,
            );
          }
        }
      }
    }, 3_000_000);
  },
);
