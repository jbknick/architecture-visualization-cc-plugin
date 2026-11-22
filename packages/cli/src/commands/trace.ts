import { type TraceResult, trace } from "@gantry/core";
import type { Command } from "commander";
import { openFresh } from "./lookup.js";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

/** The text form: one line per step, indented by depth and led by `[repo]` when the workspace has several repos, then the gaps. */
export function traceText(r: TraceResult): string {
  const lines = [`${r.direction === "down" ? "Down" : "Up"} from ${r.target}`];
  for (const s of r.chain) {
    if (s.depth === 0) continue;
    const low = s.confidence === "low" ? " (low confidence)" : "";
    const repo = s.repo === undefined ? "" : `[${s.repo}] `;
    lines.push(`${"  ".repeat(s.depth)}${repo}${s.via} → ${s.kind} ${s.id}${low}`);
  }
  if (r.chain.length <= 1) lines.push("  (nothing reached)");
  if (r.omitted > 0)
    lines.push(`${r.omitted} visited nodes lead to no endpoint, table or route and are not shown.`);
  if (r.truncated) lines.push("Stopped at the node budget; the chain is incomplete.");
  if (r.gaps.length > 0) lines.push("Gaps:", ...r.gaps.map((g) => `  ${g}`));
  return `${lines.join("\n")}\n`;
}

export function registerTrace(program: Command): void {
  program
    .command("trace")
    .description("Page → API → table chain from a route, endpoint, table, symbol or path")
    .argument(
      "<target>",
      "route:<ws>:<route id>, a route path, ep:..., table:<name>, sym:..., path or path:line",
    )
    .option("--up", "trace up toward the pages (default for a table)")
    .option("--down", "trace down toward the tables (default otherwise)")
    .option("--json", "print JSON")
    .action(async (target: string, opts: { json?: boolean; up?: boolean; down?: boolean }) => {
      try {
        if (opts.up && opts.down) throw new Error("Give at most one of --up and --down");
        const { store } = await openFresh(process.cwd());
        try {
          const direction = opts.up ? "up" : opts.down ? "down" : undefined;
          const r = trace(store, target, direction ? { direction } : {});
          if (!r) throw new Error(`No route, endpoint, table, symbol or file found for '${target}'`);
          writeStdout(opts.json ? `${JSON.stringify(r, null, 2)}\n` : traceText(r));
        } finally {
          store.close();
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
