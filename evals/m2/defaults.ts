import { loadConfigForDb } from "../../packages/core/src/index.js";

/** The duplicate thresholds a fresh install gets (no project or global config): what `run-m2.ts` scores the replay at. */
export const DEFAULT_THRESHOLDS = loadConfigForDb("/nonexistent/gantry.db", { HOME: "/nonexistent" })
  .duplicates.thresholds;
export const DEFAULT_CONFIG_THRESHOLDS = {
  nearJaccard: DEFAULT_THRESHOLDS.nearJaccard,
  nearTokenJaccard: DEFAULT_THRESHOLDS.nearTokenJaccard,
  codeVectorTokenJaccard: DEFAULT_THRESHOLDS.codeVectorTokenJaccard,
  codeVector: DEFAULT_THRESHOLDS.codeVector,
};
