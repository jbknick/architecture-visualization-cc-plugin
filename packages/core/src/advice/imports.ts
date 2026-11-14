import { builtinModules } from "node:module";
import type { ParsedFile } from "../parse/index.js";
import type { Store } from "../store/index.js";
import type { WorkspaceRecord } from "../types.js";
import { workspaceForPath } from "../workspace/index.js";
import { cmp, declares, matchesExports, normPath, packageJsonPath, packageName } from "./util.js";

/**
 * `checkImports(store, filePath, parsed)` (spec section 18, situation 6; every finding is inline).
 * Pure and synchronous. Looks at each value import (type-only imports are ignored) whose specifier is
 * a bare package name and reports, once per (specifier, kind) at its first line:
 * - `undeclared`: the package is neither a Node builtin nor in the file's workspace `deps` (or the root's);
 * - `deep_import`: a workspace package subpath that its `exports` map does not expose (only checked when
 *   the package has an exports map).
 * Relative paths, `<scheme>:` specifiers, tsconfig aliases that the index resolved to a file, and names
 * that are not valid npm names (`@/x`, `~/x`, `#x`) are skipped. Sorted by line, then specifier.
 */
export interface ImportFinding {
  specifier: string;
  pkg: string;
  kind: "undeclared" | "deep_import";
  line: number;
  action: string;
}

const BUILTINS = new Set(builtinModules);
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

export function checkImports(store: Store, filePath: string, parsed: ParsedFile): ImportFinding[] {
  const rel = normPath(filePath);
  const all = store.listWorkspaces();
  if (all.length === 0) return [];
  const ws = workspaceForPath(all, rel);
  const byName = new Map(all.filter((w) => w.dir !== ".").map((w) => [w.name, w]));

  // Lines whose import the index resolved to a file: for a non-workspace name that is a tsconfig alias.
  const fileEdgeLines = new Set<number>();
  for (const e of store.effectiveEdges({ src: `file:${rel}`, kind: ["imports"] })) {
    if (!e.dst.startsWith("file:") || e.dst === e.src) continue;
    for (const ev of e.evidence) {
      const m = /:(\d+)$/.exec(ev);
      if (m?.[1]) fileEdgeLines.add(Number(m[1]));
    }
  }

  const found = new Map<string, ImportFinding>();
  const add = (f: ImportFinding): void => {
    const key = `${f.specifier}\0${f.kind}`;
    const prev = found.get(key);
    if (!prev || f.line < prev.line) found.set(key, f);
  };

  for (const imp of parsed.imports) {
    const spec = imp.specifier;
    if (imp.typeOnly || spec === "" || spec.startsWith(".") || spec.startsWith("/")) continue;
    if (SCHEME_RE.test(spec) || BUILTINS.has(spec)) continue;
    const pkg = packageName(spec);
    if (!pkg || BUILTINS.has(pkg) || pkg === ws.name) continue;

    const target = byName.get(pkg);
    if (target) {
      if (!declares(ws, all, pkg)) add(undeclared(spec, pkg, imp.line, ws));
      const sub = spec.slice(pkg.length);
      if (sub !== "" && target.exportsMap && !matchesExports(target, `.${sub}`)) {
        add({
          specifier: spec,
          pkg,
          kind: "deep_import",
          line: imp.line,
          action: `Import from an exported entry of ${pkg}`,
        });
      }
      continue;
    }
    if (fileEdgeLines.has(imp.line)) continue;
    if (!declares(ws, all, pkg)) add(undeclared(spec, pkg, imp.line, ws));
  }
  return [...found.values()].sort(
    (a, b) => a.line - b.line || cmp(a.specifier, b.specifier) || cmp(a.kind, b.kind),
  );
}

function undeclared(specifier: string, pkg: string, line: number, ws: WorkspaceRecord): ImportFinding {
  return { specifier, pkg, kind: "undeclared", line, action: `Declare "${pkg}" in ${packageJsonPath(ws)}` };
}
