import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@ast-grep/napi";
import { loadConfig } from "../config/index.js";
import { discoverFiles } from "../discover/index.js";
import { detectAllWorkspaces } from "../lang/index.js";
import type { GantryPaths } from "../paths/index.js";
import { listTextFiles } from "./data-access.js";
import { astLang, findRule, rulesFor, runExamples } from "./engine.js";
import { RegexRunner } from "./helpers/bounded-regex.js";
import { matchText, runFailure, runTextExamples } from "./helpers/text-rules.js";
import { parseRecipe, RECIPE_PATH } from "./load.js";
import { isTextRule } from "./schema.js";

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
  const workspaces = detectAllWorkspaces(paths.root, config, paths.repo);
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const files = discoverFiles(paths, config, workspaces).filter((f) => /\.(?:ts|tsx|mts|cts)$/.test(f.path));

  const counts = new Map<string, number>(recipe.rules.map((r) => [r.id, 0]));
  const broken = new Map<string, string>();
  for (const f of files) {
    const ws = f.workspaceId ? wsById.get(f.workspaceId) : undefined;
    if (!ws) continue;
    const rules = rulesFor(recipe, ws, f.path, workspaces);
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
    const text = isTextRule(rule);
    // A recipe's own regular expressions run in a worker under a time budget, here as in the index.
    const runner = new RegexRunner();
    let error: string | undefined;
    let ex: { passed: number; failed: string[] };
    try {
      if (text) {
        const r = runTextExamples(runner, rule);
        ex = r;
        error = r.error ? `${r.error}` : undefined;
        if (!error) {
          let n = 0;
          for (const f of listTextFiles(paths.root, rule.files)) {
            const m = matchText(runner, rule, f.text);
            if (!m.ok) {
              error = runFailure(m, runner);
              break;
            }
            n += m.matches.length;
          }
          counts.set(rule.id, n);
        }
        if (error) out.errors.push(`recipe rule ${rule.id} skipped: ${error}`);
      } else {
        const r = runExamples(rule);
        ex = r;
        error = r.error ?? broken.get(rule.id);
        if (error) out.errors.push(`recipe rule ${rule.id}: ast-grep rejects the rule: ${error}`);
        const decls = "receiverDecl" in rule.emit ? (rule.emit.receiverDecl ?? []) : [];
        for (const tpl of decls) {
          for (const snippet of rule.examples.match) {
            const m = runner.run(tpl.replaceAll("{prop}", "x"), "s", snippet, true);
            if (!m.ok) {
              error ??=
                m.reason === "invalid"
                  ? `invalid regex: ${m.error ?? ""}`
                  : `regex exceeded ${runner.jobBudgetMs} ms`;
              out.errors.push(`recipe rule ${rule.id} skipped: ${error}`);
            }
            if (!m.ok) break;
          }
          if (error) break;
        }
      }
    } finally {
      runner.close();
    }
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
