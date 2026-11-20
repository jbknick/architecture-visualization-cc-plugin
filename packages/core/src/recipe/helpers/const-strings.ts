import {
  type AdapterFileContext,
  type AdapterResolver,
  stringConstants,
  stringValue,
  symbolForName,
} from "../../adapters/framework.js";
import { fileIdOfSymId, nameOfSymId } from "../../ids.js";
import { chainName, isNode, nodeArray, unwrap } from "../../parse/ast.js";

/**
 * Helper `const-strings`: a path argument that is an identifier reads the `const` string it names, also when the
 * constant is imported from another file. A path is a list of pieces; a piece is text, or a constant to read once
 * every file is known (`sym` names where an import points). A piece nobody can read is written `{name}` (spec
 * section 9) and the site gets a `reason`.
 */

export type PathPart = string | { name: string; sym?: string; param?: boolean };
export type PathExpr = PathPart[];

export interface PathContext {
  ctx: AdapterFileContext;
  /** Top-level `const NAME = "text"` of the file. */
  consts: Map<string, string>;
  /** Names of the parameters of the functions around the site. */
  params: ReadonlySet<string>;
}

export const pathContext = (
  ctx: AdapterFileContext,
  params: ReadonlySet<string> = new Set(),
): PathContext => ({
  ctx,
  consts: stringConstants(ctx.program()),
  params,
});

/** Reference to a string constant named `name`, or null when the name is not one. */
function constRef(pc: PathContext, name: string): PathPart | null {
  const local = pc.consts.get(name);
  if (local !== undefined) return local;
  const imp = pc.ctx.parsed?.imports.find((i) => i.local === name);
  if (!imp) return null;
  const sym = symbolForName(pc.ctx.parsed, pc.ctx.fileId, name, pc.ctx.resolver);
  const s = pc.ctx.parsed?.symbols.find((x) => x.id === sym);
  if (s && s.kind !== "const") return null;
  return sym ? { name, sym } : { name };
}

/** The path an expression stands for; null when it is not a path (a handler, a number). `more`: other arguments follow. */
export function pathOf(pc: PathContext, arg: unknown, more: boolean): PathExpr | null {
  const v = unwrap(arg);
  const lit = stringValue(v);
  if (lit !== null) return [lit];
  if (!isNode(v)) return null;
  if (v.type === "TemplateLiteral") {
    const out: PathExpr = [];
    const qs = nodeArray(v.quasis);
    const es = nodeArray(v.expressions);
    qs.forEach((q, i) => {
      const cooked = (q.value as { cooked?: unknown } | undefined)?.cooked;
      if (typeof cooked === "string" && cooked) out.push(cooked);
      const e = unwrap(es[i]);
      if (!isNode(e)) return;
      const ref = e.type === "Identifier" ? constRef(pc, e.name as string) : null;
      out.push(ref ?? { name: chainName(e) ?? "expr", ...paramFlag(pc, e) });
    });
    return out;
  }
  if (v.type === "Identifier") {
    const name = v.name as string;
    const ref = constRef(pc, name);
    if (ref !== null) return [ref];
    // An unknown identifier before more arguments is a path we cannot read (kept as a placeholder).
    const sym = symbolForName(pc.ctx.parsed, pc.ctx.fileId, name, pc.ctx.resolver);
    if (more && !sym) return [{ name, ...paramFlag(pc, v) }];
  }
  return null;
}

const paramFlag = (pc: PathContext, e: unknown): { param?: true } =>
  isNode(e) && e.type === "Identifier" && pc.params.has(e.name as string) ? { param: true } : {};

/** The paths an argument stands for: each element of an array, or the one path. */
export function pathsOf(pc: PathContext, arg: unknown): PathExpr[] {
  const v = unwrap(arg);
  if (isNode(v) && v.type === "ArrayExpression") {
    return nodeArray(v.elements)
      .map((e) => pathOf(pc, e, true))
      .filter((p): p is PathExpr => p !== null);
  }
  const p = pathOf(pc, v, true);
  return p ? [p] : [];
}

export interface ReadPath {
  text: string;
  /** Why a piece could not be read; absent when every piece was. */
  reason?: string;
}

/** Reads pieces to text once every file is known; `fileOf` gives any read file so an imported constant can be found. */
export function makeReader(fileOf: (fileId: string) => AdapterFileContext | undefined) {
  const cache = new Map<string, Map<string, string>>();
  return (pieces: readonly PathExpr[]): { values: string[]; reason?: string } => {
    let reason: string | undefined;
    const values = pieces.map((e) =>
      e
        .map((p) => {
          if (typeof p === "string") return p;
          if (p.sym) {
            const fileId = fileIdOfSymId(p.sym) ?? p.sym;
            let consts = cache.get(fileId);
            if (!consts) {
              consts = stringConstants(fileOf(fileId)?.program() ?? null);
              cache.set(fileId, consts);
            }
            const v = consts.get(nameOfSymId(p.sym) ?? "");
            if (v !== undefined) return v;
          }
          reason ??= p.param ? "path is a function parameter" : "path is not a literal or const string";
          return `{${p.name}}`;
        })
        .join(""),
    );
    return reason ? { values, reason } : { values };
  };
}

export type { AdapterResolver };
