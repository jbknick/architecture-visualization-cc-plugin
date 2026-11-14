import { embedPending, indexRepo, openStore, resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { EXIT_OK, fail, summaryLines } from "./shared.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Create the data directory and run a full deterministic index of the current repo")
    .option("--estimate", "print counts only; no model calls (token projection arrives in M2)")
    .option("--exports-first", "accepted for forward compatibility; has no effect in M1")
    .action(async (opts: { estimate?: boolean }) => {
      try {
        const paths = resolvePaths(process.cwd());
        const r = await indexRepo(paths, { layer: "main" });
        for (const line of summaryLines(r, paths.dataDir)) process.stdout.write(`${line}\n`);
        // Embed-on-write: vectors for what was just indexed. Never fatal; `GANTRY_EMBED=0` skips it.
        if (!opts.estimate && process.env.GANTRY_EMBED !== "0") {
          const store = openStore(paths.dbPath);
          try {
            await embedPending(store, { root: paths.root });
          } catch (e) {
            process.stderr.write(
              `gantry: embedding skipped: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          } finally {
            store.close();
          }
        }
        if (opts.estimate) process.stdout.write("Descriptions not estimated until M2\n");
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
