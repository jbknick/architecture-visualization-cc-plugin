import { fileId as makeFileId, symId } from "../../ids.js";
import type { ParsedFile, ParsedImport } from "../../parse/index.js";
import type { ParsedSymbol, SymbolKind } from "../../types.js";
import { type GoNode, parseGo } from "./grammar.js";

/** A generated Go file announces itself in a header comment (`go generate` convention). */
export const GO_GENERATED_RE = /^\/\/ Code generated .* DO NOT EDIT\.$/m;

/** File directive recorded on a generated Go file; the duplicate engine skips files that carry it. */
export const GO_GENERATED_DIRECTIVE = "generated";

const SIGNATURE_MAX = 200;
const SPEC_KINDS = new Set(["type_spec", "type_alias", "const_spec", "var_spec"]);
const STATEMENT_KINDS = [
  "expression_statement",
  "short_var_declaration",
  "assignment_statement",
  "inc_statement",
  "dec_statement",
  "return_statement",
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
  "go_statement",
  "defer_statement",
  "break_statement",
  "continue_statement",
  "goto_statement",
  "fallthrough_statement",
  "labeled_statement",
  "send_statement",
  "var_declaration",
  "const_declaration",
  "type_declaration",
];
const BRANCH_KINDS = ["if_statement", "for_statement", "expression_case", "type_case", "communication_case"];

/** Exported = the name starts with an upper-case letter. */
export function isExportedName(name: string): boolean {
  const c = name.charAt(0);
  return c !== c.toLowerCase() && c === c.toUpperCase();
}

/** Base type name of a receiver or type expression: `*S[T]` -> `S`. `?` when the shape is not recognised. */
export function baseTypeName(n: GoNode | null): string {
  let cur = n;
  while (cur) {
    const k = cur.kind();
    if (k === "type_identifier" || k === "identifier") return cur.text();
    if (k === "pointer_type" || k === "parenthesized_type") cur = cur.namedChildren()[0] ?? null;
    else if (k === "generic_type") cur = cur.field("type");
    else return "?";
  }
  return "?";
}

const collapse = (text: string): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > SIGNATURE_MAX ? `${t.slice(0, SIGNATURE_MAX - 1)}…` : t;
};

interface Draft {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  node: GoNode;
  signature: string;
  /** The function body, when the declaration has one. */
  body: GoNode | null;
}

/** Specs of a declaration (`type`, `const`, `var`), also those inside the `(...)` list node of a grouped `var`. */
function specsOf(decl: GoNode, into: GoNode[] = []): GoNode[] {
  for (const c of decl.namedChildren()) {
    if (SPEC_KINDS.has(c.kind())) into.push(c);
    else if (c.kind().endsWith("_list")) specsOf(c, into);
  }
  return into;
}

function typeKind(spec: GoNode): SymbolKind {
  if (spec.kind() === "type_alias") return "type";
  const t = spec.field("type")?.kind();
  return t === "struct_type" ? "class" : t === "interface_type" ? "interface" : "type";
}

/** Top-level symbols of a file as drafts, in source order. */
function draftsOf(root: GoNode): Draft[] {
  const out: Draft[] = [];
  for (const d of root.namedChildren()) {
    switch (d.kind()) {
      case "function_declaration": {
        const name = d.field("name")?.text();
        if (!name) break;
        const sig = collapse(`${d.field("parameters")?.text() ?? "()"} ${d.field("result")?.text() ?? ""}`);
        out.push({
          name,
          kind: "function",
          exported: isExportedName(name),
          node: d,
          signature: sig,
          body: d.field("body"),
        });
        break;
      }
      case "method_declaration": {
        const name = d.field("name")?.text();
        if (!name) break;
        const recv = d
          .field("receiver")
          ?.namedChildren()
          .find((c) => c.kind() === "parameter_declaration");
        const base = baseTypeName(recv?.field("type") ?? null);
        const sig = collapse(`${d.field("parameters")?.text() ?? "()"} ${d.field("result")?.text() ?? ""}`);
        out.push({
          name: `${base}.${name}`,
          kind: "method",
          exported: isExportedName(name),
          node: d,
          signature: sig,
          body: d.field("body"),
        });
        break;
      }
      case "type_declaration":
        for (const s of specsOf(d)) {
          const name = s.field("name")?.text();
          if (name)
            out.push({
              name,
              kind: typeKind(s),
              exported: isExportedName(name),
              node: s,
              signature: "",
              body: null,
            });
          // Methods of an interface are symbols too (`#<Iface>.<Method>`), so a call through the interface has a target.
          const iface = s.field("type");
          if (name && s.kind() === "type_spec" && iface?.kind() === "interface_type") {
            for (const m of iface.namedChildren()) {
              const mn = m.kind() === "method_elem" ? m.field("name")?.text() : undefined;
              if (!mn) continue;
              out.push({
                name: `${name}.${mn}`,
                kind: "method",
                exported: isExportedName(mn),
                node: m,
                signature: collapse(
                  `${m.field("parameters")?.text() ?? "()"} ${m.field("result")?.text() ?? ""}`,
                ),
                body: null,
              });
            }
          }
        }
        break;
      case "const_declaration":
      case "var_declaration":
        for (const s of specsOf(d)) {
          // `const a, b = 1, 2`: the `name` field repeats and the commas are not identifiers.
          for (const n of s.fieldChildren("name")) {
            if (n.kind() !== "identifier") continue;
            const name = n.text();
            out.push({
              name,
              kind: "const",
              exported: isExportedName(name),
              node: s,
              signature: "",
              body: null,
            });
          }
        }
        break;
    }
  }
  return out;
}

function measure(body: GoNode | null): { complexity: number; stmtCount: number } {
  if (!body) return { complexity: 1, stmtCount: 0 };
  let complexity = 1 + body.findAll({ rule: { any: BRANCH_KINDS.map((kind) => ({ kind })) } }).length;
  for (const b of body.findAll({ rule: { kind: "binary_expression" } })) {
    const op = b.field("operator")?.text();
    if (op === "&&" || op === "||") complexity++;
  }
  const stmtCount = body.findAll({ rule: { any: STATEMENT_KINDS.map((kind) => ({ kind })) } }).length;
  return { complexity, stmtCount };
}

const unquote = (s: string): string => s.replace(/^["`]|["`]$/g, "");

/** `golang.org/x/text/v2` -> `text`; `fmt` -> `fmt`. */
function defaultImportName(path: string): string {
  const parts = path.split("/");
  let last = parts[parts.length - 1] ?? path;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2] as string;
  return last;
}

function importsOf(root: GoNode): ParsedImport[] {
  const out: ParsedImport[] = [];
  const specs = (n: GoNode): void => {
    for (const c of n.namedChildren()) {
      if (c.kind() === "import_spec") {
        const path = c.field("path");
        if (!path) continue;
        const specifier = unquote(path.text());
        const alias = c.field("name")?.text();
        out.push({
          local: alias ?? defaultImportName(specifier),
          imported: "*",
          specifier,
          typeOnly: false,
          line: c.range().start.line + 1,
        });
      } else if (c.kind() === "import_spec_list") specs(c);
    }
  };
  for (const d of root.namedChildren()) if (d.kind() === "import_declaration") specs(d);
  return out;
}

/**
 * Parse one Go file: top-level functions, methods, types, constants and variables with their ids, ranges and
 * measures, plus the imports. Calls and type references are not extracted yet (no `sites`).
 *
 * Ids follow spec section 6: `sym:<repo>:<path>#<name>`; a method is `#<Recv>.<name>` with the receiver's base type;
 * repeated names in one file (`init`, `_`) get `~2`, `~3` in source order.
 */
export function parseGoSource(repo: string, repoRelPath: string, source: string): ParsedFile {
  const fileId = makeFileId(repo, repoRelPath);
  const result: ParsedFile = {
    fileId,
    symbols: [],
    imports: [],
    exports: [],
    sites: [],
    bodies: new Map(),
    errors: [],
  };
  try {
    const root = parseGo(source);
    const err = root.find({ rule: { kind: "ERROR" } });
    if (err) result.errors.push(`line ${err.range().start.line + 1}: syntax error`);
    if (GO_GENERATED_RE.test(source)) result.directives = [GO_GENERATED_DIRECTIVE];
    result.imports.push(...importsOf(root));
    const seen = new Map<string, number>();
    for (const d of draftsOf(root)) {
      const base = symId(repo, repoRelPath, d.name);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const id = n === 1 ? base : `${base}~${n}`;
      const r = d.node.range();
      const startLine = r.start.line + 1;
      const endLine = Math.max(startLine, r.end.line + 1);
      const m = measure(d.body);
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
      result.bodies.set(id, { start: r.start.index, end: r.end.index });
    }
  } catch (err) {
    result.errors.push(`parser failure: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}
