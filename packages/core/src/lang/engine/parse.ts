import picomatch from "picomatch";
import { fileId as makeFileId, symId } from "../../ids.js";
import type { ParsedFile, ParsedImport } from "../../parse/index.js";
import type { ParsedSymbol, SymbolKind } from "../../types.js";
import { parseTree, type SyntaxNode } from "./grammar.js";
import type { BaseTypeRule, DeclarationRule, LanguagePack } from "./pack.js";
import { bodiedName, bodiedRule, walkDeclarations } from "./walk.js";

/** File directive recorded on a generated file; the duplicate engine skips files that carry it. */
export const GENERATED_DIRECTIVE = "generated";

const generatedMatchers = new WeakMap<LanguagePack, (path: string) => boolean>();

/** True for a path the pack's `generatedPaths` globs match. */
function generatedPath(pack: LanguagePack): (path: string) => boolean {
  let m = generatedMatchers.get(pack);
  if (!m) {
    m = pack.generatedPaths.length > 0 ? picomatch([...pack.generatedPaths], { dot: true }) : () => false;
    generatedMatchers.set(pack, m);
  }
  return m;
}

/**
 * Rule `exported` of a pack, for the declaration of `name`: a capital letter, a modifier keyword among the modifiers of
 * `node` (or a body in the rule's `implicit` kinds, named by `container`), or a name that does not start with `_`.
 */
export function isExportedName(
  pack: LanguagePack,
  name: string,
  node?: SyntaxNode,
  container?: string | null,
): boolean {
  const rule = pack.nodes.exported;
  switch (rule.by) {
    case "capital": {
      const c = name.charAt(0);
      return c !== c.toLowerCase() && c === c.toUpperCase();
    }
    case "underscore":
      return !name.startsWith("_");
    case "modifier": {
      if (container && rule.implicit.includes(container)) return true;
      const mods = node?.children().find((c) => c.kind() === rule.node);
      return mods?.children().some((c) => rule.keywords.includes(c.kind())) ?? false;
    }
  }
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
export function specsOf(
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

/** Symbols of a file as drafts, in source order: top-level declarations and the members of type bodies. */
function draftsOf(pack: LanguagePack, root: SyntaxNode): Draft[] {
  const n = pack.nodes;
  const out: Draft[] = [];
  walkDeclarations(pack, root, ({ node: d, owner, container, body: hanging }) => {
    // A hanging body is no symbol itself; its methods are, named after it.
    if (hanging) return;
    const kind = d.kind();
    const fn = owner === null ? n.function.find((r) => r.kind === kind) : undefined;
    const method = n.method.find((r) => r.kind === kind);
    const bodied = bodiedRule(pack, kind);
    if (fn || method) {
      const rule = (fn ?? method) as DeclarationRule;
      const name = d.field(rule.name)?.text();
      if (!name) return;
      const body = rule.body ? d.field(rule.body) : null;
      if (fn) {
        out.push({
          name,
          kind: "function",
          exported: isExportedName(pack, name, d, container),
          node: d,
          signature: signatureOf(pack, rule, d),
          body,
        });
        return;
      }
      let qualified: string;
      if (rule.receiver) {
        const r = n.receiver;
        if (owner !== null || !r) return;
        const recv = d
          .field(rule.receiver)
          ?.namedChildren()
          .find((c) => c.kind() === r.parameter);
        qualified = `${baseTypeName(r.baseType, recv?.field(r.type) ?? null)}.${name}`;
      } else if (owner !== null) qualified = `${owner}.${name}`;
      else return;
      out.push({
        name: qualified,
        kind: "method",
        exported: isExportedName(pack, name, d, container),
        node: d,
        signature: signatureOf(pack, rule, d),
        body,
      });
    } else if (bodied) {
      const name = bodiedName(bodied, d, owner);
      if (name)
        out.push({
          name,
          kind: bodied.as,
          exported: isExportedName(pack, d.field(bodied.name)?.text() ?? "", d, container),
          node: d,
          signature: "",
          body: null,
        });
    } else if (owner === null && n.types.declarations.includes(kind)) {
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
        if (im && name && !n.types.aliases.includes(s.kind()) && iface?.kind() === im.container) {
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
    } else if (owner === null && n.values.declarations.includes(kind)) {
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
  });
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

/** The local name of an import without an alias: `example.org/x/text/v2` -> `text`. */
export function defaultImportName(pack: LanguagePack, path: string): string {
  const parts = path.split(pack.nodes.import.separator);
  let last = parts[parts.length - 1] ?? path;
  if (pack.nodes.import.localName.skip.test(last) && parts.length > 1)
    last = parts[parts.length - 2] as string;
  return last;
}

/**
 * An import as written. `specifier` is the path without its quotes; for a pack with named imports it is the package (or
 * type) the names come from, `name` the one name brought in (`*` for every name), and `static` says they are members.
 * `name` is null for an import of a whole package.
 */
export interface RawImport {
  alias: string | null;
  specifier: string;
  name: string | null;
  static: boolean;
  line: number;
}

/** The imports of a file in source order, as written. */
export function rawImportsOf(pack: LanguagePack, root: SyntaxNode): RawImport[] {
  const rule = pack.nodes.import;
  const out: RawImport[] = [];
  const unquote = (s: string): string => {
    const head = s.length > 0 && rule.quotes.includes(s.charAt(0)) ? s.slice(1) : s;
    return head.length > 0 && rule.quotes.includes(head.charAt(head.length - 1)) ? head.slice(0, -1) : head;
  };
  const add = (c: SyntaxNode): void => {
    const kinds = rule.pathKinds;
    const path = kinds ? c.namedChildren().find((x) => kinds.includes(x.kind())) : c.field(rule.path ?? "");
    if (!path) return;
    const alias = rule.alias ? (c.field(rule.alias)?.text() ?? null) : null;
    const line = c.range().start.line + 1;
    const text = kinds ? path.text().replace(/\s+/g, "") : unquote(path.text());
    const named = rule.named;
    if (!named) {
      out.push({ alias, specifier: text, name: null, static: false, line });
      return;
    }
    const isStatic = c.children().some((x) => x.kind() === named.static);
    if (c.namedChildren().some((x) => x.kind() === named.onDemand)) {
      out.push({ alias, specifier: text, name: "*", static: isStatic, line });
      return;
    }
    const cut = text.lastIndexOf(rule.separator);
    out.push({
      alias,
      specifier: cut < 0 ? "" : text.slice(0, cut),
      name: cut < 0 ? text : text.slice(cut + rule.separator.length),
      static: isStatic,
      line,
    });
  };
  const specs = (n: SyntaxNode): void => {
    for (const c of n.namedChildren()) {
      if (rule.specs.includes(c.kind())) add(c);
      else if (rule.groups.includes(c.kind())) specs(c);
    }
  };
  for (const d of root.namedChildren()) {
    if (!rule.declarations.includes(d.kind())) continue;
    if (rule.specs.includes(d.kind())) add(d);
    else specs(d);
  }
  return out;
}

function importsOf(pack: LanguagePack, root: SyntaxNode): ParsedImport[] {
  return rawImportsOf(pack, root).map((i) => ({
    local: i.alias ?? i.name ?? defaultImportName(pack, i.specifier),
    imported: i.name ?? "*",
    specifier: i.specifier,
    typeOnly: false,
    line: i.line,
  }));
}

/**
 * Parse one file of a pack's language: declarations with their ids, ranges and measures, plus the imports. Calls and type
 * references are not extracted (no `sites`).
 *
 * Ids follow spec section 6: `sym:<repo>:<path>#<name>`; a method is `#<Recv>.<name>` with the receiver's (or the
 * enclosing type's) name; repeated names in one file get `~2`, `~3` in source order. The result holds no node, so nothing
 * keeps the tree alive after the call; it is freed later by the library's finalizer, not at once.
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
    if (pack.generatedPatterns.some((re) => re.test(source)) || generatedPath(pack)(repoRelPath))
      result.directives = [GENERATED_DIRECTIVE];
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
