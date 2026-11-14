import { ftsSearch, type SymbolKind } from "@gantry/core";
import type { Command } from "commander";
import { openFresh, table } from "./lookup.js";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

const KINDS: readonly SymbolKind[] = [
  "function",
  "method",
  "component",
  "hook",
  "class",
  "type",
  "interface",
  "enum",
  "const",
];

export function registerSearch(program: Command): void {
  program
    .command("search")
    .description("Full-text search over symbol names and paths")
    .argument("<q>", "search text, e.g. a name or words from one")
    .option("--kind <kind...>", `restrict to kinds (${KINDS.join(", ")})`)
    .option("--limit <n>", "maximum results", "20")
    .option("--json", "print JSON")
    .action(async (q: string, opts: { kind?: string[]; limit: string; json?: boolean }) => {
      try {
        const kinds = opts.kind?.flatMap((k) => k.split(",")).filter(Boolean) ?? [];
        const bad = kinds.find((k) => !KINDS.includes(k as SymbolKind));
        if (bad) throw new Error(`Unknown --kind '${bad}' (expected one of ${KINDS.join(", ")})`);
        const limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid --limit: ${opts.limit}`);
        const { store } = await openFresh(process.cwd());
        try {
          const hits = ftsSearch(store, q, { kind: kinds as SymbolKind[], limit });
          if (opts.json) writeStdout(`${JSON.stringify(hits, null, 2)}\n`);
          else if (hits.length === 0) writeStdout("No matches\n");
          else {
            writeStdout(
              table(
                ["NAME", "KIND", "LOCATION", "SCORE"],
                hits.map((h) => [h.name, h.kind, `${h.path}:${h.line}`, h.score.toFixed(2)]),
              ),
            );
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
