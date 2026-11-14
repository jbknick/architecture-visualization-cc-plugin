import type { GantryConfig, Store, SymbolRecord } from "@gantry/core";
import * as core from "@gantry/core";

/** Reuse advice for one cluster member: what to do instead of keeping its own copy (spec section 18). */
export interface MemberAdvice {
  situation: number;
  action: string;
  inline: boolean;
}

type AdviseReuse = (
  store: Store,
  callerPath: string,
  match: SymbolRecord,
  description?: unknown,
  config?: GantryConfig,
) => { situation: number; action: string; inline: boolean }[];

// The advice module (#29) lands separately. It is looked up by name so this view builds and runs without it.
const ADVISE_KEY = "adviseReuse";

/**
 * Advice for `member` as if its author wrote it today and the keep candidate already existed: the first
 * line `adviseReuse` returns for (caller = the member's file, match = the keep candidate). Returns nothing
 * while core does not export `adviseReuse`, or when it throws or has nothing to say.
 */
export function adviceFor(
  store: Store,
  config: GantryConfig,
  memberPath: string,
  keep: SymbolRecord,
): MemberAdvice | undefined {
  const fn = (core as unknown as Record<string, unknown>)[ADVISE_KEY];
  if (typeof fn !== "function") return undefined;
  try {
    const first = (fn as AdviseReuse)(store, memberPath, keep, null, config)[0];
    return first ? { situation: first.situation, action: first.action, inline: first.inline } : undefined;
  } catch {
    return undefined;
  }
}
