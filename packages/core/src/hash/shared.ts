import { createHash } from "node:crypto";
import type { TokenStreams } from "../lang/index.js";

/**
 * Structural fingerprints per function (spec section 7), the shared half. A language module (`lang/`) walks the
 * code of a symbol and supplies the token streams (`exact`, `shape`, `selfRefs`); this file is the only producer
 * of the five hash values:
 * - `exactHash`: sha256 of the exact stream;
 * - `renamedHash`: the exact stream with the symbol's own name as `$0`, so two functions of the same shape that differ only in
 *   their own name match;
 * - `shapeHash`: sha256 of the shape stream;
 * - `minhash`: 64-slot MinHash over 5-shingles of the shape stream;
 * - `nearMinhash`: the same over the `$0` stream (the near tier's literal-aware gate).
 */

const EMPTY_SLOT = 0xffffffff;
export const MINHASH_PERMUTATIONS = 64;
const SHINGLE_SIZE = 5;
const FNV_PRIME = 0x01000193;
const FNV_BASIS = 0x811c9dc5;

function sha32(tokens: string[]): string {
  return createHash("sha256").update(tokens.join("\n")).digest("hex").slice(0, 32);
}

function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Per-permutation FNV-1a offset bases; seeds are 1…64 and fixed. */
const BASES: number[] = Array.from(
  { length: MINHASH_PERMUTATIONS },
  (_, i) => (FNV_BASIS ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0,
);

/** The near tier's literal-aware stream: the exact stream with the symbol's own name as `$0` (a renamed copy matches). */
function nearTokens(s: TokenStreams): string[] {
  if (s.selfRefs.length === 0) return s.exact;
  const out = s.exact.slice();
  for (const i of s.selfRefs) out[i] = "$0";
  return out;
}

function computeMinhash(shape: string[]): Uint32Array {
  const sig = new Uint32Array(MINHASH_PERMUTATIONS).fill(EMPTY_SLOT);
  if (shape.length === 0) return sig;
  const count = Math.max(1, shape.length - SHINGLE_SIZE + 1);
  const width = Math.min(SHINGLE_SIZE, shape.length);
  for (let s = 0; s < count; s++) {
    const bytes = Buffer.from(shape.slice(s, s + width).join("\u001f"), "utf8");
    for (let i = 0; i < MINHASH_PERMUTATIONS; i++) {
      let h = BASES[i] as number;
      for (let j = 0; j < bytes.length; j++) {
        h ^= bytes[j] as number;
        h = Math.imul(h, FNV_PRIME) >>> 0;
      }
      h = fmix32(h);
      if (h < (sig[i] as number)) sig[i] = h;
    }
  }
  return sig;
}

export interface SymbolHashes {
  exactHash: string;
  renamedHash: string;
  shapeHash: string;
  minhash: Uint32Array;
  nearMinhash: Uint32Array;
}

/** The five hash values of a symbol's token streams. */
export function hashStreams(streams: TokenStreams): SymbolHashes {
  const near = nearTokens(streams);
  return {
    exactHash: sha32(streams.exact),
    renamedHash: sha32(near),
    shapeHash: sha32(streams.shape),
    minhash: computeMinhash(streams.shape),
    nearMinhash: computeMinhash(near),
  };
}

/** Fraction of equal MinHash slots: an estimate of the Jaccard similarity of the shingle sets. */
export function minhashJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) throw new RangeError(`minhash length mismatch: ${a.length} vs ${b.length}`);
  if (a.length === 0) return 0;
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}
