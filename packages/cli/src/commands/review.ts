import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatImpact,
  type GantryPaths,
  type Impact,
  openStore,
  parseRange,
  resetStaleStore,
  resolvePaths,
  resolvePullRequest,
  reviewDiff,
  reviewImpact,
} from "@gantry/core";
import { buildExplorerUrl, ensureExplorer } from "@gantry/explorer";
import type { Command } from "commander";
import { openFresh } from "./lookup.js";
import { openBrowser } from "./map.js";
import { EXIT_ERROR, EXIT_OK, fail, writeStdout } from "./shared.js";

/** How long `--open` waits for a freshly started explorer. */
const CLI_START_TIMEOUT_MS = 10_000;
const PR_RE = /^[1-9]\d{0,8}$/;

/** This bundle (`plugin/dist/cli.js`), or the repo's bundle when running from source. */
function cliBundle(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "cli.js"), join(here, "..", "..", "..", "..", "plugin", "dist", "cli.js")].find((p) =>
    existsSync(p),
  );
}

/** Opens the review view the way `gantry_open_view` does (start or reuse the explorer); returns the URL. */
async function openReviewView(paths: GantryPaths, range: string): Promise<string> {
  // A command line can wait longer than `gantry_open_view`'s 3 s contract: a cold start on a large repo may need it.
  const r = await ensureExplorer({
    paths,
    cli: cliBundle(),
    env: process.env,
    timeoutMs: CLI_START_TIMEOUT_MS,
  });
  if (!r.ok) throw new Error(`cannot open the explorer: ${r.message}`);
  const url = buildExplorerUrl({ ...r.state, view: "review", filters: { range } });
  openBrowser(url);
  return url;
}

export function registerReview(program: Command): void {
  program
    .command("review [range]")
    .description(
      "Symbol-level diff between git refs (<base>...<head> or --pr <n>) with its impact; --json prints it as JSON, otherwise a short impact and risk summary; --open shows it in the explorer",
    )
    .option("--pr <n>", "review a pull request (needs gh); fetches its refs if missing")
    .option(
      "--json",
      "print the diff and its impact as JSON on stdout (read from git and the index as it is, no re-indexing)",
    )
    .option("--open", "open the review view of the explorer (starts it in the background if needed)")
    .action(async (range: string | undefined, opts: { pr?: string; json?: boolean; open?: boolean }) => {
      try {
        if ((range === undefined) === (opts.pr === undefined)) {
          process.stderr.write("gantry: give either <base>...<head> or --pr <n>\n");
          process.exitCode = EXIT_ERROR;
          return;
        }
        const paths = resolvePaths(process.cwd());
        resetStaleStore(paths);
        if (opts.pr !== undefined && !PR_RE.test(opts.pr)) {
          process.stderr.write(`gantry: invalid pull request number: ${opts.pr}\n`);
          process.exitCode = EXIT_ERROR;
          return;
        }
        const refs = range !== undefined ? parseRange(range) : resolvePullRequest(paths, Number(opts.pr));
        const resolved = `${refs.base}...${refs.head}`;
        if (opts.json) {
          const diff = await reviewDiff(paths, refs.base, refs.head);
          // The index as it is: never created, healed or re-indexed here, so `--json` stays fast and read-only.
          let impact: Impact | null = null;
          if (existsSync(paths.dbPath)) {
            const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
            try {
              impact = await reviewImpact(paths, store, diff);
            } finally {
              store.close();
            }
          }
          const url = opts.open ? await openReviewView(paths, resolved) : undefined;
          writeStdout(`${JSON.stringify({ ...diff, impact }, null, 2)}\n`);
          if (url) process.stderr.write(`Review view: ${url}\n`);
        } else {
          // The text summary walks the graph, so it brings the index to HEAD and the tree first.
          const { store } = await openFresh(process.cwd());
          let text: string;
          try {
            const diff = await reviewDiff(paths, refs.base, refs.head);
            text = formatImpact(diff, await reviewImpact(paths, store, diff));
          } finally {
            store.close();
          }
          const url = opts.open ? await openReviewView(paths, resolved) : undefined;
          writeStdout(url ? `${text}Review view: ${url}\n` : text);
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
