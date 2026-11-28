/**
 * One rule for text written by someone else that reaches an agent, a comment or a wire body (spec section 11): what
 * cannot be seen is removed, line breaks and controls become one space, and what is left is cut and has no backtick.
 *
 * Removed always: format characters (zero-width space, bidi controls, soft hyphen, BOM, word joiner, tag characters),
 * private use, lone surrogates, the variation selectors of the supplement (U+E0100 to U+E01EF) and the Mongolian ones,
 * and the characters that draw nothing: U+034F, U+115F, U+1160, U+3164, U+FFA0, U+2800, U+17B4, U+17B5.
 * Kept only between visible characters: U+200C and U+200D (emoji sequences, Persian and Indic words).
 * Kept at most once and only straight after a visible character: a variation selector U+FE00 to U+FE0F (emoji style).
 * Turned into one space: control characters, line and paragraph separators, and every space character.
 */

const CATEGORY = /^[\p{Cf}\p{Co}\p{Cs}]$/u;
/** Variation selectors of the supplement and the Mongolian ones, and the characters that draw nothing. */
const BLANKS = new Set([
  0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x2800, 0x3164, 0xffa0,
]);
const NEVER = {
  test(c: string): boolean {
    const cp = c.codePointAt(0) as number;
    return BLANKS.has(cp) || (cp >= 0xe0100 && cp <= 0xe01ef) || CATEGORY.test(c);
  },
};
const SPACE = /^[\p{Cc}\p{Zs}\p{Zl}\p{Zp}]$/u;
const BREAK = /^[\p{Cc}\p{Zl}\p{Zp}]$/u;

const isJoiner = (c: string): boolean => c === "‌" || c === "‍";
const isVariation = (c: string): boolean => c >= "︀" && c <= "️";
/** Not removed, not a space, not a joiner and not a variation selector. */
const isVisible = (c: string | undefined): boolean =>
  c !== undefined && !isJoiner(c) && !isVariation(c) && !NEVER.test(c) && !SPACE.test(c);

/** The text with the invisible characters removed or kept by the rule above; `hidden` says whether anything was dropped or was a break. */
function scan(text: string): { out: string[]; hidden: boolean } {
  const cps = [...text];
  const out: string[] = [];
  let hidden = false;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i] as string;
    const prev = out[out.length - 1];
    if (isJoiner(c)) {
      // Both neighbours in the text as written must be visible; a kept variation selector counts as part of its base.
      const was = cps[i - 1];
      const before = was !== undefined && (isVisible(was) || (isVariation(was) && prev === was));
      if (before && isVisible(cps[i + 1])) out.push(c);
      else hidden = true;
    } else if (isVariation(c)) {
      if (prev !== undefined && isVisible(prev)) out.push(c);
      else hidden = true;
    } else if (NEVER.test(c)) {
      hidden = true;
    } else if (SPACE.test(c)) {
      if (BREAK.test(c)) hidden = true;
      out.push(" ");
    } else {
      out.push(c);
    }
  }
  return { out, hidden };
}

/** True when `text` holds a control character, a line break or an invisible character the rule removes. */
export function hasHiddenText(text: string): boolean {
  return scan(text).hidden;
}

/** `text` with the invisible characters dealt with, runs of spaces made one, and trimmed. */
export function stripHiddenText(text: string): string {
  return scan(text).out.join("").replace(/ {2,}/g, " ").trim();
}

/** Untrusted text made safe to show: `stripHiddenText`, cut to `max` characters (`…` when cut), backticks as apostrophes. */
export function cleanUntrustedText(text: string, max: number): string {
  const flat = stripHiddenText(text);
  const cut = flat.length > max ? `${flat.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "")}…` : flat;
  return cut.replaceAll("`", "'");
}
