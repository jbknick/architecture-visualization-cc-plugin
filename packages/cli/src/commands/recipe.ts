import {
  checkRecipeFile,
  DEFAULT_NODE_LIMIT,
  listRecipeNodes,
  loadRecipe,
  RECIPE_NODE_KINDS,
  type RecipeCheck,
  type RecipeGap,
  type RecipeNodes,
  readRecipeFile,
  recipeCheckOk,
  resolvePaths,
} from "@gantry/core";
import type { Command } from "commander";
import { openFresh } from "./lookup.js";
import { EXIT_ERROR, EXIT_OK, fail, writeStdout } from "./shared.js";

const PLURAL: Record<(typeof RECIPE_NODE_KINDS)[number], string> = {
  route: "routes",
  endpoint: "endpoints",
  middleware: "middleware",
  table: "tables",
  read: "reads",
  write: "writes",
};

/** The nodes block of the text form: totals, then each kind's entries (`kind label file:line`), bounded per kind. */
export function recipeNodesText(n: RecipeNodes): string[] {
  const lines = [`nodes the index makes from this recipe (at most ${n.limit} of each kind shown):`];
  lines.push(`  ${RECIPE_NODE_KINDS.map((k) => `${n.totals[k]} ${PLURAL[k]}`).join(", ")}`);
  for (const k of RECIPE_NODE_KINDS) {
    const mine = n.entries.filter((e) => e.kind === k);
    for (const e of mine) {
      const at = e.line === null ? e.file : `${e.file}:${e.line}`;
      lines.push(`  ${k} ${e.label}  ${at}${e.in ? `  in ${e.in}` : ""}`);
    }
    if (n.totals[k] > mine.length) {
      lines.push(`  ... ${n.totals[k] - mine.length} more ${PLURAL[k]} (raise --limit to see them)`);
    }
  }
  return lines;
}

/** The text form: one line per rule, a warning line under a rule that matches nothing, then the problems. */
export function recipeCheckText(c: RecipeCheck, nodes?: RecipeNodes): string {
  const lines: string[] = [];
  for (const r of c.rules) {
    const failed = r.examples.failed.length;
    const schema = r.valid ? "schema ok" : "schema FAILED";
    const examples =
      failed > 0
        ? `examples FAILED (${r.examples.passed} passed, ${failed} failed)`
        : `examples ok (${r.examples.passed} passed)`;
    lines.push(`${r.id}: ${schema}, ${examples}, ${r.matches} ${r.matches === 1 ? "match" : "matches"}`);
    for (const f of r.examples.failed) lines.push(`  failed ${f}`);
    if (r.warning) lines.push(`  warning: ${r.warning}`);
  }
  for (const e of c.errors) lines.push(`error: ${e}`);
  if (nodes) lines.push(...recipeNodesText(nodes));
  lines.push(recipeCheckOk(c) ? "recipe ok" : "recipe has problems");
  return `${lines.join("\n")}\n`;
}

/** The text form of `gantry recipe gaps`: one line per open gap in id order, then the counts. */
export function recipeGapsText(gaps: readonly RecipeGap[], dismissed: number): string {
  const lines = gaps.map((g) => `${g.kind} ${g.file}:${g.line} ${g.detail}`);
  lines.push(`${gaps.length} open, ${dismissed} dismissed`);
  return `${lines.join("\n")}\n`;
}

export const RECIPE_CHECK_USAGE =
  "gantry recipe check takes one recipe file: `gantry recipe check [<file>] [--nodes] [--limit <n>] [--json]`. " +
  "It checks the repository of the current directory, so run it from the repo (there is no path to check); " +
  "with no file it reads .gantry/recipe.json.";

export function registerRecipe(program: Command): void {
  const recipe = program.command("recipe").description("The repository's recipe (.gantry/recipe.json)");
  recipe
    .command("check")
    .description(
      "Validate a recipe, run every rule's examples, count each rule's matches in this repo and, with --nodes, list the nodes the index makes from it",
    )
    .argument("[file]", "the recipe to check (default .gantry/recipe.json)")
    .option(
      "--nodes",
      "list the routes, endpoints, middleware, tables, reads and writes the index makes (file:line)",
    )
    .option("--limit <n>", `with --nodes: entries shown per kind (default ${DEFAULT_NODE_LIMIT})`)
    .option("--json", "print { rules, errors } as JSON (with --nodes also { nodes })")
    .allowExcessArguments(true)
    .action(
      async (file: string | undefined, opts: { json?: boolean; nodes?: boolean; limit?: string }, cmd) => {
        try {
          if (cmd.args.length > 1) {
            process.stderr.write(
              `gantry: unexpected extra argument "${cmd.args[1]}". ${RECIPE_CHECK_USAGE}\n`,
            );
            process.exitCode = EXIT_ERROR;
            return;
          }
          let limit = DEFAULT_NODE_LIMIT;
          if (opts.limit !== undefined) {
            limit = Number(opts.limit);
            if (!Number.isInteger(limit) || limit < 1) {
              process.stderr.write(
                `gantry: --limit takes a whole number of 1 or more, got "${opts.limit}"\n`,
              );
              process.exitCode = EXIT_ERROR;
              return;
            }
          }
          const paths = resolvePaths(process.cwd());
          const c = checkRecipeFile(paths, file);
          const text = opts.nodes ? readRecipeFile(paths, file) : null;
          const nodes = text === null ? undefined : await listRecipeNodes(paths, text, { limit });
          writeStdout(
            opts.json
              ? `${JSON.stringify(nodes ? { ...c, nodes } : c, null, 2)}\n`
              : recipeCheckText(c, nodes),
          );
          process.exitCode = recipeCheckOk(c) ? EXIT_OK : EXIT_ERROR;
        } catch (err) {
          process.exitCode = fail(err);
        }
      },
    );
  recipe
    .command("gaps")
    .description(
      "List the code the recipe does not cover: dependencies, unmatched client calls and route or SQL sites",
    )
    .option("--json", "print { gaps: [{ id, kind, file, line, detail }], dismissed: <n> } as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const { paths, store } = await openFresh(process.cwd());
        let stored: RecipeGap[];
        try {
          stored = store.effectiveGaps();
        } finally {
          store.close();
        }
        // The recipe on disk decides what is dismissed, so an entry written and not yet committed hides its gap too.
        const dismissedList = loadRecipe(paths.root, { layer: "working" }).recipe?.dismissed ?? [];
        const ids = new Set(dismissedList.map((d) => d.id));
        const gaps = stored.filter((g) => !ids.has(g.id));
        const dismissed = dismissedList.length;
        writeStdout(
          opts.json ? `${JSON.stringify({ gaps, dismissed }, null, 2)}\n` : recipeGapsText(gaps, dismissed),
        );
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
