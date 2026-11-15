/**
 * M2 eval driver (issue #32). Reprints every M2 table from the stored results, or re-runs the steps.
 *
 *   GANTRY_PRIVATE_DIR=<dir> pnpm tsx evals/run-m2.ts <copy>              reprint the tables
 *   GANTRY_PRIVATE_DIR=<dir> CLAUDE_PLUGIN_DATA=<data dir> pnpm tsx evals/run-m2.ts <copy> --rerun seeded|replay|label|timing
 *
 * <copy> is the throwaway copy of the private test bed (never the original). Raw results live in
 * `$GANTRY_PRIVATE_DIR/m2/`; this script prints counts, rates, timings and opaque ids only. Exits non-zero when an
 * acceptance line is missed. Run `pnpm build` first (the hook CLI is `plugin/dist/cli.js`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG_THRESHOLDS } from "./m2/defaults.js";
import { gantryRoot, pct, privateDir, readPrivate, table } from "./m2/lib.js";
import { printSeeded, type SeededResult } from "./m2/seeded-report.js";
import { type Labels, loadEdits, measure, runSweep, seededRecall } from "./m2/sweep.js";

const copy = process.argv[2];
const rerun = process.argv.indexOf("--rerun");
if (rerun >= 0) {
  const step = process.argv[rerun + 1];
  if (!copy || !["seeded", "replay", "label", "timing"].includes(step ?? "")) {
    process.stderr.write("usage: run-m2.ts <copy> --rerun seeded|replay|label|timing\n");
    process.exit(2);
  }
  const r = spawnSync("pnpm", ["tsx", join(gantryRoot, "evals", "m2", `${step}.ts`), resolve(copy)], {
    stdio: "inherit",
    cwd: gantryRoot,
  });
  process.exit(r.status ?? 1);
}

privateDir();
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const miss: string[] = [];

out("## Seeded duplicates\n");
if (existsSync(join(privateDir(), "seeded-results.json"))) {
  const seeded = readPrivate<SeededResult[]>("seeded-results.json");
  printSeeded(seeded);
  const found = seeded.filter((r) => r.adviceCorrect).length;
  const mis = seeded.filter((r) => r.misleading && r.adviceCorrect).length;
  if (found < 8 || mis < 2) miss.push(`seeded: ${found}/10 found with correct advice, ${mis}/3 misleading`);
}

if (existsSync(join(privateDir(), "replay.jsonl")) && existsSync(join(privateDir(), "labels.json"))) {
  const edits = loadEdits();
  const labels = readPrivate<Labels>("labels.json");
  const p = measure(edits, labels, DEFAULT_CONFIG_THRESHOLDS);
  out(`\n## Replay at the configured defaults (nearJaccard ${p.nearJaccard}, codeVector ${p.codeVector})\n`);
  out(
    table(
      ["edits", "edits with an alert", "alert rate", "alerts", "false alerts", "false rate", "unlabelled"],
      [
        [
          p.edits,
          p.editsAlerting,
          pct(p.editsAlerting, p.edits),
          p.alerts,
          p.falseAlerts,
          pct(p.falseAlerts, p.alerts),
          p.unlabelled,
        ],
      ],
    ),
  );
  if (p.alertRate >= 0.05 || p.falseRate >= 0.1)
    miss.push(`replay: alert rate ${pct(p.editsAlerting, p.edits)}, false ${pct(p.falseAlerts, p.alerts)}`);
  const sweep = runSweep();
  const meets = sweep.rows.filter((r) => r.alertRate < 0.05 && r.falseRate < 0.1);
  out(
    `\nSweep: ${meets.length} of ${sweep.rows.length} (nearJaccard, codeVector) settings meet both budgets.`,
  );
  const s = seededRecall(readPrivate<SeededResult[]>("seeded-results.json"), DEFAULT_CONFIG_THRESHOLDS);
  out(
    `Seeded recall at the defaults: product ${s.product}/10, with a computed draft vector ${s.withDraftVector}/10.`,
  );
}

if (existsSync(join(privateDir(), "timing.json"))) {
  const runs =
    readPrivate<
      {
        mode: string;
        run: number;
        wallMs: number;
        files: number;
        worker: { calls: number; functions: number; inputTokens: number; outputTokens: number };
      }[]
    >("timing.json");
  const modes = [...new Set(runs.map((r) => r.mode))];
  out("\n## Pre-commit wall time\n");
  out(
    table(
      ["mode", "files", "runs (ms)", "max (ms)", "worker calls / functions / tokens in / out (all runs)"],
      modes.map((m) => {
        const rs = runs.filter((r) => r.mode === m);
        return [
          m,
          rs[0]?.files ?? 0,
          rs.map((r) => r.wallMs).join(" / "),
          Math.max(...rs.map((r) => r.wallMs)),
          [
            rs.reduce((n, r) => n + r.worker.calls, 0),
            rs.reduce((n, r) => n + r.worker.functions, 0),
            rs.reduce((n, r) => n + r.worker.inputTokens, 0),
            rs.reduce((n, r) => n + r.worker.outputTokens, 0),
          ].join(" / "),
        ];
      }),
    ),
  );
  const off = Math.max(...runs.filter((r) => r.mode === "off").map((r) => r.wallMs));
  if (off > 8000) miss.push(`pre-commit in off mode took ${off} ms`);
}

if (miss.length > 0) {
  out(`\nMISSED: ${miss.join("; ")}`);
  process.exit(1);
}
