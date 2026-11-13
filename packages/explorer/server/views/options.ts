import type { ViewParams } from "../types.js";

type Options = Record<string, unknown>;
const RESERVED = new Set(["filters", "focus", "depth", "level", "t"]);

/**
 * `filters` is either a JSON object or comma-separated `key=value` tokens (a bare key means true; a
 * token without `=` after a key continues that key's list). Plain query params fill in what `filters` lacks.
 */
export function parseOptions(rawFilters: string, tokens: string[], query: URLSearchParams): Options {
  const out: Options = {};
  for (const [k, v] of query) if (!RESERVED.has(k)) out[k] = v;
  const raw = rawFilters.trim();
  if (raw.startsWith("{")) {
    try {
      const j: unknown = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) Object.assign(out, j);
    } catch {
      // not JSON after all: ignore rather than fail the request
    }
    return out;
  }
  let last: string | undefined;
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq > 0) {
      last = tok.slice(0, eq);
      out[last] = tok.slice(eq + 1);
    } else if (last !== undefined && typeof out[last] === "string" && !/^(true|false)$/.test(tok)) {
      out[last] = `${out[last]}|${tok}`;
    } else {
      out[tok] = true;
      last = undefined;
    }
  }
  return out;
}

export function optBool(p: ViewParams, key: string, dflt: boolean): boolean {
  const v = p.options?.[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return !(v === "false" || v === "0" || v === "");
  return dflt;
}

/** A list from a JSON array or a `|`- (or `,`-) separated string. `undefined` when the option is absent. */
export function optList(p: ViewParams, key: string): string[] | undefined {
  const v = p.options?.[key];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[|,]/).filter(Boolean);
  return undefined;
}

export function optInt(p: ViewParams, key: string): number | undefined {
  const v = p.options?.[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v);
  return undefined;
}

export function getOrInit<K, V>(m: Map<K, V>, key: K, init: () => V): V {
  let v = m.get(key);
  if (v === undefined) {
    v = init();
    m.set(key, v);
  }
  return v;
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TEST_DIRS = new Set(["__tests__", "e2e", "tests", "test"]);
export function isTestPath(path: string): boolean {
  const segs = path.split("/");
  const base = segs[segs.length - 1] ?? "";
  return /\.(?:test|spec)\./.test(base) || segs.slice(0, -1).some((s) => TEST_DIRS.has(s));
}
