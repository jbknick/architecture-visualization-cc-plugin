import { resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { removeDataDir, uninstallHooks } from "../hooks/install.js";
import { EXIT_OK, fail } from "./shared.js";

export function registerUninstall(program: Command): void {
  program
    .command("uninstall")
    .description("Remove Gantry's git hooks from this repo and delete its data directory")
    .option("--keep-data", "keep the index and logs")
    .action((opts: { keepData?: boolean }) => {
      try {
        const paths = resolvePaths(process.cwd());
        uninstallHooks(paths);
        if (!opts.keepData) removeDataDir(paths);
        process.stdout.write(`Uninstalled Gantry${opts.keepData ? " (data kept)" : ""}\n`);
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
