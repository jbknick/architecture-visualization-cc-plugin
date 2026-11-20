import type { SgNode } from "@ast-grep/napi";
import { pathOfFileId } from "../../ids.js";
import { calleeFunction, findFunction, type ModelLike } from "./call-return.js";
import { parameterKey, parametersOf } from "./resolve-names.js";

/**
 * Helper `param-flow`: a router passed as an argument flows into the callee's parameter (`addUserRoutes(v1)`,
 * a Fastify plugin function). A parameter that a registration or a mount used as its router is a "scope"; every call
 * of that function in the read files links the argument's router to the parameter as a mount with no prefix.
 */

export interface ScopeParam {
  key: string;
  /** File and name of the function the parameter belongs to, and the parameter's position. */
  fileId: string;
  fnName: string;
  index: number;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The scope parameter a function declared as `name` in `fileId` opens: its first parameter by default. */
export function scopeParamOf(
  modelOf: (fileId: string) => ModelLike | undefined,
  fileId: string,
  name: string,
  index = 0,
): ScopeParam | null {
  const m = modelOf(fileId);
  if (!m) return null;
  const fn = findFunction(m.root, name);
  const p = fn ? parametersOf(fn)[index] : undefined;
  return fn && p ? { key: parameterKey(pathOfFileId(fileId), fn, p), fileId, fnName: name, index } : null;
}

export interface FlowLink {
  /** Key of the router passed in, and of the parameter that receives it. */
  from: string;
  to: string;
  line: number;
  file: ModelLike["file"];
}

/**
 * Calls of the scope functions, in path order. `resolve` turns an argument expression of a call's file into a router
 * key; arguments that are not routers are ignored.
 */
export function flowLinks(
  scopes: readonly ScopeParam[],
  models: readonly ModelLike[],
  resolve: (model: ModelLike, expr: SgNode) => string | null,
): FlowLink[] {
  const out: FlowLink[] = [];
  for (const sp of scopes) {
    for (const m of models) {
      if (!m.file.source.includes(`${sp.fnName}(`)) continue;
      const re = `^${escapeRe(sp.fnName)}$`;
      for (const call of m.root.findAll({
        rule: { kind: "call_expression", has: { field: "function", kind: "identifier", regex: re } },
      })) {
        const target = calleeFunction(m, call);
        if (!target || target.fileId !== sp.fileId || target.name !== sp.fnName) continue;
        const args = call.field("arguments");
        const arg = args?.children().filter((c) => c.isNamed() && String(c.kind()) !== "comment")[sp.index];
        if (!arg) continue;
        const from = resolve(m, arg);
        if (from && from !== sp.key) {
          out.push({ from, to: sp.key, line: call.range().start.line + 1, file: m.file });
        }
      }
    }
  }
  return out;
}
