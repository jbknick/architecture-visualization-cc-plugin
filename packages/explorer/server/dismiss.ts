import { dismiss } from "@gantry/core";
import { HttpError } from "./errors.js";
import type { ApiContext } from "./types.js";
import { buildDuplicates, type DuplicatesResult } from "./views/duplicates.js";

/** `PUT /api/dismiss` bodies are three short strings. */
export const MAX_DISMISS_BODY_BYTES = 4 * 1024;
export const MAX_DISMISS_REASON = 200;
const MAX_ID_LENGTH = 1024;

export interface DismissBody {
  a: string;
  b: string;
  reason: string;
}

export interface DismissResult {
  dismissed: DismissBody;
  summary: DuplicatesResult["summary"];
  /** The groups that remain under the default options, best first. */
  clusters: { id: string; size: number }[];
}

function symbolId(ctx: ApiContext, value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new HttpError(400, `${name} must be a symbol id`);
  }
  if (!value.startsWith("sym:") || !ctx.store.getSymbol(value)) {
    throw new HttpError(404, `Unknown symbol: ${name}`);
  }
  return value;
}

/** Validates a parsed PUT body: `{ a, b, reason? }` with two existing, different symbol ids. */
export function parseDismissBody(ctx: ApiContext, body: unknown): DismissBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const o = body as Record<string, unknown>;
  const a = symbolId(ctx, o.a, "a");
  const b = symbolId(ctx, o.b, "b");
  if (a === b) throw new HttpError(400, "a and b must be different functions");
  const reason = o.reason ?? "";
  if (typeof reason !== "string") throw new HttpError(400, "reason must be a string");
  if (reason.length > MAX_DISMISS_REASON) {
    throw new HttpError(400, `reason must be at most ${MAX_DISMISS_REASON} characters`);
  }
  return { a, b, reason };
}

/**
 * `PUT /api/dismiss`: records that two functions are not duplicates (core `dismiss`, which also removes
 * their `similar_to` edge) and returns the recomputed summary. The pair stays hidden after a restart
 * and in the duplicate guard too, since both read the same `dismissals` table.
 */
export function putDismiss(ctx: ApiContext, body: unknown): DismissResult {
  const parsed = parseDismissBody(ctx, body);
  dismiss(ctx.store, parsed.a, parsed.b, parsed.reason);
  const view = buildDuplicates(ctx, { filters: [], options: {} });
  return {
    dismissed: parsed,
    summary: view.summary,
    clusters: view.clusters.map((c) => ({ id: c.id, size: c.size })),
  };
}
