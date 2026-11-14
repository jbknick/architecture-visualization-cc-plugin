// Shared text helpers for the description filters.

/** Format characters not in Unicode category Cf that still render as nothing: fillers, joiners, selectors. */
const EXTRA_INVISIBLE = new Set([
  0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180e, 0x3164, 0xffa0,
]);
const FORMAT_CHAR = /^\p{Cf}$/u;

function isInvisible(cp: number, ch: string): boolean {
  return EXTRA_INVISIBLE.has(cp) || FORMAT_CHAR.test(ch);
}

/** Removes zero-width, bidi, soft hyphen, BOM, word joiner and other invisible format characters. */
export function stripInvisible(s: string): string {
  let out = "";
  for (const ch of s) if (!isInvisible(ch.codePointAt(0) ?? 0, ch)) out += ch;
  return out;
}

export function hasInvisible(s: string): boolean {
  return stripInvisible(s) !== s;
}

/** Control characters, including newline and tab, and the line and paragraph separators. */
export function hasControl(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) return true;
  }
  return false;
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}
