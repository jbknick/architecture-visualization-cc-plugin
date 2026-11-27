/**
 * The last check before an upload body leaves the process, or is printed by a dry run. `assertNoSource` walks any
 * JSON value and refuses one that could carry source code: a key named like the place source lives in, a `source`
 * that is not one of the two change set origins, or a string too long to be a name, path or one-sentence description.
 * It is a second line of defence behind the strict request schemas: it looks at the value that is about to be
 * written, not at what the schema was told to expect.
 */

/** Thrown by `assertNoSource`. `path` names the first offending field, for example `symbols[3].signature`. */
export class UploadRefused extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`upload refused: field ${path} may carry source`);
    this.name = "UploadRefused";
    this.path = path;
  }
}

import { MAX_STRING_LENGTH } from "./schemas.js";

/** Keys that are never allowed at any depth, compared after lower-casing and dropping `_` and `-`. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "signature",
  "body",
  "text",
  "code",
  "snippet",
  "doc",
  "content",
  "contents",
  "factsheet",
]);

/** The only strings a `source` key may hold (the change set's own origin field). */
const SOURCE_VALUES: ReadonlySet<string> = new Set(["pr", "branch"]);

/** Deeper than any payload of the protocol; a value this deep (or one that loops back on itself) is refused. */
const MAX_DEPTH = 32;

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

const shown = (key: string): string => (key.length > 80 ? `${key.slice(0, 80)}...` : key);
const field = (path: string, key: string): string => (path === "" ? shown(key) : `${path}.${shown(key)}`);

function walk(value: unknown, path: string, depth: number): void {
  const here = path === "" ? "$" : path;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new UploadRefused(here);
    return;
  }
  if (value === null || value === undefined || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UploadRefused(here);
    return;
  }
  // bigint, symbol and function values have no JSON form (and a function could be a `toJSON`).
  if (typeof value !== "object") throw new UploadRefused(here);
  if (depth >= MAX_DEPTH) throw new UploadRefused(here);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walk(value[i], `${path}[${i}]`, depth + 1);
    return;
  }
  // Only plain objects: a Map, a Buffer, a Date or a class instance can write something other than what it holds.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new UploadRefused(here);
  for (const key of Object.keys(value)) {
    const where = field(path, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // A getter could answer differently when the value is read again to be written.
    if (descriptor === undefined || !("value" in descriptor)) throw new UploadRefused(where);
    const normal = normaliseKey(key);
    if (key.length > MAX_STRING_LENGTH || FORBIDDEN_KEYS.has(normal)) throw new UploadRefused(where);
    const child: unknown = descriptor.value;
    if (normal === "source" && !(typeof child === "string" && SOURCE_VALUES.has(child))) {
      throw new UploadRefused(where);
    }
    walk(child, where, depth + 1);
  }
}

/** Throws `UploadRefused` for the first field of `payload` that could carry source; returns when there is none. */
export function assertNoSource(payload: unknown): void {
  walk(payload, "", 0);
}
