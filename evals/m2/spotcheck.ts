/**
 * Draws the operator's spot-check sample: 20 of the alerts the hook raises at the configured defaults (the
 * ones the false-alert figure is about), 10 labelled true and 10 labelled false when there are that many,
 * in a fixed order (by the opaque id). Prints opaque ids only: the first 8 hex digits of a hash of the alert key.
 * The key for each id is written to `$GANTRY_PRIVATE_DIR/m2/spotcheck.json`.
 *
 * Usage: pnpm tsx evals/m2/spotcheck.ts
 */
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG_THRESHOLDS } from "./defaults.js";
import { readPrivate, writePrivate } from "./lib.js";
import { findingsFor, type Labels, loadEdits } from "./sweep.js";

const labels = readPrivate<Labels>("labels.json");
const keys = [...new Set(loadEdits().flatMap((e) => findingsFor(e, DEFAULT_CONFIG_THRESHOLDS)))];
const opaque = (k: string): string => createHash("sha256").update(k).digest("hex").slice(0, 8);
const byId = (a: string, b: string): number => (opaque(a) < opaque(b) ? -1 : 1);
const trues = keys.filter((k) => labels[k]).sort(byId);
const falses = keys.filter((k) => labels[k] === false).sort(byId);
const pick = [...trues.slice(0, 10), ...falses.slice(0, 10)];
if (pick.length < 20) pick.push(...[...trues.slice(10), ...falses.slice(10)].slice(0, 20 - pick.length));
writePrivate(
  "spotcheck.json",
  pick.map((k) => ({ id: opaque(k), key: k, label: labels[k] })),
);
process.stdout.write(
  `${keys.length} alerts at the defaults; sample of ${pick.length}\nlabelled true: ${trues
    .slice(0, 10)
    .map(opaque)
    .join(", ")}\nlabelled false: ${falses.slice(0, 10).map(opaque).join(", ")}\n`,
);
