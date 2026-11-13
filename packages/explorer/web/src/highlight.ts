// A deliberately small TypeScript/JavaScript tokenizer for the source preview. It returns plain
// strings with a type, never HTML, so the caller renders them as React text nodes.

export type TokenType = "comment" | "string" | "keyword" | "number" | "type" | "plain";
export interface Token {
  type: TokenType;
  text: string;
}

const KEYWORDS = new Set(
  (
    "as async await break case catch class const continue default delete do else enum export extends " +
    "false finally for from function if implements import in instanceof interface let new null of private " +
    "protected public readonly return static super switch this throw true try type typeof undefined var void while yield"
  ).split(" "),
);

const PATTERN = new RegExp(
  [
    "(?<comment>//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))",
    "(?<string>\"(?:[^\"\\\\\\n]|\\\\.)*\"?|'(?:[^'\\\\\\n]|\\\\.)*'?|`(?:[^`\\\\]|\\\\[\\s\\S])*`?)",
    "(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)",
    "(?<word>[A-Za-z_$][\\w$]*)",
  ].join("|"),
  "g",
);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  const push = (type: TokenType, text: string) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.type === type && type === "plain") prev.text += text;
    else tokens.push({ type, text });
  };
  for (const m of source.matchAll(PATTERN)) {
    const index = m.index ?? 0;
    push("plain", source.slice(last, index));
    const g = m.groups ?? {};
    const text = m[0];
    if (g.comment !== undefined) push("comment", text);
    else if (g.string !== undefined) push("string", text);
    else if (g.number !== undefined) push("number", text);
    else if (KEYWORDS.has(text)) push("keyword", text);
    else if (/^[A-Z]/.test(text)) push("type", text);
    else push("plain", text);
    last = index + text.length;
  }
  push("plain", source.slice(last));
  return tokens;
}

/** Tokenize a whole snippet, then split the tokens at newlines so each source line renders on its own. */
export function tokenizeLines(lines: string[]): Token[][] {
  const out: Token[][] = [[]];
  for (const token of tokenize(lines.join("\n"))) {
    const parts = token.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) out.push([]);
      if (part) out[out.length - 1]?.push({ type: token.type, text: part });
    });
  }
  return out;
}
