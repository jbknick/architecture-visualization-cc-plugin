import type { GantryConfig, TaskName } from "../config/index.js";

/** Model and effort for a task, straight from `config.routing` (spec section 5). */
export function routeFor(
  task: TaskName,
  config: GantryConfig,
): { model: "haiku" | "sonnet" | "opus"; effort: "low" | "medium" | "high" } {
  const r = config.routing[task];
  return { model: r.model, effort: r.effort };
}
