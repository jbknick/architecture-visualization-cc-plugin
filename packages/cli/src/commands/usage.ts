import fs from "node:fs";
import { openStore, resetStaleStore, resolvePaths, usageSummary } from "@gantry/core";
import type { Command } from "commander";
import { table } from "./lookup.js";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

export function registerUsage(program: Command): void {
  program
    .command("usage")
    .description("Model usage summary grouped by task and model")
    .option("--json", "print JSON")
    .action((opts: { json?: boolean }) => {
      try {
        const paths = resolvePaths(process.cwd());
        resetStaleStore(paths);
        // Read-only: no data dir is created for a repository that has no index (#147).
        const store = fs.existsSync(paths.dbPath) ? openStore(paths.dbPath) : undefined;
        try {
          const rows = store ? usageSummary(store) : [];
          if (opts.json) writeStdout(`${JSON.stringify(rows, null, 2)}\n`);
          else {
            writeStdout(
              table(
                ["TASK", "MODEL", "RUNS", "FUNCTIONS", "IN TOKENS", "OUT TOKENS", "COST USD"],
                rows.map((r) => [
                  r.task,
                  r.model,
                  String(r.runs),
                  String(r.functions),
                  String(r.inputTokens),
                  String(r.outputTokens),
                  r.costUsd.toFixed(4),
                ]),
              ),
            );
          }
        } finally {
          store?.close();
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
