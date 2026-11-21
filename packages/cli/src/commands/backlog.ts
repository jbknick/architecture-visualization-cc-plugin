import fs from "node:fs";
import {
  type BacklogCounts,
  backlogCounts,
  failedItems,
  isIndexed,
  openStore,
  resetStaleStore,
  resolvePaths,
  retryFailed,
} from "@gantry/core";
import type { Command } from "commander";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

const EMPTY: BacklogCounts = {
  total: 0,
  byStatus: { pending: 0, claimed: 0, failed: 0 },
  byPriority: {},
  fallback: 0,
};

interface BacklogOpts {
  json?: boolean;
  failed?: boolean;
  retryFailed?: boolean;
}

export function registerBacklog(program: Command): void {
  program
    .command("backlog")
    .description(
      "Description backlog counts by status and by priority, and the data dir they come from; no model calls",
    )
    .option("--json", "print JSON")
    .option("--failed", "list the failed functions with the rule name of their last rejection")
    .option("--retry-failed", "put every failed function back to pending with its attempts reset")
    .action((opts: BacklogOpts) => {
      try {
        const paths = resolvePaths(process.cwd());
        resetStaleStore(paths);
        const where = { data_dir: paths.dataDir };
        // Read-only: a repository with no index here gets no data dir created (#147).
        if (!fs.existsSync(paths.dbPath)) {
          if (opts.json) {
            const body = opts.failed ? { failed: [] } : opts.retryFailed ? { retried: 0 } : EMPTY;
            writeStdout(`${JSON.stringify({ ...body, ...where, indexed: false }, null, 2)}\n`);
          } else {
            writeStdout(
              `${[`No Gantry index for this repository in ${paths.dataDir}. Run /gantry:init (or gantry init).`].join("\n")}\n`,
            );
          }
          process.exitCode = EXIT_OK;
          return;
        }
        const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
        try {
          const indexed = isIndexed(store);
          if (opts.retryFailed) {
            const retried = retryFailed(store);
            if (opts.json) writeStdout(`${JSON.stringify({ retried, ...where, indexed }, null, 2)}\n`);
            else writeStdout(`Put ${retried} failed function${retried === 1 ? "" : "s"} back to pending.\n`);
          } else if (opts.failed) {
            // Rule names only: the description text that failed is untrusted and is never shown (spec section 8).
            const items = failedItems(store);
            if (opts.json) {
              const failed = items.map((i) => ({
                content_key: i.contentKey,
                symbol_id: i.symbolId,
                attempts: i.attempts,
                reason: i.reason,
                ...(i.field ? { field: i.field } : {}),
              }));
              writeStdout(`${JSON.stringify({ failed, ...where, indexed }, null, 2)}\n`);
            } else {
              const lines = [
                `Failed: ${items.length}${items.length > 0 ? " (gantry backlog --retry-failed puts them back to pending)" : ""}`,
                ...items.map(
                  (i) =>
                    `  ${i.symbolId}  ${i.reason}${i.field ? ` (${i.field})` : ""}  attempts ${i.attempts}`,
                ),
              ];
              writeStdout(`${lines.join("\n")}\n`);
            }
          } else {
            const c = backlogCounts(store);
            if (opts.json) writeStdout(`${JSON.stringify({ ...c, ...where, indexed }, null, 2)}\n`);
            else {
              const s = c.byStatus;
              const lines = [
                `Backlog: ${c.total} (pending ${s.pending}, claimed ${s.claimed}, failed ${s.failed})`,
                ...Object.entries(c.byPriority).map(
                  ([p, v]) =>
                    `  priority ${p}: ${v.total} (pending ${v.pending}, claimed ${v.claimed}, failed ${v.failed})`,
                ),
                ...(c.fallback > 0 ? [`Fallback descriptions (written without a model): ${c.fallback}`] : []),
                `Data: ${paths.dataDir}`,
                ...(indexed
                  ? []
                  : [
                      "Not initialised: the backlog was never built here. Run /gantry:init (or gantry init).",
                    ]),
              ];
              writeStdout(`${lines.join("\n")}\n`);
            }
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
