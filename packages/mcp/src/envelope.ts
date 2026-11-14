// The one response shape every tool uses (spec section 15): a single `text` block holding JSON of at most
// MAX_RESPONSE_CHARS characters. Arrays are trimmed from the end when the result is too long and the payload says so.

export const MAX_RESPONSE_CHARS = 4000;

export interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const size = (v: unknown): number => JSON.stringify(v).length;

/** Longest array (by serialized size) anywhere in the tree that still has elements; `undefined` when none. */
function longestArray(
  v: unknown,
  best: { arr?: unknown[]; len: number } = { len: -1 },
): unknown[] | undefined {
  if (Array.isArray(v)) {
    if (v.length > 0) {
      const len = size(v);
      if (len > best.len) {
        best.arr = v;
        best.len = len;
      }
    }
    for (const x of v) longestArray(x, best);
  } else if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) longestArray(x, best);
  }
  return best.arr;
}

const TOO_LARGE = { error: "response_too_large", message: "The result does not fit in one response." };

/** `result` as JSON text within the limit. Trims arrays from the end (largest first) and sets `truncated: true`. */
export function fitJson(result: unknown, limit = MAX_RESPONSE_CHARS): string {
  // A private copy: trimming must not touch the caller's data.
  const plain = JSON.parse(JSON.stringify(result ?? null)) as Json;
  let text = JSON.stringify(plain);
  if (text.length <= limit) return text;
  if (plain === null || typeof plain !== "object" || Array.isArray(plain)) return JSON.stringify(TOO_LARGE);
  (plain as { [k: string]: Json }).truncated = true;
  for (;;) {
    text = JSON.stringify(plain);
    if (text.length <= limit) return text;
    const arr = longestArray(plain);
    if (!arr) break;
    arr.pop();
  }
  return JSON.stringify({ ...TOO_LARGE, truncated: true });
}

/** A successful tool response. */
export function envelope(result: unknown, limit = MAX_RESPONSE_CHARS): ToolResponse {
  return { content: [{ type: "text", text: fitJson(result, limit) }] };
}

/** A failed tool response: `isError: true` and `{ error, message }`. */
export function errorEnvelope(code: string, message: string): ToolResponse {
  return {
    content: [{ type: "text", text: fitJson({ error: code, message: message.slice(0, 500) }) }],
    isError: true,
  };
}
