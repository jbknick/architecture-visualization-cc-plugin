import type { SgNode } from "@ast-grep/napi";
import { type AdapterFileContext, symbolForName } from "../../adapters/framework.js";
import { fileIdOfSymId, nameOfSymId } from "../../ids.js";
import { enclosingFunctions } from "./resolve-names.js";

/**
 * Helper `call-return`: a mounted `articleRouter()` or `createApp()` is the router that function returns. The callee
 * is an identifier resolved to a function of this file or of an imported file; the router is whatever its first
 * `return` (or its expression body) names.
 */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface ModelLike {
  file: AdapterFileContext;
  root: SgNode;
}

/** The function node declared as `name` in a file: `function name() {}` or `const name = () => {}`. */
export function findFunction(root: SgNode, name: string): SgNode | null {
  const re = `^${escapeRe(name)}$`;
  const decl = root.find({
    rule: {
      any: [
        { kind: "function_declaration", has: { field: "name", regex: re } },
        { kind: "variable_declarator", has: { field: "name", regex: re } },
      ],
    },
  });
  if (!decl) return null;
  if (String(decl.kind()) === "function_declaration") return decl;
  const v = decl.field("value");
  return v && /function|arrow/.test(String(v.kind())) ? v : null;
}

/** The function an identifier called in `model` stands for: `{ fileId, name }`, or null. */
export function calleeFunction(model: ModelLike, call: SgNode): { fileId: string; name: string } | null {
  const fn = call.field("function");
  if (!fn || String(fn.kind()) !== "identifier") return null;
  const sym = symbolForName(model.file.parsed, model.file.fileId, fn.text(), model.file.resolver);
  if (!sym) return null;
  const fileId = fileIdOfSymId(sym);
  const name = nameOfSymId(sym);
  return fileId && name ? { fileId, name } : null;
}

/** The expressions a function returns (an arrow's expression body, or each `return` of its own body). */
export function returnedExpressions(fn: SgNode): SgNode[] {
  const body = fn.field("body");
  if (!body) return [];
  if (String(body.kind()) !== "statement_block") return [body];
  const out: SgNode[] = [];
  for (const r of fn.findAll({ rule: { kind: "return_statement" } })) {
    const owner = enclosingFunctions(r)[0];
    if (!owner || owner.range().start.index !== fn.range().start.index) continue;
    const e = r.children().find((c) => c.isNamed() && String(c.kind()) !== "comment");
    if (e) out.push(e);
  }
  return out;
}

/**
 * The key of the router a call returns. `resolve` turns an expression of the callee's file into a router key (the
 * same resolution the engine uses everywhere); the first returned expression that is a router wins.
 */
export function callReturnKey(
  model: ModelLike,
  call: SgNode,
  modelOf: (fileId: string) => ModelLike | undefined,
  resolve: (model: ModelLike, expr: SgNode) => string | null,
): string | null {
  const target = calleeFunction(model, call);
  if (!target) return null;
  const tm = modelOf(target.fileId);
  if (!tm) return null;
  const fn = findFunction(tm.root, target.name);
  if (!fn) return null;
  for (const e of returnedExpressions(fn)) {
    const key = resolve(tm, e);
    if (key) return key;
  }
  return null;
}
