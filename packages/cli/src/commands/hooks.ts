import { fileURLToPath } from "node:url";
import { resetStaleStore, resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { hookDataBase, installHooksInWorkspace, uninstallHooksInWorkspace } from "../hooks/install.js";
import { EXIT_OK, fail } from "./shared.js";

// Bundled to plugin/dist/cli.js, so this file is the CLI the shim must point at.
const cliPath = fileURLToPath(import.meta.url);

export function registerHooks(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Install or remove Gantry's git hooks in every repo of the current workspace");
  hooks
    .command("install")
    .description("Write ~/.gantry/bin/gantry and the git hooks, chaining any existing hooks")
    .action(() => {
      try {
        const paths = resolvePaths(process.cwd());
        resetStaleStore(paths);
        const results = installHooksInWorkspace(paths, { cliPath });
        if (hookDataBase(paths) === undefined) {
          process.stderr.write(
            `gantry: warning: no plugin data directory found; the git hooks will read ${paths.dataDir}. Run this from /gantry:init or set CLAUDE_PLUGIN_DATA.\n`,
          );
        }
        for (const r of results) {
          process.stdout.write(`Installed Gantry hooks in ${r.dir}\n`);
          for (const n of r.chained) process.stdout.write(`  chained existing ${n}\n`);
          for (const w of r.warnings) process.stderr.write(`gantry: ${w}\n`);
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
  hooks
    .command("uninstall")
    .description("Remove Gantry's git hooks and restore the previous ones")
    .action(() => {
      try {
        const paths = resolvePaths(process.cwd());
        resetStaleStore(paths);
        const restored = uninstallHooksInWorkspace(paths).reduce((n, r) => n + r.restored.length, 0);
        process.stdout.write(`Removed Gantry hooks (${restored} restored)\n`);
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
