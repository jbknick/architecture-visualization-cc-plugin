import { posix } from "node:path";
import { pathOfFileId } from "../ids.js";
import type { Store } from "../store/index.js";
import type { SymbolRecord, WorkspaceRecord } from "../types.js";
import type { Advice } from "./reuse.js";

/**
 * Reuse advice for a Go match (spec section 18). The unit of import is the package, which is a directory of a module:
 * its import path is `<module path>/<dir inside the module>`. A symbol is reachable when its name is exported
 * (upper-case first letter; a method also needs an exported receiver type) and no `internal/` rule hides its package
 * from the caller. Like the TypeScript half, it reads the index only.
 */

const isUpper = (name: string): boolean => {
  const c = name.charAt(0);
  return c !== c.toLowerCase() && c === c.toUpperCase();
};

/** A Go symbol another package can name: exported, and for a method also on an exported type. */
function reachable(match: SymbolRecord): boolean {
  if (!match.exported) return false;
  return match.kind !== "method" || isUpper(match.name);
}

/** Import path of the package that holds `repoRel`: module path plus the directory inside the module. */
export function goImportPath(ws: WorkspaceRecord, repoRel: string): string {
  const dir = posix.dirname(repoRel);
  const inside = ws.dir === "." ? dir : posix.relative(ws.dir, dir);
  return inside === "." || inside === "" ? ws.name : `${ws.name}/${inside}`;
}

/** Go's `internal` rule: the package may be imported only from the tree rooted at the parent of its `internal` element. */
function visibleFrom(importPath: string, callerPackage: string): boolean {
  const parts = importPath.split("/");
  const at = parts.lastIndexOf("internal");
  if (at < 0) return true;
  const parent = parts.slice(0, at).join("/");
  return callerPackage === parent || callerPackage.startsWith(`${parent}/`);
}

/** Every workspace id reachable from `from` through `depends_on` edges. */
function dependsOnClosure(store: Store, from: string): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of store.effectiveEdges({ kind: ["depends_on"] })) {
    const a = next.get(e.src) ?? [];
    a.push(e.dst);
    next.set(e.src, a);
  }
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const n of next.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen;
}

const goModPath = (ws: WorkspaceRecord): string => (ws.dir === "." ? "go.mod" : `${ws.dir}/go.mod`);

/**
 * The Go module that holds `path`: the workspace with the longest directory prefix. A TypeScript package and a Go
 * module can both sit at the repository root (the store does not keep a workspace's language), so a tie goes to the
 * one that has Go files.
 */
function goModuleOf(store: Store, all: WorkspaceRecord[], path: string): WorkspaceRecord | undefined {
  const inside = all.filter((w) => w.dir === "." || path.startsWith(`${w.dir}/`));
  const longest = Math.max(...inside.map((w) => (w.dir === "." ? 0 : w.dir.length)), 0);
  const best = inside.filter((w) => (w.dir === "." ? 0 : w.dir.length) === longest);
  if (best.length <= 1) return best[0];
  const withGo = new Set(
    store
      .effectiveFiles()
      .filter((f) => f.lang === "go")
      .map((f) => f.workspaceId),
  );
  return best.find((w) => withGo.has(w.id)) ?? best[0];
}

/**
 * The primary advice for a Go match in another file than the caller's; nothing when the caller is not a `.go` file
 * (a draft with an unknown path) or no Go module holds one of the two.
 */
export function adviseGo(
  store: Store,
  all: WorkspaceRecord[],
  caller: string,
  match: SymbolRecord,
): Advice[] {
  if (!caller.endsWith(".go")) return [];
  const matchRel = pathOfFileId(match.fileId);
  const callerWs = goModuleOf(store, all, caller);
  const matchWs = goModuleOf(store, all, matchRel);
  if (!callerWs || !matchWs) return [];
  const matchPkg = goImportPath(matchWs, matchRel);
  const callerPkg = goImportPath(callerWs, caller);
  if (matchPkg === callerPkg) {
    return [
      {
        situation: 1,
        action: `Call it: ${match.name} is in the same package (${posix.dirname(matchRel)})`,
        inline: true,
      },
    ];
  }
  if (!reachable(match) || !visibleFrom(matchPkg, callerPkg)) {
    return [{ situation: 3, action: "Export it or move it to a shared package", inline: false }];
  }
  if (callerWs.id === matchWs.id || callerWs.deps.includes(matchWs.name)) {
    return [{ situation: 1, action: `Import it: import "${matchPkg}"`, inline: true, importPath: matchPkg }];
  }
  if (dependsOnClosure(store, matchWs.id).has(callerWs.id)) {
    return [
      {
        situation: 4,
        action: `Move it to a shared package (adding ${matchWs.name} would make a dependency cycle)`,
        inline: false,
      },
    ];
  }
  return [
    {
      situation: 2,
      action: `Add the dependency: require ${matchWs.name} in ${goModPath(callerWs)}, then import it`,
      inline: false,
      importPath: matchPkg,
    },
  ];
}
