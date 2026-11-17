// Language-blind hashing: everything in packages/core/src/hash/index.ts after the token streams exist.
// A language module supplies `TokenStreams`; this file never looks at an AST.
import { createHash } from "node:crypto";

export interface TokenStreams {
  /** Exact stream: kinds, operators, literal values; locals renamed `$1, $2…` by the language. */
  exact: string[];
  /** Shape stream: kinds only, identifiers and literals collapsed to placeholders. */
  shape: string[];
  /** Positions in `exact` that refer to the symbol's own name (become `$0` in the near stream). */
  selfRefs: number[];
}

export interface Hashes {
  exactHash: string;
  renamedHash: string;
  shapeHash: string;
  minhash: Uint32Array;
  nearMinhash: Uint32Array;
}

const EMPTY_SLOT = 0xffffffff;
const PERMUTATIONS = 64;
const SHINGLE_SIZE = 5;
const FNV_PRIME = 0x01000193;
const FNV_BASIS = 0x811c9dc5;

const sha32 = (tokens: string[]): string =>
  createHash("sha256").update(tokens.join("\n")).digest("hex").slice(0, 32);

function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

const BASES: number[] = Array.from(
  { length: PERMUTATIONS },
  (_, i) => (FNV_BASIS ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0,
);

export function minhash(stream: string[]): Uint32Array {
  const sig = new Uint32Array(PERMUTATIONS).fill(EMPTY_SLOT);
  if (stream.length === 0) return sig;
  const count = Math.max(1, stream.length - SHINGLE_SIZE + 1);
  const width = Math.min(SHINGLE_SIZE, stream.length);
  for (let s = 0; s < count; s++) {
    const bytes = Buffer.from(stream.slice(s, s + width).join("\u001f"), "utf8");
    for (let i = 0; i < PERMUTATIONS; i++) {
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

export function jaccard(a: Uint32Array, b: Uint32Array): number {
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return a.length === 0 ? 0 : eq / a.length;
}

export function hashStreams(t: TokenStreams): Hashes {
  let near = t.exact;
  if (t.selfRefs.length > 0) {
    near = [...t.exact];
    for (const i of t.selfRefs) near[i] = "$0";
  }
  return {
    exactHash: sha32(t.exact),
    renamedHash: sha32(near),
    shapeHash: sha32(t.shape),
    minhash: minhash(t.shape),
    nearMinhash: minhash(near),
  };
}
