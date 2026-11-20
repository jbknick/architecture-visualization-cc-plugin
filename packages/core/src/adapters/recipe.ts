import { applyDataAccess, sqlApplies } from "../recipe/data-access.js";
import { applyRecipe, type FileFacts, matchFile, rulesFor, whenApplies } from "../recipe/engine.js";
import { isTextRule } from "../recipe/schema.js";
import type { Adapter } from "./framework.js";

/**
 * The recipe adapter (spec section 9): routes, pages, endpoints, middleware, tables and the reads and writes of
 * tables from the repo's `.gantry/recipe.json`. It holds no framework or ORM knowledge. `extract` runs the rules of
 * the recipe on each file of a workspace the rules apply to; `link` runs the helpers across files (mounts and base
 * paths, file-system routes, table bindings, models, SQL text) and writes the nodes and edges. With no recipe it
 * does nothing.
 */
export const recipeAdapter: Adapter<FileFacts> = {
  id: "recipe",
  appliesTo: (ws, run) => {
    const recipe = run.recipe?.recipe;
    if (!recipe) return false;
    // A text rule or SQL text reads files outside the syntax-tree index and needs a TypeScript file of the
    // workspace to hold its nodes, so every workspace takes part.
    if (recipe.helpers.includes("sql-text") || recipe.rules.some(isTextRule)) return true;
    return recipe.rules.some((r) => !isTextRule(r) && whenApplies(r.when, ws, run.workspaces));
  },
  mayMatch: (file) => {
    const recipe = file.recipe?.recipe;
    if (!recipe) return false;
    return (
      rulesFor(recipe, file.ws, file.path, file.workspaces).length > 0 ||
      recipe.rules.some(isTextRule) ||
      (recipe.helpers.includes("sql-text") && (recipe.sql?.sqlFiles?.length ?? 0) > 0) ||
      sqlApplies(recipe, file.path, file.source)
    );
  },
  extract(ctx) {
    const facts = matchFile(ctx, ctx.recipe);
    return facts ? { facts } : {};
  },
  link(ctx) {
    const routes = applyRecipe({
      root: ctx.root,
      repo: ctx.repo,
      workspaces: ctx.workspaces,
      recipe: ctx.recipe,
      files: ctx.files,
      parsed: ctx.parsed,
      resolver: ctx.resolver,
      fileOf: ctx.file,
    });
    const data = applyDataAccess({
      repo: ctx.repo,
      root: ctx.root,
      workspaces: ctx.workspaces,
      recipe: ctx.recipe?.recipe ?? null,
      files: ctx.files,
      resolver: ctx.resolver,
      fileOf: ctx.file,
    });
    return { nodes: [...routes.nodes, ...data.nodes], edges: [...routes.edges, ...data.edges] };
  },
};
