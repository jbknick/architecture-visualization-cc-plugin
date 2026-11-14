import {
  type EmbedPendingResult,
  type EmbedProgress,
  embedPending,
  ensureDataDir,
  openStore,
  rebuildSimilarEdges,
  resolvePaths,
  type Store,
} from "@gantry/core";
import type { Command } from "commander";
import { EXIT_ERROR, EXIT_OK, fail, writeStdout } from "./shared.js";

const nf = new Intl.NumberFormat("en-US");
/** Minimum time between two progress lines on stderr. */
export const PROGRESS_INTERVAL_MS = 3000;
/** Exit code after Ctrl-C (128 + SIGINT). */
const EXIT_INTERRUPTED = 130;

/** "embedded 320/3,511 code, 42/min, about 75 min left" (the rate and the estimate need some elapsed time). */
export function progressLine(p: EmbedProgress): string {
  // Rate and estimate come from the current phase only: descriptions are much cheaper than code.
  const perMin = p.phaseElapsedMs > 0 ? (p.phaseDone / p.phaseElapsedMs) * 60_000 : 0;
  const head = `embedded ${nf.format(p.phaseDone)}/${nf.format(p.phaseTotal)} ${p.phase === "code" ? "code" : "descriptions"}`;
  if (perMin <= 0) return head;
  const left = Math.ceil((p.phaseTotal - p.phaseDone) / perMin);
  return `${head}, ${nf.format(Math.round(perMin))}/min, about ${nf.format(left)} min left`;
}

export interface RunEmbedOptions {
  limit?: number;
  budgetMs?: number;
}

/**
 * Runs `embedPending` with a throttled progress line on stderr and a SIGINT handler that stops after the
 * batch in flight (every batch is committed, so the store is consistent and the next run resumes). Shared by
 * `gantry embed` and `gantry init --embed`.
 */
export async function runEmbed(
  store: Store,
  root: string,
  opts: RunEmbedOptions = {},
): Promise<EmbedPendingResult & { interrupted: boolean }> {
  const ac = new AbortController();
  const onSigint = () => {
    if (ac.signal.aborted) process.exit(EXIT_INTERRUPTED);
    process.stderr.write("gantry: stopping after the current batch (Ctrl-C again to quit now)...\n");
    ac.abort();
  };
  process.on("SIGINT", onSigint);
  let lastPrint = Number.NEGATIVE_INFINITY;
  try {
    const result = await embedPending(store, {
      root,
      limit: opts.limit,
      timeBudgetMs: opts.budgetMs,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.elapsedMs - lastPrint < PROGRESS_INTERVAL_MS) return;
        lastPrint = p.elapsedMs;
        process.stderr.write(`${progressLine(p)}\n`);
      },
    });
    // New code vectors make new code_vector `similar_to` edges possible.
    if (result.code > 0) await rebuildSimilarEdges(store);
    return { ...result, interrupted: ac.signal.aborted };
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export function summaryOf(r: EmbedPendingResult & { interrupted?: boolean }): string[] {
  const lines = [
    `Embedded ${nf.format(r.code)} code and ${nf.format(r.descriptions)} description vectors`,
    `  remaining:      ${nf.format(r.remainingCode)} code, ${nf.format(r.remainingDescriptions)} descriptions`,
    `  below the floor: ${nf.format(r.belowFloor)} functions with fewer than 3 statements (code not embedded)`,
  ];
  if (r.stoppedBy === "limit") lines.push("  stopped at --limit; run `gantry embed` again to continue");
  if (r.stoppedBy === "budget") lines.push("  stopped at --budget-ms; run `gantry embed` again to continue");
  if (r.stoppedBy === "aborted") lines.push("  interrupted; run `gantry embed` again to continue");
  if (r.stoppedBy === "unavailable")
    lines.push("  nothing stored: sqlite-vec or the embedding model is unavailable");
  return lines;
}

const parseCount = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number`);
  return Math.floor(n);
};

export function registerEmbed(program: Command): void {
  program
    .command("embed")
    .description("Embed the code and descriptions that have no vector yet (resumable; init never does this)")
    .option("--limit <n>", "store at most this many vectors in this run")
    .option("--budget-ms <n>", "stop starting new batches after this many milliseconds")
    .option("--json", "print the result as JSON on stdout")
    .action(async (opts: { limit?: string; budgetMs?: string; json?: boolean }) => {
      try {
        const limit = parseCount(opts.limit, "--limit");
        const budgetMs = parseCount(opts.budgetMs, "--budget-ms");
        const paths = resolvePaths(process.cwd());
        ensureDataDir(paths);
        const store = openStore(paths.dbPath);
        try {
          const r = await runEmbed(store, paths.root, { limit, budgetMs });
          if (opts.json) writeStdout(`${JSON.stringify(r, null, 2)}\n`);
          else for (const line of summaryOf(r)) process.stdout.write(`${line}\n`);
          process.exitCode = r.interrupted
            ? EXIT_INTERRUPTED
            : r.stoppedBy === "unavailable"
              ? EXIT_ERROR
              : EXIT_OK;
        } finally {
          store.close();
        }
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
