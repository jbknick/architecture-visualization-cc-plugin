import picomatch from "picomatch";
import type { Selector } from "./types.js";

/** What a selector is matched against. `path` and `workspace` come from the store, never from parsing an id. */
export interface SelectableNode {
  id: string;
  kind: string;
  /** Repo-relative posix path (a symbol's path is its file's path). */
  path?: string;
  /** Workspace id (`ws:...`); a workspace node carries its own id. */
  workspace?: string;
}

const matchers = new Map<string, (p: string) => boolean>();
function globMatcher(glob: string): (p: string) => boolean {
  let m = matchers.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    matchers.set(glob, m);
  }
  return m;
}

/** Whether `sel` selects `node`. A directory also matches when the glob with a trailing `/**` removed matches it. */
export function matchSelector(sel: Selector, node: SelectableNode): boolean {
  switch (sel.type) {
    case "glob": {
      if (node.path === undefined) return false;
      if (globMatcher(sel.glob)(node.path)) return true;
      if (node.kind === "dir" && sel.glob.endsWith("/**")) {
        return globMatcher(sel.glob.slice(0, -3))(node.path);
      }
      return false;
    }
    case "kind":
      return node.kind === sel.kind;
    case "workspace":
      return node.workspace === sel.workspace || (node.kind === "workspace" && node.id === sel.workspace);
    case "ids":
      return sel.ids.includes(node.id);
  }
}

export function matchAny(selectors: readonly Selector[], node: SelectableNode): boolean {
  return selectors.some((s) => matchSelector(s, node));
}
