import { loadConfig, resetStaleStore, resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { describeStaged } from "../hooks/staged.js";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

export function registerDescribe(program: Command): void {
  program
    .command("describe")
    .description("Describe undescribed functions with the headless worker (pre-commit describer)")
    .option("--staged", "describe the functions in the staged files")
    .option("--json", "print the result as JSON on stdout")
    .action(async (opts: { staged?: boolean; json?: boolean }) => {
      const startedAt = Date.now();
      try {
        process.exitCode = EXIT_OK;
        if (!opts.staged) {
          process.stderr.write("gantry: describe needs --staged\n");
          return;
        }
        if (process.env.GANTRY_WORKER === "1") return;
        const paths = resolvePaths(process.cwd());
        resetStaleStore(paths);
        if (loadConfig(paths).precommit.mode === "off") {
          process.stderr.write(
            "gantry: precommit.mode is off, nothing described (run `gantry config set precommit.mode timeboxed` to enable)\n",
          );
          return;
        }
        const r = await describeStaged(paths, { startedAt });
        if (opts.json) writeStdout(`${JSON.stringify(r ?? null, null, 2)}\n`);
        if (r) process.stderr.write(`gantry: described ${r.described}, queued ${r.queued}\n`);
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
