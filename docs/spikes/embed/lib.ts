/** Helpers shared by the embedding spike scripts. Spike code only, not the production embed module. */

export interface Pair {
  kind: "description" | "code";
  same: boolean;
  topic: string;
  a: string;
  b: string;
}

export function parsePairs(jsonl: string): Pair[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Pair);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((s, x) => s + x, 0) / xs.length;

export interface Separation {
  meanSame: number;
  meanDiff: number;
  minSame: number;
  maxDiff: number;
  /** Threshold maximizing accuracy (score >= threshold predicts "same"); midpoint of the best range. */
  bestThreshold: number;
  bestAccuracy: number;
}

export function accuracyAt(same: number[], diff: number[], threshold: number): number {
  const correct = same.filter((s) => s >= threshold).length + diff.filter((s) => s < threshold).length;
  return correct / (same.length + diff.length);
}

export function separation(same: number[], diff: number[]): Separation {
  const all = [...new Set([...same, ...diff])].sort((x, y) => x - y);
  const candidates = [(all[0] ?? 0) - 1e-6];
  for (let i = 0; i + 1 < all.length; i++) candidates.push(((all[i] as number) + (all[i + 1] as number)) / 2);
  candidates.push((all[all.length - 1] ?? 0) + 1e-6);
  let bestAccuracy = -1;
  let lo = 0;
  let hi = 0;
  for (const t of candidates) {
    const acc = accuracyAt(same, diff, t);
    if (acc > bestAccuracy + 1e-12) {
      bestAccuracy = acc;
      lo = t;
      hi = t;
    } else if (Math.abs(acc - bestAccuracy) <= 1e-12) {
      hi = t;
    }
  }
  return {
    meanSame: mean(same),
    meanDiff: mean(diff),
    minSame: Math.min(...same),
    maxDiff: Math.max(...diff),
    bestThreshold: (lo + hi) / 2,
    bestAccuracy,
  };
}

const KEYWORDS = new Set(
  (
    "abstract any as async await bigint boolean break case catch class const constructor continue debugger declare " +
    "default delete do else enum export extends false finally for from function get if implements import in infer " +
    "instanceof interface is keyof let namespace never new null number object of override private protected public " +
    "readonly return satisfies set static string super switch symbol this throw true try type typeof undefined unique " +
    "unknown var void while with yield"
  ).split(" "),
);

/** Built-ins left alone in the "semi" variant. */
const GLOBALS = new Set(
  (
    "Array Boolean Date Error Infinity JSON Map Math NaN Number Object Promise Record Pick Omit Partial Readonly RegExp " +
    "Set String Symbol URL URLSearchParams WeakMap WeakSet console clearTimeout setTimeout clearInterval setInterval " +
    "parseInt parseFloat isNaN process Buffer"
  ).split(" "),
);

export interface NormalizeOptions {
  /** Leave `.prop` member names and well-known globals unrenamed. Default false (strict: every identifier). */
  keepMembersAndGlobals?: boolean;
}

const TOKEN =
  /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d[\w.]*|[\s\S]/y;

/** After these a `/` starts a regex literal rather than division. */
const REGEX_PREV = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
  "return",
]);

/**
 * Simple normalizer: identifiers (anything that is not a keyword) become `v1, v2, ...` in order of first
 * appearance, string and template literals become `"s"`, comments are dropped and whitespace collapsed.
 */
export function normalizeCode(source: string, options: NormalizeOptions = {}): string {
  const names = new Map<string, string>();
  const out: string[] = [];
  let prev = ""; // previous significant token
  let pos = 0;
  while (pos < source.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(source);
    if (!m) break;
    const tok = m[0];
    pos = TOKEN.lastIndex;
    if (/^\s+$/.test(tok)) {
      out.push(" ");
      continue;
    }
    if (tok.startsWith("//") || tok.startsWith("/*")) continue;
    if (tok === "/" && (prev === "" || REGEX_PREV.has(prev))) {
      // regex literal: scan to the closing unescaped slash (outside a character class), then flags
      let j = pos;
      let inClass = false;
      while (j < source.length) {
        const ch = source[j] as string;
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < source.length && /[a-z]/.test(source[j] as string)) j++;
      const literal = source.slice(pos - 1, j);
      pos = j;
      out.push(literal);
      prev = literal;
      continue;
    }
    if (tok[0] === '"' || tok[0] === "'" || tok[0] === "`") {
      out.push('"s"');
      prev = '"s"';
      continue;
    }
    if (/^[A-Za-z_$]/.test(tok)) {
      const isMember = prev === ".";
      const keep =
        KEYWORDS.has(tok) || (options.keepMembersAndGlobals === true && (isMember || GLOBALS.has(tok)));
      if (keep) out.push(tok);
      else {
        let v = names.get(tok);
        if (v === undefined) {
          v = `v${names.size + 1}`;
          names.set(tok, v);
        }
        out.push(v);
      }
      prev = tok;
      continue;
    }
    out.push(tok);
    prev = tok;
  }
  return out.join("").replace(/\s+/g, " ").trim();
}
