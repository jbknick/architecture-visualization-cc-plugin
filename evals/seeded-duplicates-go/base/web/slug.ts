const WORD_CHAR = /[\p{L}\p{N}]/u;

// Lower-cases the text and joins its words with single dashes.
export function slugify(input: string): string {
  let out = "";
  let lastDash = true;
  for (const ch of input.trim().toLowerCase()) {
    if (WORD_CHAR.test(ch)) {
      out += ch;
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  return out.endsWith("-") ? out.slice(0, -1) : out;
}
