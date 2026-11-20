import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@ast-grep/napi";
import { loadConfig } from "../config/index.js";
import { discoverFiles } from "../discover/index.js";
import { detectAllWorkspaces } from "../lang/index.js";
import type { GantryPaths } from "../paths/index.js";
import { astLang, findRule, rulesFor, runExamples } from "./engine.js";
import { parseRecipe, RECIPE_PATH } from "./load.js";

/** What `gantry recipe check` reports for one rule. */
export interface RuleCheck {
  id: string;
  /** The rule passed its schema and ast-grep accepts it. */
  valid: boolean;
  examples: { passed: number; failed: string[] };
  /** Matches of the rule in this repository's files. */
  matches: number;
  /** Zero matches: a warning, never a failure (the rule may be for a construct the repo does not use yet). */
  warning?: string;
}

export interface RecipeCheck {
  rules: RuleCheck[];
  errors: string[];
}

export const recipeCheckOk = (c: RecipeCheck): boolean =>
  c.errors.length === 0 && c.rules.every((r) => r.valid && r.examples.failed.length === 0);

/** Validates a recipe text: schema, every rule's examples, and how many matches each rule has in the repo. */
export function checkRecipeText(paths: GantryPaths, text: string): RecipeCheck {
  const loaded = parseRecipe(text);
  const out: RecipeCheck = { rules: [], errors: [...loaded.errors] };
  for (const id of loaded.skipped ?? []) {
    out.rules.push({ id, valid: false, examples: { passed: 0, failed: [] }, matches: 0 });
  }
  const recipe = loaded.recipe;
  if (!recipe) return out;

  const config = loadConfig(paths);
  const workspaces = detectAllWorkspaces(paths.root, config);
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const files = discoverFiles(paths, config, workspaces).filter((f) => /\.(?:ts|tsx|mts|cts)$/.test(f.path));

  const counts = new Map<string, number>(recipe.rules.map((r) => [r.id, 0]));
  const broken = new Map<string, string>();
  for (const f of files) {
    const ws = f.workspaceId ? wsById.get(f.workspaceId) : undefined;
    if (!ws) continue;
    const rules = rulesFor(recipe, ws, f.path);
    if (rules.length === 0) continue;
    let root: ReturnType<ReturnType<typeof parse>["root"]>;
    try {
      root = parse(astLang(f.path), readFileSync(join(paths.root, f.path), "utf8")).root();
    } catch {
      continue;
    }
    for (const rule of rules) {
      const r = findRule(rule, root);
      if (r.error) broken.set(rule.id, r.error);
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + r.nodes.length);
    }
  }

  for (const rule of recipe.rules) {
    const ex = runExamples(rule);
    const error = ex.error ?? broken.get(rule.id);
    if (error) out.errors.push(`recipe rule ${rule.id}: ast-grep rejects the rule: ${error}`);
    const matches = counts.get(rule.id) ?? 0;
    out.rules.push({
      id: rule.id,
      valid: error === undefined,
      examples: { passed: ex.passed, failed: ex.failed },
      matches,
      ...(matches === 0 ? { warning: "matches nothing in this repository" } : {}),
    });
  }
  out.rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Reads `file` (default `.gantry/recipe.json` under the repo root) and checks it. */
export function checkRecipeFile(paths: GantryPaths, file?: string): RecipeCheck {
  const abs = join(file ? process.cwd() : paths.root, file ?? RECIPE_PATH);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return { rules: [], errors: [`cannot read ${file ?? RECIPE_PATH}`] };
  }
  return checkRecipeText(paths, text);
}
