import { applyDataAccess, sqlApplies } from "../recipe/data-access.js";
import { applyRecipe, type FileFacts, matchFile, rulesFor, whenApplies } from "../recipe/engine.js";
import { type GoFacts, goRulesFor, isGoFacts, isGoPath, matchGoFile } from "../recipe/go.js";
import { applyGoRoutes } from "../recipe/go-routes.js";
import { isTextRule } from "../recipe/schema.js";
import type { Adapter } from "./framework.js";

/**
 * The recipe adapter (spec section 9): routes, pages, endpoints, middleware, tables and the reads and writes of
 * tables from the repo's `.gantry/recipe.json`. It holds no framework or ORM knowledge. `extract` runs the rules of
 * the recipe on each file of a workspace the rules apply to; `link` runs the helpers across files (mounts and base
 * paths, file-system routes, table bindings, models, SQL text) and writes the nodes and edges. With no recipe it
 * does nothing. It reads TypeScript and Go files; a rule's `language` says which.
 */
export const recipeAdapter: Adapter<FileFacts | GoFacts> = {
  id: "recipe",
  languages: ["typescript", "go"],
  appliesTo: (ws, run) => {
    const recipe = run.recipe?.recipe;
    if (!recipe) return false;
    // A text rule or SQL text reads files outside the syntax-tree index and needs a file of the workspace to hold
    // its nodes, so every workspace takes part.
    if (recipe.helpers.includes("sql-text") || recipe.rules.some(isTextRule)) return true;
    return recipe.rules.some((r) => !isTextRule(r) && whenApplies(r.when, ws, run.workspaces));
  },
  mayMatch: (file) => {
    const recipe = file.recipe?.recipe;
    if (!recipe) return false;
    return (
      (isGoPath(file.path)
        ? goRulesFor(recipe, file.ws, file.path, file.workspaces).length > 0
        : rulesFor(recipe, file.ws, file.path, file.workspaces).length > 0) ||
      recipe.rules.some(isTextRule) ||
      (recipe.helpers.includes("sql-text") && (recipe.sql?.sqlFiles?.length ?? 0) > 0) ||
      sqlApplies(recipe, file.path, file.source)
    );
  },
  extract(ctx) {
    const facts = isGoPath(ctx.path) ? matchGoFile(ctx, ctx.recipe) : matchFile(ctx, ctx.recipe);
    return facts ? { facts } : {};
  },
  link(ctx) {
    const ts: { file: (typeof ctx.files)[number]["file"]; facts: FileFacts | undefined }[] = [];
    const go: { file: (typeof ctx.files)[number]["file"]; facts: GoFacts | undefined }[] = [];
    for (const f of ctx.files) {
      if (isGoPath(f.file.path)) go.push({ file: f.file, facts: isGoFacts(f.facts) ? f.facts : undefined });
      else ts.push({ file: f.file, facts: isGoFacts(f.facts) ? undefined : f.facts });
    }
    const routes = applyRecipe({
      root: ctx.root,
      repo: ctx.repo,
      workspaces: ctx.workspaces,
      recipe: ctx.recipe,
      files: ts,
      parsed: ctx.parsed,
      resolver: ctx.resolver,
      fileOf: ctx.file,
    });
    const goRoutes = applyGoRoutes({
      repo: ctx.repo,
      recipe: ctx.recipe?.recipe ?? null,
      files: go,
      resolver: ctx.resolver,
      fileOf: ctx.file,
    });
    const data = applyDataAccess({
      repo: ctx.repo,
      root: ctx.root,
      workspaces: ctx.workspaces,
      recipe: ctx.recipe?.recipe ?? null,
      files: ts,
      goFiles: go,
      resolver: ctx.resolver,
      fileOf: ctx.file,
    });
    return {
      nodes: [...routes.nodes, ...goRoutes.nodes, ...data.nodes],
      edges: [...routes.edges, ...goRoutes.edges, ...data.edges],
    };
  },
};
