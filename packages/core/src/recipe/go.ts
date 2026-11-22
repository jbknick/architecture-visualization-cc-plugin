import { parse, type SgNode } from "@ast-grep/napi";
import picomatch from "picomatch";
import type { AdapterFileContext } from "../adapters/framework.js";
import { goAvailable } from "../lang/go/index.js";
import type { WorkspaceRecord } from "../types.js";
import { type ExampleResult, findRule, whenApplies } from "./engine.js";
import type { LoadedRecipe } from "./load.js";
import { type GoRecipeRule, isGoRule, type Recipe } from "./schema.js";

/**
 * Go rules (spec section 5): ast-grep rules run on the tree-sitter Go grammar the indexer parses `.go` files with
 * (`lang/go/`, no Go toolchain). This file holds what the Go passes share: matching a file, the examples of a rule,
 * and reading Go syntax (string values, constants, type names). No router, ORM or driver name appears here.
 */

export interface GoRuleMatch {
  rule: GoRecipeRule;
  node: SgNode;
}

/** What `extract` keeps for a Go file: its tree and the matches of the Go rules that apply to it. */
export interface GoFacts {
  lang: "go";
  file: AdapterFileContext;
  root: SgNode;
  matches: GoRuleMatch[];
}

export const isGoFacts = (f: unknown): f is GoFacts =>
  typeof f === "object" && f !== null && (f as { lang?: unknown }).lang === "go";

export const isGoPath = (path: string): boolean => path.endsWith(".go");

const roots = new WeakMap<AdapterFileContext, SgNode | null>();

/** The ast-grep root of a Go file (parsed once per file context); null when the grammar is missing or it does not parse. */
export function goRootOf(file: AdapterFileContext): SgNode | null {
  if (!roots.has(file)) {
    try {
      roots.set(file, goAvailable() ? parse("go" as never, file.source).root() : null);
    } catch {
      roots.set(file, null);
    }
  }
  return roots.get(file) ?? null;
}

/** The Go rules that apply to a file: its workspace passes the rule's `when` and `files` match. */
export function goRulesFor(
  recipe: Recipe,
  ws: WorkspaceRecord,
  path: string,
  workspaces: readonly WorkspaceRecord[] = [ws],
): GoRecipeRule[] {
  if (!isGoPath(path)) return [];
  return recipe.rules.filter(isGoRule).filter((r) => {
    if (!whenApplies(r.when, ws, workspaces)) return false;
    return !r.files || picomatch.isMatch(path, r.files, { dot: true });
  });
}

export function matchGoFile(file: AdapterFileContext, recipe: LoadedRecipe | null): GoFacts | undefined {
  if (!recipe?.recipe) return undefined;
  const rules = goRulesFor(recipe.recipe, file.ws, file.path, file.workspaces);
  if (rules.length === 0) return undefined;
  const root = goRootOf(file);
  if (!root) return undefined;
  const matches: GoRuleMatch[] = [];
  for (const rule of rules) for (const node of findRule(rule, root).nodes) matches.push({ rule, node });
  return matches.length > 0 ? { lang: "go", file, root, matches } : undefined;
}

/**
 * A snippet of a Go example as a file: a snippet that starts with a declaration keyword is a file body, anything else
 * is a list of statements and goes inside a function.
 */
export function wrapGoSnippet(snippet: string): string {
  if (/^\s*package\s/.test(snippet)) return snippet;
  if (/^\s*(?:func|type|var|const|import)\b/.test(snippet)) return `package p\n${snippet}`;
  return `package p\nfunc _() {\n${snippet}\n}\n`;
}

/** Checks a Go rule's examples: each `match` snippet gives at least one match, each `noMatch` snippet none. */
export function runGoExamples(rule: GoRecipeRule): ExampleResult {
  const res: ExampleResult = { passed: 0, failed: [] };
  const count = (snippet: string): number => {
    if (!goAvailable()) {
      res.error ??= "the Go grammar is not available on this platform";
      return 0;
    }
    try {
      const r = findRule(rule, parse("go" as never, wrapGoSnippet(snippet)).root());
      if (r.error) res.error ??= r.error;
      return r.nodes.length;
    } catch {
      return 0;
    }
  };
  for (const s of rule.examples.match) {
    if (count(s) > 0) res.passed++;
    else res.failed.push(`match: no match in ${JSON.stringify(s)}`);
  }
  for (const s of rule.examples.noMatch) {
    if (count(s) === 0) res.passed++;
    else res.failed.push(`noMatch: matched ${JSON.stringify(s)}`);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------
// Syntax

export const kindOf = (n: SgNode): string => String(n.kind());
export const rangeKey = (n: SgNode): string => {
  const r = n.range();
  return `${r.start.index}:${r.end.index}`;
};
export const named = (n: SgNode): SgNode[] =>
  n.children().filter((c) => c.isNamed() && kindOf(c) !== "comment");

export function unparen(n: SgNode): SgNode {
  let x = n;
  while (kindOf(x) === "parenthesized_expression") {
    const k = named(x)[0];
    if (!k) break;
    x = k;
  }
  return x;
}

const STRING_KINDS = new Set(["interpreted_string_literal", "raw_string_literal"]);
export const isStringLiteral = (n: SgNode): boolean => STRING_KINDS.has(kindOf(n));

/** The value of a Go string literal: interpreted (`"..."`, escapes read) or raw (`` `...` ``). */
export function goStringValue(n: SgNode): string | null {
  const t = n.text();
  if (kindOf(n) === "raw_string_literal") return t.slice(1, -1).replace(/\r/g, "");
  if (kindOf(n) !== "interpreted_string_literal") return null;
  try {
    return JSON.parse(t) as string;
  } catch {
    return t
      .slice(1, -1)
      .replace(/\\(["\\])/g, "$1")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
}

/** `+` operands of a (nested) concatenation, left to right; the node itself when it is not one. */
export function concatOperands(n: SgNode): SgNode[] {
  const x = unparen(n);
  if (kindOf(x) === "binary_expression" && x.field("operator")?.text() === "+") {
    const l = x.field("left");
    const r = x.field("right");
    if (l && r) return [...concatOperands(l), ...concatOperands(r)];
  }
  return [x];
}

/** Specs of the `const` and `var` declarations at the top level of a file: name to the node of its value. */
export function topLevelValues(root: SgNode): Map<string, SgNode> {
  const out = new Map<string, SgNode>();
  const specs = (n: SgNode): void => {
    for (const c of named(n)) {
      const k = kindOf(c);
      if (k === "const_spec" || k === "var_spec") {
        const names = c.fieldChildren("name").filter((x) => kindOf(x) === "identifier");
        const values = c.field("value") ? named(c.field("value") as SgNode) : [];
        names.forEach((id, i) => {
          const v = values[i];
          if (v) out.set(id.text(), v);
        });
      } else if (k.endsWith("_list")) specs(c);
    }
  };
  for (const d of named(root)) {
    const k = kindOf(d);
    if (k === "const_declaration" || k === "var_declaration") specs(d);
  }
  return out;
}

/** The name a type expression stands for (`*User`, `[]User`, `pkg.User`, `User{}`, `&User{}`); null for anything else. */
export function goTypeName(n: SgNode | null | undefined, depth = 0): string | null {
  if (!n || depth > 6) return null;
  const x = unparen(n);
  switch (kindOf(x)) {
    case "type_identifier":
      return x.text();
    case "qualified_type":
      return x.field("name")?.text() ?? null;
    case "pointer_type":
    case "slice_type":
    case "array_type":
    case "parenthesized_type": {
      const inner = x.field("element") ?? named(x)[0];
      return goTypeName(inner, depth + 1);
    }
    case "generic_type":
      return goTypeName(x.field("type"), depth + 1);
    case "composite_literal":
      return goTypeName(x.field("type"), depth + 1);
    case "unary_expression":
      return x.field("operator")?.text() === "&" ? goTypeName(x.field("operand"), depth + 1) : null;
    default:
      return null;
  }
}

/** The statements of a block, also when the grammar wraps them in a statement list. */
export function statementsOf(block: SgNode): SgNode[] {
  const out: SgNode[] = [];
  for (const c of named(block)) {
    if (kindOf(c) === "statement_list") out.push(...named(c));
    else out.push(c);
  }
  return out;
}

export interface GoDecl {
  /** The identifier that declares the name. */
  ident: SgNode;
  /** The value assigned in the declaration, when there is one and it lines up with the name. */
  value: SgNode | null;
  /** A parameter of the function (or function literal) it belongs to. */
  param?: { fn: SgNode; index: number };
}

const FN_KINDS = new Set(["function_declaration", "method_declaration", "func_literal"]);
export const isGoFunction = (n: SgNode): boolean => FN_KINDS.has(kindOf(n));

/** Parameter identifiers of a function, in order (`a, b T` gives two). The receiver of a method is not one. */
export function goParams(fn: SgNode): SgNode[] {
  const list = fn.field("parameters");
  if (!list) return [];
  const out: SgNode[] = [];
  for (const p of named(list)) {
    if (kindOf(p) !== "parameter_declaration" && kindOf(p) !== "variadic_parameter_declaration") continue;
    const names = p.fieldChildren("name").filter((x) => kindOf(x) === "identifier");
    if (names.length === 0) out.push(p);
    else out.push(...names);
  }
  return out;
}

function declsInStatement(st: SgNode, name: string): GoDecl[] {
  const out: GoDecl[] = [];
  const k = kindOf(st);
  if (k === "short_var_declaration") {
    const left = st.field("left");
    const right = st.field("right");
    const ids = left ? named(left) : [];
    const values = right ? named(right) : [];
    ids.forEach((id, i) => {
      if (kindOf(id) === "identifier" && id.text() === name)
        out.push({ ident: id, value: ids.length === values.length ? (values[i] ?? null) : null });
    });
  } else if (k === "var_declaration") {
    const walk = (n: SgNode): void => {
      for (const c of named(n)) {
        if (kindOf(c) === "var_spec") {
          const ids = c.fieldChildren("name").filter((x) => kindOf(x) === "identifier");
          const v = c.field("value");
          const values = v ? named(v) : [];
          ids.forEach((id, i) => {
            if (id.text() === name)
              out.push({ ident: id, value: ids.length === values.length ? (values[i] ?? null) : null });
          });
        } else if (kindOf(c).endsWith("_list")) walk(c);
      }
    };
    walk(st);
  }
  return out;
}

/**
 * The declaration a name used at `use` refers to: the nearest parameter of the functions around it, or the nearest
 * `x :=` / `var x` before it in the blocks around it, or a package-level `var` of the file. Syntax only, one file.
 */
export function findGoDecl(use: SgNode, name: string): GoDecl | null {
  const at = use.range().start.index;
  for (let a = use.parent(); a; a = a.parent()) {
    const k = kindOf(a);
    if (k === "block" || k === "source_file") {
      let best: GoDecl | null = null;
      for (const st of statementsOf(a)) {
        const pos = st.range().start.index;
        // Package-level declarations are visible everywhere in the file; local ones from their end.
        if (k === "block" && st.range().end.index > at) {
          if (pos >= at) break;
          continue;
        }
        for (const d of declsInStatement(st, name)) best = d;
      }
      if (best) return best;
    }
    if (isGoFunction(a)) {
      const ps = goParams(a);
      const index = ps.findIndex((p) => p.text() === name);
      if (index >= 0) return { ident: ps[index] as SgNode, value: null, param: { fn: a, index } };
    }
  }
  return null;
}

/** Functions and methods declared by `name` (a function name, or a method name without its type) in a file. */
export function declsNamed(root: SgNode, name: string): SgNode[] {
  return named(root).filter(
    (d) =>
      (kindOf(d) === "function_declaration" || kindOf(d) === "method_declaration") &&
      d.field("name")?.text() === name,
  );
}

/** The expressions a function returns, outside the function literals inside it. */
export function returnedExpressions(fn: SgNode): SgNode[] {
  const body = fn.field("body");
  if (!body) return [];
  const out: SgNode[] = [];
  for (const r of body.findAll({ rule: { kind: "return_statement" } })) {
    let inner = false;
    for (let a = r.parent(); a && a !== fn; a = a.parent()) {
      if (kindOf(a) === "func_literal") {
        inner = true;
        break;
      }
    }
    if (inner) continue;
    const list = named(r)[0];
    const first = list ? (kindOf(list) === "expression_list" ? named(list)[0] : list) : undefined;
    if (first) out.push(first);
  }
  return out;
}
