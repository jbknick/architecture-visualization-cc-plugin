import { checkRecipeFile, type RecipeCheck, recipeCheckOk, resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { EXIT_ERROR, EXIT_OK, fail, writeStdout } from "./shared.js";

/** The text form: one line per rule, a warning line under a rule that matches nothing, then the problems. */
export function recipeCheckText(c: RecipeCheck): string {
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
  lines.push(recipeCheckOk(c) ? "recipe ok" : "recipe has problems");
  return `${lines.join("\n")}\n`;
}

export function registerRecipe(program: Command): void {
  const recipe = program.command("recipe").description("The repository's recipe (.gantry/recipe.json)");
  recipe
    .command("check")
    .description("Validate a recipe, run every rule's examples and count each rule's matches in this repo")
    .argument("[file]", "the recipe to check (default .gantry/recipe.json)")
    .option("--json", "print { rules, errors } as JSON")
    .action((file: string | undefined, opts: { json?: boolean }) => {
      try {
        const paths = resolvePaths(process.cwd());
        const c = checkRecipeFile(paths, file);
        writeStdout(opts.json ? `${JSON.stringify(c, null, 2)}\n` : recipeCheckText(c));
        process.exitCode = recipeCheckOk(c) ? EXIT_OK : EXIT_ERROR;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
