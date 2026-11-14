import type { TaskName } from "../config/index.js";
import type { Store } from "../store/index.js";

/**
 * Approximate list prices in US dollars per million tokens (input, output). These are an ESTIMATE kept in one
 * place: plan (subscription) users are not billed per token, so the number only shows relative weight between
 * models. Update the table when prices change; nothing else depends on it.
 */
export const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
};

/** Estimated cost of a call; 0 for a model that is not in the table. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(PRICE_PER_MTOK).find((k) => model.toLowerCase().includes(k));
  const p = key === undefined ? undefined : PRICE_PER_MTOK[key];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export interface UsageLogRow {
  task: TaskName;
  model: string;
  effort: string;
  functions: number;
  inputTokens?: number;
  outputTokens?: number;
  source: "worker" | "subagent" | "explainer";
}

/** Appends one `usage_log` row (spec section 9). `cost_estimate_usd` comes from `PRICE_PER_MTOK`. */
export function logUsage(store: Store, row: UsageLogRow): void {
  const cost = estimateCostUsd(row.model, row.inputTokens ?? 0, row.outputTokens ?? 0);
  store.db
    .prepare(
      `INSERT INTO usage_log(at, task, model, effort, functions, input_tokens, output_tokens, cost_estimate_usd, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      row.task,
      row.model,
      row.effort,
      row.functions,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      cost,
      row.source,
    );
}
