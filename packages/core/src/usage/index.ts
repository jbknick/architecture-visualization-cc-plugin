import type { Store } from "../store/index.js";

export interface UsageRow {
  task: string;
  model: string;
  runs: number;
  functions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** `usage_log` summed per task and model, ordered by task then model. Empty until M2 writes rows. */
export function usageSummary(store: Store): UsageRow[] {
  const rows = store.db
    .prepare(
      `SELECT COALESCE(task, '') AS task, COALESCE(model, '') AS model, COUNT(*) AS runs,
              COALESCE(SUM(functions), 0) AS functions, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_estimate_usd), 0) AS cost
       FROM usage_log GROUP BY task, model ORDER BY task, model`,
    )
    .all() as {
    task: string;
    model: string;
    runs: number;
    functions: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  }[];
  return rows.map((r) => ({
    task: r.task,
    model: r.model,
    runs: r.runs,
    functions: r.functions,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost,
  }));
}
