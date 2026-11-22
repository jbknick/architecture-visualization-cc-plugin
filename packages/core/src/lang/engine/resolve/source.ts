import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTree, type SyntaxNode } from "../grammar.js";
import type { LanguagePack } from "../pack.js";

/**
 * Reads and parses a file of the repo, and hands the tree to `use`. The tree lives for the call only: nothing in the
 * resolvers keeps a node, so a tree is freed once its file's facts are extracted. Null when the file cannot be read
 * or parsed.
 */
export function withTree<T>(
  pack: LanguagePack,
  repoRoot: string,
  rel: string,
  use: (root: SyntaxNode) => T,
): T | null {
  let root: SyntaxNode;
  try {
    root = parseTree(pack, readFileSync(join(repoRoot, rel), "utf8"));
  } catch {
    return null;
  }
  return use(root);
}
