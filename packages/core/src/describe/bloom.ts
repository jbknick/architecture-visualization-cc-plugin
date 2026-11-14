// Hashing shared by the word-list generator (scripts/build-wordlist.ts) and the runtime lookup (wordlist.ts).
// Two 32-bit hashes combined by double hashing: index_i = (h1 + i * h2) mod m.

export function bloomHashes(word: string): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + 0x7f4a7c15) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return [h1 >>> 0, (h2 | 1) >>> 0];
}

/** Bit index of the i-th probe. */
export function bloomIndex(h1: number, h2: number, i: number, m: number): number {
  return ((h1 + Math.imul(i, h2)) >>> 0) % m;
}
