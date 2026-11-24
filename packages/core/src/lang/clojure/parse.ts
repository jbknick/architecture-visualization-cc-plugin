import { fileId as makeFileId, symId } from "../../ids.js";
import type { ParsedFile } from "../../parse/index.js";
import type { ParsedSymbol } from "../../types.js";
import { type Definition, type FileFacts, factsOf, headOf, Lines } from "./facts.js";
import type { Form } from "./reader.js";

/** Heads that add a branch to the complexity of a body. */
const BRANCHES = new Set([
  "if",
  "if-not",
  "when",
  "when-not",
  "if-let",
  "when-let",
  "if-some",
  "when-some",
  "when-first",
  "and",
  "or",
]);
/** Heads whose clauses, after the expression they test, come in pairs, each a branch. */
const CLAUSES: Record<string, number> = { cond: 1, "cond->": 2, "cond->>": 2, case: 2, condp: 3 };

/** Statements (every list in the body that is a call, not an arity) and complexity (1 plus each branch) of a form. */
export function measure(form: Form): { stmtCount: number; complexity: number } {
  let stmtCount = 0;
  let complexity = 1;
  const walk = (f: Form, top: boolean): void => {
    if (f.t === "quote") return;
    if (f.t === "list") {
      const h = headOf(f);
      if (!top && !(f.items[0]?.t === "vec")) stmtCount++;
      if (h) {
        if (BRANCHES.has(h.name)) complexity++;
        const skip = CLAUSES[h.name];
        if (skip !== undefined) complexity += Math.floor(Math.max(0, f.items.length - skip) / 2);
      }
    }
    if ("items" in f) for (const x of f.items) walk(x, false);
  };
  walk(form, true);
  return { stmtCount, complexity };
}

/** The symbol ids of a file's definitions, in their order: `sym:<repo>:<path>#<name>`, with `~2`, `~3` for a name repeated. */
export function definitionIds(repo: string, repoRelPath: string, defs: readonly Definition[]): string[] {
  const seen = new Map<string, number>();
  return defs.map((d) => {
    const base = symId(repo, repoRelPath, d.name);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/** The parsed file of facts already read (the resolver reads a file once for both). */
export function parsedOf(repo: string, repoRelPath: string, source: string, facts: FileFacts): ParsedFile {
  const fileId = makeFileId(repo, repoRelPath);
  const lines = new Lines(source);
  const ids = definitionIds(repo, repoRelPath, facts.definitions);
  const result: ParsedFile = {
    fileId,
    symbols: [],
    imports: facts.requires.imports.map((i) => ({ ...i, typeOnly: false })),
    exports: [],
    sites: [],
    bodies: new Map(),
    errors: [...facts.errors],
  };
  facts.definitions.forEach((d, k) => {
    const id = ids[k] as string;
    const startLine = lines.lineOf(d.s);
    const endLine = Math.max(startLine, lines.lineOf(Math.max(d.s, d.e - 1)));
    // A constructor function or a declared name has no body of its own; a protocol method is a signature.
    const m =
      d.role === "ctor" || d.role === "declare" || d.role === "method"
        ? { stmtCount: 0, complexity: 1 }
        : measure(d.form);
    const sym: ParsedSymbol = {
      id,
      fileId,
      name: d.name,
      kind: d.kind,
      exported: d.exported,
      signature: d.signature,
      startLine,
      endLine,
      loc: endLine - startLine + 1,
      complexity: m.complexity,
      stmtCount: m.stmtCount,
    };
    result.symbols.push(sym);
    result.bodies.set(id, { start: d.s, end: d.e });
  });
  return result;
}

/**
 * Parses one Clojure, ClojureScript or `.cljc` file: its definitions as symbols and its requires as imports. Ids follow
 * spec section 6. Calls are not extracted here (no `sites`); the resolver reads them.
 */
export function parseClojure(repo: string, repoRelPath: string, source: string): ParsedFile {
  try {
    return parsedOf(repo, repoRelPath, source, factsOf(source));
  } catch (err) {
    return {
      fileId: makeFileId(repo, repoRelPath),
      symbols: [],
      imports: [],
      exports: [],
      sites: [],
      bodies: new Map(),
      errors: [`parser failure: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
