import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Recipe, RecipeShellSchema, ruleSchemaFor, zodMessage } from "./schema.js";

export const RECIPE_PATH = ".gantry/recipe.json";

/** Which copy of the recipe to read: the one at `HEAD`, the one on disk, or the one at a git ref (review). */
export type RecipeSource = { layer: "main" } | { layer: "working" } | { ref: string };

export interface LoadedRecipe {
  /** Null when the file is absent, is not JSON, or fails the top-level schema. */
  recipe: Recipe | null;
  /** One entry per problem, without the `Gantry: ` prefix. Empty with `recipe: null` means there is no recipe file. */
  errors: string[];
  /** Ids of the rules dropped for failing their own schema (a rule with no readable id is `#<position>`). */
  skipped?: string[];
}

function readText(root: string, source: RecipeSource): string | null {
  if ("layer" in source && source.layer === "working") {
    try {
      return readFileSync(join(root, RECIPE_PATH), "utf8");
    } catch {
      return null;
    }
  }
  const ref = "ref" in source ? source.ref : "HEAD";
  try {
    return execFileSync("git", ["show", `${ref}:${RECIPE_PATH}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 26,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Reads and validates `.gantry/recipe.json`. A file that is not JSON or fails the top-level schema gives
 * `recipe: null` and one error. A rule that fails its own schema is dropped with an error naming its id and the zod
 * message, and the rest runs.
 */
export function loadRecipe(root: string, source: RecipeSource): LoadedRecipe {
  const text = readText(root, source);
  if (text === null) return { recipe: null, errors: [] };
  return parseRecipe(text);
}

export function parseRecipe(text: string): LoadedRecipe {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { recipe: null, errors: [`recipe ${RECIPE_PATH} ignored: not JSON (${(err as Error).message})`] };
  }
  const shell = RecipeShellSchema.safeParse(raw);
  if (!shell.success) {
    return { recipe: null, errors: [`recipe ${RECIPE_PATH} ignored: ${zodMessage(shell.error)}`] };
  }
  const errors: string[] = [];
  const skipped: string[] = [];
  const rules: Recipe["rules"] = [];
  const seen = new Set<string>();
  shell.data.rules.forEach((r, i) => {
    const rule = ruleSchemaFor(r).safeParse(r);
    const id =
      typeof (r as { id?: unknown } | null)?.id === "string" ? (r as { id: string }).id : `#${i + 1}`;
    if (!rule.success) {
      errors.push(`recipe rule ${id} skipped: ${zodMessage(rule.error)}`);
      skipped.push(id);
      return;
    }
    if (seen.has(rule.data.id)) {
      errors.push(`recipe rule ${id} skipped: duplicate rule id`);
      skipped.push(id);
      return;
    }
    seen.add(rule.data.id);
    rules.push(rule.data);
  });
  return { recipe: { ...shell.data, rules }, errors, skipped };
}

/**
 * The stderr lines `gantry init` and `gantry index` print for a loaded recipe (spec section 5): one per problem
 * with a recipe that is present. A repo with no recipe file gets none: it is not an error, and the built-in adapters
 * still map what they know.
 */
export function recipeNotes(loaded: LoadedRecipe): string[] {
  return loaded.errors.map((e) => `Gantry: ${e}`);
}
