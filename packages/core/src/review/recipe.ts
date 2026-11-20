import { type LoadedRecipe, loadRecipe } from "../recipe/load.js";
import type { ReviewDiff } from "./diff.js";

/**
 * The recipe of each side of a review, read from the side's own ref with `git show` (spec section 11): the base side
 * from the merge base, the head side from head. Nothing is read from the working tree and nothing is written, so a
 * recipe added by the change under review applies to its head side only.
 */
export function loadSideRecipes(
  root: string,
  diff: Pick<ReviewDiff, "mergeBase" | "head">,
): { base: LoadedRecipe; head: LoadedRecipe } {
  return {
    base: loadRecipe(root, { ref: diff.mergeBase }),
    head: loadRecipe(root, { ref: diff.head }),
  };
}
