import { applyRecipe, type FileFacts, matchFile, rulesFor } from "../recipe/engine.js";
import type { Adapter } from "./framework.js";
import { hasDependency } from "./framework.js";

/**
 * The recipe adapter (spec section 9): routes, pages, endpoints and middleware from the repo's `.gantry/recipe.json`.
 * It holds no framework knowledge. `extract` runs the rules of the recipe on each file of a workspace the rules apply
 * to; `link` runs the helpers across files (mounts and base paths, file-system routes) and writes the nodes. With no
 * recipe it does nothing.
 */
export const recipeAdapter: Adapter<FileFacts> = {
  id: "recipe",
  appliesTo: (ws, run) =>
    run.recipe?.recipe?.rules.some((r) => !r.when?.dependency || hasDependency(ws, r.when.dependency)) ??
    false,
  mayMatch: (file) =>
    file.recipe?.recipe ? rulesFor(file.recipe.recipe, file.ws, file.path).length > 0 : false,
  extract(ctx) {
    const facts = matchFile(ctx, ctx.recipe);
    return facts ? { facts } : {};
  },
  link: (ctx) =>
    applyRecipe({
      root: ctx.root,
      repo: ctx.repo,
      workspaces: ctx.workspaces,
      recipe: ctx.recipe,
      files: ctx.files,
      parsed: ctx.parsed,
      resolver: ctx.resolver,
      fileOf: ctx.file,
    }),
};
