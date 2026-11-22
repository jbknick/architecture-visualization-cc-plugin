import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTree, type SyntaxNode } from "../grammar.js";
import type { LanguagePack } from "../pack.js";

/**
 * The tree of the last file a lookup by place asked for, with what was derived from it. A lookup in another file
 * replaces the entry, so one tree is alive at a time (as the token streams do) and the many lookups of one file, such as
 * one per route in a router file, parse it once.
 */
export class LastTree<T> {
  private key: string | undefined;
  private value: T | undefined;

  constructor(
    private readonly pack: LanguagePack,
    private readonly repoRoot: string,
  ) {}

  /** The entry of the file; `build` runs on the tree when the file is not the last one asked for. */
  get(rel: string, build: (root: SyntaxNode) => T): T | null {
    if (this.key === rel && this.value !== undefined) return this.value;
    this.key = undefined;
    this.value = undefined;
    const value = withTree(this.pack, this.repoRoot, rel, build);
    if (value === null) return null;
    this.key = rel;
    this.value = value;
    return value;
  }
}

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
