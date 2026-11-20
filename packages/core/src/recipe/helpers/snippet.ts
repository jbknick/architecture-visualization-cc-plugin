import { parseSync } from "oxc-parser";
import { chainName, isNode, type Node, nodeArray, unwrap } from "../../parse/ast.js";

/**
 * Captured text is read with the oxc parser, the same one the adapters read files with, so a path, a method list or
 * a handler is judged by the same rules everywhere. Offsets inside a snippet mean nothing; callers use the offsets
 * ast-grep reports for the capture in the file.
 */
export function parseExpr(text: string): Node | null {
  try {
    const r = parseSync("snippet.ts", `(${text})`, {
      sourceType: "module",
      lang: "ts",
      preserveParens: false,
    });
    const st = nodeArray((r.program as unknown as { body?: unknown }).body)[0];
    if (st?.type !== "ExpressionStatement") return null;
    const e = unwrap(st.expression);
    return isNode(e) ? e : null;
  } catch {
    return null;
  }
}

export const isFnNode = (n: unknown): boolean => {
  const v = unwrap(n);
  return isNode(v) && (v.type === "ArrowFunctionExpression" || v.type === "FunctionExpression");
};

/** What a handler is called in node data: `inline` for a function, the callee for a call, else the written name. */
export function handlerLabel(n: unknown): string {
  const v = unwrap(n);
  if (isFnNode(v)) return "inline";
  if (isNode(v) && v.type === "CallExpression") return chainName(v.callee) ?? "expression";
  return chainName(v) ?? "expression";
}
