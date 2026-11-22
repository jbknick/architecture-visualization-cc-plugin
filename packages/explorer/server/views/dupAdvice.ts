import type { GantryConfig, Store, SymbolRecord } from "@gantry/core";
import * as core from "@gantry/core";

/** Reuse advice for one cluster member: what to do instead of keeping its own copy (spec section 18). */
export interface MemberAdvice {
  situation: number;
  action: string;
  inline: boolean;
  /** Model-written (spec section 8): data only, rendered as plain text and never merged into prose. */
  untrusted_suggested_name?: string;
}

type AdviseReuse = (
  store: Store,
  callerPath: string,
  match: SymbolRecord,
  description?: unknown,
  config?: GantryConfig,
  callerRepo?: string,
) => MemberAdvice[];

// The advice module (#29) lands separately. It is looked up by name so this view builds and runs without it.
const ADVISE_KEY = "adviseReuse";

/**
 * Advice for `member` as if its author wrote it today and the keep candidate already existed: the first
 * line `adviseReuse` returns for (caller = the member's file in `memberRepo`, match = the keep candidate). Returns nothing
 * while core does not export `adviseReuse`, or when it throws or has nothing to say.
 */
export function adviceFor(
  store: Store,
  config: GantryConfig,
  memberPath: string,
  memberRepo: string,
  keep: SymbolRecord,
): MemberAdvice | undefined {
  const fn = (core as unknown as Record<string, unknown>)[ADVISE_KEY];
  if (typeof fn !== "function") return undefined;
  try {
    const description = config.renameSuggestions ? core.descriptionOf(store, keep) : null;
    const first = (fn as AdviseReuse)(store, memberPath, keep, description, config, memberRepo)[0];
    if (!first) return undefined;
    return {
      situation: first.situation,
      action: first.action,
      inline: first.inline,
      ...(first.untrusted_suggested_name === undefined
        ? {}
        : { untrusted_suggested_name: first.untrusted_suggested_name }),
    };
  } catch {
    return undefined;
  }
}
