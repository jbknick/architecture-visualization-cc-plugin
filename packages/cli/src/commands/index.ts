import {
  dumpGraph,
  ensureDataDir,
  indexRepo,
  type Layer,
  openStore,
  reattachOverlay,
  resetStaleStore,
} from "@gantry/core";
import type { Command } from "commander";
import { noteFreshIndex } from "./init.js";
import {
  EXIT_ERROR,
  EXIT_OK,
  fail,
  recipeLines,
  resolveCliPaths,
  summaryLines,
  WORKSPACE_FLAG,
  writeStdout,
} from "./shared.js";

export function registerIndex(program: Command): void {
  program
    .command("index")
    .description("Run the deterministic index; --dump prints the sorted graph as JSON")
    .option("--files <paths...>", "re-index only these repo-relative files")
    .option("--layer <layer>", "main or working", "main")
    .option("--dump", "print the sorted graph JSON on stdout (summary goes to stderr)")
    .option(...WORKSPACE_FLAG)
    .action(async (opts: { files?: string[]; layer: string; dump?: boolean; workspace?: string }) => {
      try {
        if (opts.layer !== "main" && opts.layer !== "working") {
          process.stderr.write(`gantry: --layer must be "main" or "working"\n`);
          process.exitCode = EXIT_ERROR;
          return;
        }
        const paths = resolveCliPaths(opts);
        resetStaleStore(paths);
        if (opts.layer === "main" && !opts.files) noteFreshIndex(paths);
        ensureDataDir(paths);
        const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
        try {
          const r = await indexRepo(paths, { layer: opts.layer as Layer, files: opts.files, store });
          reattachOverlay(store);
          if (!opts.files) for (const line of recipeLines(r)) process.stderr.write(`${line}\n`);
          if (opts.dump) {
            for (const line of summaryLines(r, paths.dataDir)) process.stderr.write(`${line}\n`);
            writeStdout(`${JSON.stringify(dumpGraph(store), null, 2)}\n`);
          } else {
            for (const line of summaryLines(r, paths.dataDir)) process.stdout.write(`${line}\n`);
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
