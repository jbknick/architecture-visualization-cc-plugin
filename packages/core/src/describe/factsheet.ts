import { isSensitive } from "../discover/index.js";
import type { Store } from "../store/index.js";
import type { FactSheet, SymbolKind } from "../types.js";

/** Major version of the description prompt (spec section 7); part of every contentKey. */
export const PROMPT_MAJOR = "p1";

export const FACT_DOC_MAX = 400;
export const FACT_CALLEES_MAX = 20;
export const FACT_BODY_MAX = 1500;
const ELLIPSIS_MARK = "\n/* … */\n";

/** Function-like kinds get descriptions and duplicate checks (spec section 7). */
export const FUNCTION_LIKE_KINDS: readonly SymbolKind[] = ["function", "method", "component", "hook"];

export class SensitivePathError extends Error {
  constructor(readonly path: string) {
    super(`Refusing to build a fact sheet for a sensitive path: ${path}`);
    this.name = "SensitivePathError";
  }
}

/** `<exactHash>:<PROMPT_MAJOR>`; descriptions are keyed by this, never by symbol id. */
export function contentKey(exactHash: string): string {
  return `${exactHash}:${PROMPT_MAJOR}`;
}

/** Repo-relative path of a file id (`file:<path>`). */
export function pathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice(5) : fileId;
}

/** Keeps the head and the tail of `body` and puts `/* … *\/` between them so the result is at most `max` chars. */
export function trimBody(body: string, max = FACT_BODY_MAX): string {
  if (body.length <= max) return body;
  const room = max - ELLIPSIS_MARK.length;
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return `${body.slice(0, head)}${ELLIPSIS_MARK}${tail > 0 ? body.slice(body.length - tail) : ""}`;
}

function cleanCommentLine(line: string): string {
  return line
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/, "")
    .replace(/^\s*\/\/+\s?/, "")
    .trim();
}

/**
 * Leading JSDoc or line comments directly above `startLine` (1-based), joined into one line and cut to
 * `FACT_DOC_MAX` chars. Decorator lines between the comment and the declaration are skipped.
 */
export function leadingDoc(lines: string[], startLine: number): string | null {
  let i = startLine - 2; // index of the line above the declaration
  while (i >= 0 && /^\s*@/.test(lines[i] as string)) i--;
  const collected: string[] = [];
  while (i >= 0) {
    const t = (lines[i] as string).trim();
    if (t.startsWith("//")) {
      collected.unshift(lines[i] as string);
      i--;
    } else if (t.endsWith("*/")) {
      let j = i;
      while (j >= 0 && !(lines[j] as string).includes("/*")) j--;
      if (j < 0) break;
      collected.unshift(...lines.slice(j, i + 1));
      i = j - 1;
    } else break;
  }
  return docText(collected);
}

function docText(rawLines: string[]): string | null {
  const text = rawLines
    .map(cleanCommentLine)
    .filter((l) => l !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;
  return text.length > FACT_DOC_MAX ? `${text.slice(0, FACT_DOC_MAX - 1)}…` : text;
}

/** The part after `:` that follows the parameter list of a signature like `<T>(a: A): R`. */
export function returnTypeOf(signature: string): string | null {
  let i = 0;
  if (signature[0] === "<") {
    let depth = 0;
    for (; i < signature.length; i++) {
      const c = signature[i];
      if (c === "<") depth++;
      else if (c === ">" && signature[i - 1] !== "=") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
  }
  if (signature[i] !== "(") return null;
  let depth = 0;
  let quote: string | null = null;
  for (; i < signature.length; i++) {
    const c = signature[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const rest = signature.slice(i).trim();
  if (!rest.startsWith(":")) return null;
  const ret = rest.slice(1).trim();
  return ret === "" ? null : ret;
}

const CALLEE_EDGES = ["calls", "renders", "uses_hook"] as const;

/** Name part of a symbol id: `sym:src/a.ts#Class.method` -> `Class.method`. */
function nameOfSymbolId(id: string): string | null {
  if (!id.startsWith("sym:")) return null;
  const hash = id.indexOf("#");
  if (hash < 0) return null;
  return id.slice(hash + 1).replace(/~\d+$/, "");
}

/**
 * The compact input the describer sees (spec section 7). Pure apart from the store reads.
 * `source` is the full text of the symbol's file. Throws for a sensitive path or an unknown symbol.
 */
export function buildFactSheet(store: Store, symbolId: string, source: string): FactSheet {
  const sym = store.getSymbol(symbolId);
  if (!sym) throw new Error(`Unknown symbol: ${symbolId}`);
  const path = pathOfFileId(sym.fileId);
  if (isSensitive(path)) throw new SensitivePathError(path);

  const lines = source.split("\n");
  const body = lines
    .slice(sym.startLine - 1, sym.endLine)
    .join("\n")
    .trimEnd();

  const names = new Set<string>();
  for (const e of store.effectiveEdges({ src: sym.id, kind: [...CALLEE_EDGES] })) {
    const n = nameOfSymbolId(e.dst);
    if (n) names.add(n);
  }
  const callees = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, FACT_CALLEES_MAX);

  return {
    contentKey: contentKey(sym.exactHash),
    id: sym.id,
    path,
    kind: sym.kind,
    signature: sym.signature,
    doc: leadingDoc(lines, sym.startLine),
    callees,
    returnType: returnTypeOf(sym.signature),
    body: trimBody(body),
  };
}
