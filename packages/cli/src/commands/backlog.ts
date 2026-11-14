import { backlogCounts, ensureDataDir, openStore, resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

export function registerBacklog(program: Command): void {
  program
    .command("backlog")
    .description("Description backlog counts by status and by priority; no model calls")
    .option("--json", "print JSON")
    .action((opts: { json?: boolean }) => {
      try {
        const paths = resolvePaths(process.cwd());
        ensureDataDir(paths);
        const store = openStore(paths.dbPath);
        try {
          const c = backlogCounts(store);
          if (opts.json) writeStdout(`${JSON.stringify(c, null, 2)}\n`);
          else {
            const s = c.byStatus;
            const lines = [
              `Backlog: ${c.total} (pending ${s.pending}, claimed ${s.claimed}, failed ${s.failed})`,
              ...Object.entries(c.byPriority).map(
                ([p, v]) =>
                  `  priority ${p}: ${v.total} (pending ${v.pending}, claimed ${v.claimed}, failed ${v.failed})`,
              ),
            ];
            writeStdout(`${lines.join("\n")}\n`);
          }
        } finally {
          store.close();
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
