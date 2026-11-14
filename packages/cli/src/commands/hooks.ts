import { fileURLToPath } from "node:url";
import { resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { installHooks, uninstallHooks } from "../hooks/install.js";
import { EXIT_OK, fail } from "./shared.js";

// Bundled to plugin/dist/cli.js, so this file is the CLI the shim must point at.
const cliPath = fileURLToPath(import.meta.url);

export function registerHooks(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Install or remove Gantry's git hooks in the current repo");
  hooks
    .command("install")
    .description("Write ~/.gantry/bin/gantry and the git hooks, chaining any existing hooks")
    .action(() => {
      try {
        const r = installHooks(resolvePaths(process.cwd()), { cliPath });
        process.stdout.write(`Installed Gantry hooks in ${r.dir}\n`);
        for (const n of r.chained) process.stdout.write(`  chained existing ${n}\n`);
        for (const w of r.warnings) process.stderr.write(`gantry: ${w}\n`);
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
        const r = uninstallHooks(resolvePaths(process.cwd()));
        process.stdout.write(`Removed Gantry hooks (${r.restored.length} restored)\n`);
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
