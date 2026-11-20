import type { SgNode } from "@ast-grep/napi";
import { type AdapterFileContext, symbolForName } from "../../adapters/framework.js";
import { isSymId, pathOfFileId, symKey, symKeyOfId } from "../../ids.js";

/**
 * Helper `resolve-names`: an identifier to its declaration. Three places are read: a router declared in the same
 * file, an import (followed through the resolver, so workspace packages and re-exports work), and the parameters of
 * the functions around the site. Built on the adapter context's resolver and the parse result, the same ones the
 * indexer uses, not on the tree-sitter tree.
 */

const FUNCTION_KINDS = new Set([
  "function_declaration",
  "function_expression",
  "function",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "generator_function",
]);

export const isFunctionNode = (n: SgNode): boolean => FUNCTION_KINDS.has(String(n.kind()));

const named = (n: SgNode): SgNode[] => n.children().filter((c) => c.isNamed());

/** Parameters of a function node, in order, as identifiers (destructured parameters are skipped). */
export function parametersOf(fn: SgNode): SgNode[] {
  const single = fn.field("parameter");
  if (single) return [single];
  const ps = fn.field("parameters");
  if (!ps) return [];
  const out: SgNode[] = [];
  for (const p of named(ps)) {
    const kind = String(p.kind());
    if (kind === "required_parameter" || kind === "optional_parameter") {
      const pat = p.field("pattern");
      if (pat && String(pat.kind()) === "identifier") out.push(pat);
    } else if (kind === "identifier") out.push(p);
  }
  return out;
}

/** Name of a function node: its declaration name, or the variable it is assigned to. */
export function functionName(fn: SgNode): string | undefined {
  const nm = fn.field("name");
  if (nm) return nm.text();
  const p = fn.parent();
  if (p && String(p.kind()) === "variable_declarator") return p.field("name")?.text();
  return undefined;
}

/** The functions around a node, innermost first. */
export function enclosingFunctions(node: SgNode): SgNode[] {
  const out: SgNode[] = [];
  for (let a = node.parent(); a; a = a.parent()) if (isFunctionNode(a)) out.push(a);
  return out;
}

export function parameterNames(node: SgNode): Set<string> {
  const out = new Set<string>();
  for (const fn of enclosingFunctions(node)) for (const p of parametersOf(fn)) out.add(p.text());
  return out;
}

/** Stable key of a function's i-th parameter: `<path>#<function>(<parameter>)`; an unnamed function uses `@<offset>`. */
export function parameterKey(path: string, fn: SgNode, p: SgNode): string {
  return symKey(path, `${functionName(fn) ?? `@${fn.range().start.index}`}(${p.text()})`);
}

/** The parameter named `name` of the nearest function around `node` that has one, with its function and position. */
export function enclosingParameter(
  node: SgNode,
  name: string,
): { fn: SgNode; param: SgNode; index: number } | null {
  for (const fn of enclosingFunctions(node)) {
    const ps = parametersOf(fn);
    const index = ps.findIndex((x) => x.text() === name);
    if (index >= 0) return { fn, param: ps[index] as SgNode, index };
  }
  return null;
}

/** Key of the top-level symbol an imported name stands for (`<path>#<name>`), or null when it is not an import. */
export function importedKey(ctx: AdapterFileContext, name: string): string | null {
  const imp = ctx.parsed?.imports.find((i) => i.local === name);
  if (!imp || imp.imported === "*") return null;
  const sym = symbolForName(ctx.parsed, ctx.fileId, name, ctx.resolver);
  if (sym && isSymId(sym)) return symKeyOfId(sym) ?? null;
  const t = ctx.resolver.resolveSpecifier(ctx.fileId, imp.specifier);
  return t.kind === "file" ? symKey(pathOfFileId(t.fileId), imp.imported) : null;
}

/** Key of a router named `name` as seen from a file: declared there, or imported. */
export function routerKeyOfName(
  ctx: AdapterFileContext,
  declared: ReadonlyMap<string, string>,
  name: string,
): string | null {
  return declared.get(name) ?? importedKey(ctx, name);
}
