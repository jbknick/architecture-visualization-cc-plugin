import picomatch from "picomatch";
import { isTextRule, type Recipe } from "./schema.js";

/**
 * Whether `path` is a text file that a `query` text rule of the recipe reads (spec section 5). Such a file has no
 * syntax tree, so an edit of it re-indexes the Go files whose edges come from it (`edge.textFileId`).
 */
export function isQueryFile(recipe: Recipe | null, path: string): boolean {
  if (!recipe) return false;
  const globs = recipe.rules.filter(isTextRule).flatMap((r) => (r.emit.kind === "query" ? r.files : []));
  return globs.length > 0 && picomatch.isMatch(path, globs, { dot: true });
}
