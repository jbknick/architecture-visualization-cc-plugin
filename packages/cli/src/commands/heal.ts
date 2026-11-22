import fs from "node:fs";
import { heal, resetStaleStore } from "@gantry/core";
import type { Command } from "commander";
import { EXIT_OK, fail, resolveCliPaths, WORKSPACE_FLAG } from "./shared.js";

export function registerHeal(program: Command): void {
  program
    .command("heal")
    .description(
      "Reconcile the main graph to HEAD, repo by repo (incremental, or a full re-index of a repo for huge diffs)",
    )
    .option("--from <sha>", "diff the repo you are in from this commit instead of the recorded head_sha")
    .option(...WORKSPACE_FLAG)
    .action(async (opts: { from?: string; workspace?: string }) => {
      try {
        const paths = resolveCliPaths(opts);
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
        const r = await heal(paths, {
          from: opts.from,
          reattach: true,
          repo: opts.from === undefined ? undefined : paths.repo,
        });
        process.stdout.write(
          `Healed ${r.changed} file${r.changed === 1 ? "" : "s"} (${r.full ? "full re-index" : "incremental"}) in ${r.ms} ms\n`,
        );
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
