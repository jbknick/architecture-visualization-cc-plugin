import picomatch from "picomatch";
import type { SymbolKind } from "../types.js";

/**
 * Like-for-like filters of the duplicate engine (spec section 17): kind families, files that never
 * take part (tests, fixtures, generated code), signature compatibility and dismissed pairs.
 * Everything here is pure and works on repo-relative POSIX paths.
 */

export type KindFamily = "function" | "component" | "hook";

/** function and method compare with each other; components and hooks only with their own kind. */
export function kindFamily(kind: SymbolKind): KindFamily | null {
  switch (kind) {
    case "function":
    case "method":
      return "function";
    case "component":
      return "component";
    case "hook":
      return "hook";
    default:
      return null;
  }
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(^|\/)__tests__\//;
const FIXTURE_DIR = /(^|\/)(__fixtures__|__mocks__|fixtures?|testdata|test-data)\//;
const GENERATED = /(\.(gen|generated)\.[cm]?[jt]sx?$)|((^|\/)(__generated__|generated)\/)/;

export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path) || TEST_DIR.test(path);
}
export function isFixturePath(path: string): boolean {
  return FIXTURE_DIR.test(path);
}
export function isGeneratedPath(path: string): boolean {
  return GENERATED.test(path);
}

/**
 * Files that never take part: tests, fixtures and generated code. Barrel files need no rule of their
 * own: they only re-export and hold no function-like symbol, so there is nothing in them to compare.
 */
export function isExcludedPath(path: string): boolean {
  return isTestPath(path) || isFixturePath(path) || isGeneratedPath(path);
}

const matcherCache = new Map<string, (s: string) => boolean>();
function matcher(glob: string): (s: string) => boolean {
  let m = matcherCache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    matcherCache.set(glob, m);
  }
  return m;
}

/** True when `path` matches one of the `duplicates.ignore` globs. */
export function matchesIgnore(path: string, globs: readonly string[]): boolean {
  for (const g of globs) if (matcher(g)(path)) return true;
  return false;
}

/** Text between the first top-level `(` `)` of a signature such as `<T>(a: T, b?: number): string`. */
function paramText(signature: string): { params: string; rest: string } | null {
  let i = 0;
  if (signature[0] === "<") {
    let depth = 0;
    for (; i < signature.length; i++) {
      const c = signature[i];
      if (c === "<") depth++;
      else if (c === ">" && signature[i - 1] !== "=" && --depth === 0) {
        i++;
        break;
      }
    }
  }
  if (signature[i] !== "(") return null;
  let depth = 0;
  for (let j = i; j < signature.length; j++) {
    const c = signature[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return { params: signature.slice(i + 1, j), rest: signature.slice(j + 1) };
    }
  }
  return null;
}

/** Number of parameters in an indexed signature; undefined when the signature is empty or unparseable. */
export function paramCount(signature: string): number | undefined {
  const p = paramText(signature.trim());
  if (!p) return undefined;
  const text = p.params.trim();
  if (text === "") return 0;
  let depth = 0;
  let count = 1;
  let last = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ">" && text[i - 1] !== "=") depth--;
    else if (c === "," && depth === 0) {
      count++;
      last = ",";
      continue;
    }
    if (c.trim() !== "") last = c;
  }
  return last === "," ? count - 1 : count; // trailing comma
}

/**
 * Whether the function is async, as far as the signature says: `true` when the return type is a
 * `Promise<…>`, `false` when it is some other annotation, `undefined` when there is none (the
 * `async` keyword itself is not stored, so an unannotated function is unknown, not sync).
 */
export function asyncHint(signature: string): boolean | undefined {
  const p = paramText(signature.trim());
  if (!p) return undefined;
  const m = /^\s*:\s*(.+)$/s.exec(p.rest);
  if (!m) return undefined;
  return /^(Promise|PromiseLike)\s*</.test((m[1] as string).trim());
}

export interface SignatureShape {
  params: number | undefined;
  async: boolean | undefined;
}

export function signatureShape(signature: string): SignatureShape {
  return { params: paramCount(signature), async: asyncHint(signature) };
}

/** Parameter counts within ±1 (unknown counts are compatible). */
export function paramsClose(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined || Math.abs(a - b) <= 1;
}

/** Semantic-tier compatibility: parameter count ±1, and not async on one side and sync on the other. */
export function signaturesCompatible(a: SignatureShape, b: SignatureShape): boolean {
  if (!paramsClose(a.params, b.params)) return false;
  return a.async === undefined || b.async === undefined || a.async === b.async;
}

/** Canonical key of an unordered pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}
