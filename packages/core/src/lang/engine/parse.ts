import { fileId as makeFileId, symId } from "../../ids.js";
import type { ParsedFile, ParsedImport } from "../../parse/index.js";
import type { ParsedSymbol, SymbolKind } from "../../types.js";
import { parseTree, type SyntaxNode } from "./grammar.js";
import type { BaseTypeRule, DeclarationRule, LanguagePack } from "./pack.js";

/** File directive recorded on a generated file; the duplicate engine skips files that carry it. */
export const GENERATED_DIRECTIVE = "generated";

/** Rule `exported` of a pack: `capitalized` is an upper-case first letter. */
export function isExportedName(pack: LanguagePack, name: string): boolean {
  const c = name.charAt(0);
  return pack.nodes.exported === "capitalized" && c !== c.toLowerCase() && c === c.toUpperCase();
}

/** Base type name of a receiver or type expression: `*S[T]` -> `S`. The pack's `unknown` when the shape is not recognised. */
export function baseTypeName(rule: BaseTypeRule, n: SyntaxNode | null): string {
  let cur = n;
  while (cur) {
    const k = cur.kind();
    if (rule.names.includes(k)) return cur.text();
    if (rule.wrappers.includes(k)) cur = cur.namedChildren()[0] ?? null;
    else if (k === rule.generic.kind) cur = cur.field(rule.generic.field);
    else return rule.unknown;
  }
  return rule.unknown;
}

interface Draft {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  node: SyntaxNode;
  signature: string;
  /** The body, when the declaration has one. */
  body: SyntaxNode | null;
}

const collapse = (pack: LanguagePack, text: string): string => {
  const max = pack.nodes.signature.maxLength;
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function signatureOf(pack: LanguagePack, rule: Omit<DeclarationRule, "kind">, d: SyntaxNode): string {
  return collapse(
    pack,
    `${d.field(rule.parameters)?.text() ?? pack.nodes.signature.empty} ${d.field(rule.result)?.text() ?? ""}`,
  );
}

/** Specs of a declaration, also those inside a grouping node. */
function specsOf(
  decl: SyntaxNode,
  specs: readonly string[],
  groups: readonly string[],
  into: SyntaxNode[] = [],
): SyntaxNode[] {
  for (const c of decl.namedChildren()) {
    if (specs.includes(c.kind())) into.push(c);
    else if (groups.includes(c.kind())) specsOf(c, specs, groups, into);
  }
  return into;
}

function typeKind(pack: LanguagePack, spec: SyntaxNode): SymbolKind {
  const t = pack.nodes.types;
  if (t.aliases.includes(spec.kind())) return "type";
  const k = spec.field(t.type)?.kind();
  if (k === undefined) return "type";
  return t.class.includes(k) ? "class" : t.interface.includes(k) ? "interface" : "type";
}

/** Top-level symbols of a file as drafts, in source order. */
function draftsOf(pack: LanguagePack, root: SyntaxNode): Draft[] {
  const n = pack.nodes;
  const out: Draft[] = [];
  for (const d of root.namedChildren()) {
    const kind = d.kind();
    const fn = n.function.find((r) => r.kind === kind);
    const method = n.method.find((r) => r.kind === kind);
    if (fn || method) {
      const rule = (fn ?? method) as DeclarationRule;
      const name = d.field(rule.name)?.text();
      if (!name) continue;
      const body = rule.body ? d.field(rule.body) : null;
      if (fn) {
        out.push({
          name,
          kind: "function",
          exported: isExportedName(pack, name),
          node: d,
          signature: signatureOf(pack, rule, d),
          body,
        });
        continue;
      }
      const recv = (rule.receiver ? d.field(rule.receiver) : null)
        ?.namedChildren()
        .find((c) => c.kind() === n.receiver.parameter);
      const base = baseTypeName(n.receiver.baseType, recv?.field(n.receiver.type) ?? null);
      out.push({
        name: `${base}.${name}`,
        kind: "method",
        exported: isExportedName(pack, name),
        node: d,
        signature: signatureOf(pack, rule, d),
        body,
      });
    } else if (n.types.declarations.includes(kind)) {
      for (const s of specsOf(d, n.types.specs, n.types.groups)) {
        const name = s.field(n.types.name)?.text();
        if (name)
          out.push({
            name,
            kind: typeKind(pack, s),
            exported: isExportedName(pack, name),
            node: s,
            signature: "",
            body: null,
          });
        // Methods of an interface are symbols too (`#<Iface>.<Method>`), so a call through the interface has a target.
        const im = n.types.interfaceMethods;
        const iface = s.field(n.types.type);
        if (name && !n.types.aliases.includes(s.kind()) && iface?.kind() === im.container) {
          for (const m of iface.namedChildren()) {
            const mn = im.members.includes(m.kind()) ? m.field(im.rule.name)?.text() : undefined;
            if (!mn) continue;
            out.push({
              name: `${name}.${mn}`,
              kind: "method",
              exported: isExportedName(pack, mn),
              node: m,
              signature: signatureOf(pack, im.rule, m),
              body: null,
            });
          }
        }
      }
    } else if (n.values.declarations.includes(kind)) {
      for (const s of specsOf(d, n.values.specs, n.values.groups)) {
        // `const a, b = 1, 2`: the name field repeats and the commas are not names.
        for (const id of s.fieldChildren(n.values.name)) {
          if (!n.values.nameKinds.includes(id.kind())) continue;
          const name = id.text();
          out.push({
            name,
            kind: "const",
            exported: isExportedName(pack, name),
            node: s,
            signature: "",
            body: null,
          });
        }
      }
    }
  }
  return out;
}

function measure(pack: LanguagePack, body: SyntaxNode | null): { complexity: number; stmtCount: number } {
  if (!body) return { complexity: 1, stmtCount: 0 };
  const m = pack.nodes.measure;
  let complexity = 1 + body.findAll({ rule: { any: m.branches.map((kind) => ({ kind })) } }).length;
  for (const b of body.findAll({ rule: { kind: m.binary.kind } })) {
    const op = b.field(m.binary.operator)?.text();
    if (op !== undefined && m.binary.operators.includes(op)) complexity++;
  }
  const stmtCount = body.findAll({ rule: { any: m.statements.map((kind) => ({ kind })) } }).length;
  return { complexity, stmtCount };
}

/** The local name of an import without an alias: `golang.org/x/text/v2` -> `text`. */
function defaultImportName(pack: LanguagePack, path: string): string {
  const rule = pack.nodes.import.localName;
  const parts = path.split(rule.separator);
  let last = parts[parts.length - 1] ?? path;
  if (rule.skip.test(last) && parts.length > 1) last = parts[parts.length - 2] as string;
  return last;
}

function importsOf(pack: LanguagePack, root: SyntaxNode): ParsedImport[] {
  const rule = pack.nodes.import;
  const out: ParsedImport[] = [];
  const unquote = (s: string): string => {
    const head = s.length > 0 && rule.quotes.includes(s.charAt(0)) ? s.slice(1) : s;
    return head.length > 0 && rule.quotes.includes(head.charAt(head.length - 1)) ? head.slice(0, -1) : head;
  };
  const specs = (n: SyntaxNode): void => {
    for (const c of n.namedChildren()) {
      if (rule.specs.includes(c.kind())) {
        const path = c.field(rule.path);
        if (!path) continue;
        const specifier = unquote(path.text());
        const alias = c.field(rule.alias)?.text();
        out.push({
          local: alias ?? defaultImportName(pack, specifier),
          imported: "*",
          specifier,
          typeOnly: false,
          line: c.range().start.line + 1,
        });
      } else if (rule.groups.includes(c.kind())) specs(c);
    }
  };
  for (const d of root.namedChildren()) if (rule.declarations.includes(d.kind())) specs(d);
  return out;
}

/**
 * Parse one file of a pack's language: top-level declarations with their ids, ranges and measures, plus the imports.
 * Calls and type references are not extracted (no `sites`).
 *
 * Ids follow spec section 6: `sym:<repo>:<path>#<name>`; a method is `#<Recv>.<name>` with the receiver's base type;
 * repeated names in one file get `~2`, `~3` in source order. The tree is released as soon as the result is built.
 */
export function parseWithPack(
  pack: LanguagePack,
  repo: string,
  repoRelPath: string,
  source: string,
): ParsedFile {
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
    const root = parseTree(pack, source);
    const err = root.find({ rule: { kind: pack.nodes.errorKind } });
    if (err) result.errors.push(`line ${err.range().start.line + 1}: syntax error`);
    if (pack.generatedPatterns.some((re) => re.test(source))) result.directives = [GENERATED_DIRECTIVE];
    result.imports.push(...importsOf(pack, root));
    const seen = new Map<string, number>();
    for (const d of draftsOf(pack, root)) {
      const base = symId(repo, repoRelPath, d.name);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const id = n === 1 ? base : `${base}~${n}`;
      const r = d.node.range();
      const startLine = r.start.line + 1;
      const endLine = Math.max(startLine, r.end.line + 1);
      const m = measure(pack, d.body);
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
