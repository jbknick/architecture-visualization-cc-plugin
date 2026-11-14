// `it` for tests that assert wall-clock time. The mutation runner (scripts/describe-mutations.ts) sets
// GANTRY_MUTATION_RUN, because a slow machine could otherwise turn a timing failure into a false "killed" mutation.
import { it } from "vitest";

export const MUTATION_RUN: boolean = process.env.GANTRY_MUTATION_RUN !== undefined;

export function itTiming(name: string, fn: () => void | Promise<void>): void {
  if (MUTATION_RUN) it.skip(name, fn);
  else it(name, fn);
}
