import fs from "node:fs";
import { heal, resetStaleStore, resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { EXIT_OK, fail } from "./shared.js";

export function registerHeal(program: Command): void {
  program
    .command("heal")
    .description("Reconcile the main graph to HEAD (incremental, or a full re-index for huge diffs)")
    .option("--from <sha>", "diff from this commit instead of the recorded head_sha")
    .action(async (opts: { from?: string }) => {
      try {
        const paths = resolvePaths(process.cwd());
        resetStaleStore(paths);
        // Heal keeps an index current; it never creates one, so a run before `gantry init` leaves no empty data dir
        // behind (#147).
        if (!fs.existsSync(paths.dbPath)) {
          process.stderr.write(
            `gantry: no index for this repository in ${paths.dataDir}; run /gantry:init (or gantry init) first\n`,
          );
          process.exitCode = EXIT_OK;
          return;
        }
        const r = await heal(paths, { from: opts.from });
        process.stdout.write(
          `Healed ${r.changed} file${r.changed === 1 ? "" : "s"} (${r.full ? "full re-index" : "incremental"}) in ${r.ms} ms\n`,
        );
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
