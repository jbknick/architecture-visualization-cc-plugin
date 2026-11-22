import {
  cachedEmbedder,
  describedByOf,
  hybridSearch,
  isLang,
  LANG_IDS,
  type Lang,
  langLabel,
  type SymbolKind,
} from "@gantry/core";
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
    .description(
      "Hybrid search: keywords over names, paths and descriptions, plus meaning when the embedding model is cached",
    )
    .argument("<q>", "search text, e.g. a name or words from one")
    .option("--kind <kind...>", `restrict to kinds (${KINDS.join(", ")})`)
    .option("--lang <lang>", `restrict to a language (${LANG_IDS.join(", ")})`)
    .option("--repo <name>", "only symbols of this repo of the workspace")
    .option("--limit <n>", "maximum results", "20")
    .option("--json", "print JSON")
    .action(
      async (
        q: string,
        opts: { kind?: string[]; lang?: string; repo?: string; limit: string; json?: boolean },
      ) => {
        try {
          const kinds = opts.kind?.flatMap((k) => k.split(",")).filter(Boolean) ?? [];
          const bad = kinds.find((k) => !KINDS.includes(k as SymbolKind));
          if (bad) throw new Error(`Unknown --kind '${bad}' (expected one of ${KINDS.join(", ")})`);
          if (opts.lang !== undefined && !isLang(opts.lang)) {
            throw new Error(`Unknown --lang '${opts.lang}' (expected one of ${LANG_IDS.join(", ")})`);
          }
          const lang = opts.lang as Lang | undefined;
          const limit = Number(opts.limit);
          if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid --limit: ${opts.limit}`);
          const { store } = await openFresh(process.cwd());
          try {
            const embedder = await cachedEmbedder()();
            const hits = await hybridSearch(store, q, {
              kind: kinds as SymbolKind[],
              ...(lang !== undefined ? { lang } : {}),
              ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
              limit,
              ...(embedder ? { embedder } : {}),
            });
            // Description text is untrusted (spec section 8): it leaves only as untrusted_description, with its provenance.
            const json = hits.map(({ description, ...h }) => ({
              ...h,
              untrusted_description: description,
              ...(description !== null
                ? { described_by: describedByOf(store, store.getSymbol(h.id)) ?? undefined }
                : {}),
            }));
            if (opts.json) writeStdout(`${JSON.stringify(json, null, 2)}\n`);
            else if (hits.length === 0) writeStdout("No matches\n");
            else {
              // The repo label only appears when the workspace has more than one repo.
              const label = store.listRepos().length > 1;
              writeStdout(
                table(
                  ["NAME", "KIND", "LANG", "LOCATION", "SCORE"],
                  hits.map((h) => [
                    label ? `[${h.repo}] ${h.name}` : h.name,
                    h.kind,
                    langLabel(h.lang),
                    `${h.path}:${h.line}`,
                    h.score.toFixed(4),
                  ]),
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
      },
    );
}
