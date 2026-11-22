import { readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import type { ParsedFile } from "../../../parse/index.js";
import { EVIDENCE_CAP, type ResolveContext } from "../../../resolve/index.js";
import type { EdgeRecord, ParsedSymbol } from "../../../types.js";
import { parseTree, type SyntaxNode } from "../grammar.js";
import type { CallResolver } from "../module.js";
import type { LanguagePack } from "../pack.js";
import { type FileEntry, ImportIndex } from "./imports.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The part of a symbol name after the last dot: a method `Recv.run` is called `run`. */
const bareName = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

interface Target {
  symbol: ParsedSymbol;
  confidence: "high" | "low";
}

/** Accumulates edges by (src, dst): counts add up, evidence is capped, `high` wins. */
class EdgeSet {
  private readonly map = new Map<string, EdgeRecord>();
  constructor(private readonly fileId: string) {}

  add(src: string, dst: string, confidence: "high" | "low", evidence: string): void {
    const key = `${src}\0${dst}`;
    let e = this.map.get(key);
    if (!e) {
      e = { src, dst, kind: "calls", confidence, count: 0, evidence: [], fileId: this.fileId, level: 1 };
      this.map.set(key, e);
    }
    e.count++;
    if (confidence === "high") e.confidence = "high";
    if (e.evidence.length < EVIDENCE_CAP && !e.evidence.includes(evidence)) e.evidence.push(evidence);
  }

  edges(): EdgeRecord[] {
    return [...this.map.values()];
  }
}

/**
 * Level 1 call resolution (spec section 7): a call is resolved from names alone, with the node kinds and fields the pack
 * names. A bare name goes to the function of that name in the same file (`high`), else to the only function or method of
 * that name in the caller's workspace or one it depends on (`low`; test files only for a caller in a test file). A name
 * reached through an operand that is an import goes to the one function of that name in the files the import names
 * (`high`), and to nothing when the import is external. A name reached through any other operand gives no edge: receivers
 * are for the levels that read types. A name with several candidates gives no edge.
 */
export class NameCalls implements CallResolver {
  private readonly index: ImportIndex;
  private readonly roots = new Map<string, SyntaxNode>();
  private readonly imports = new Map<string, Map<string, string>>();
  private byName: Map<string, { symbol: ParsedSymbol; file: FileEntry }[]> | undefined;
  private readonly isTest: (rel: string) => boolean;
  private readonly at = new Map<string, Map<string, SyntaxNode>>();

  constructor(
    private readonly pack: LanguagePack,
    private readonly ctx: ResolveContext,
  ) {
    this.index = new ImportIndex(pack, ctx);
    this.isTest = picomatch([...pack.testPatterns], { dot: true });
  }

  private root(entry: FileEntry): SyntaxNode | null {
    const hit = this.roots.get(entry.fileId);
    if (hit) return hit;
    try {
      const root = parseTree(this.pack, readFileSync(join(this.ctx.root, entry.rel), "utf8"));
      this.roots.set(entry.fileId, root);
      return root;
    } catch {
      return null;
    }
  }

  /** Local import name to import path, first import of a name wins. */
  private importsOf(entry: FileEntry): Map<string, string> {
    let m = this.imports.get(entry.fileId);
    if (!m) {
      m = new Map();
      for (const i of entry.parsed.imports) if (!m.has(i.local)) m.set(i.local, i.specifier);
      this.imports.set(entry.fileId, m);
    }
    return m;
  }

  /** Function and method symbols of the language by their bare name, with their files, in path order. */
  private symbolsByName(): Map<string, { symbol: ParsedSymbol; file: FileEntry }[]> {
    if (this.byName) return this.byName;
    const out = new Map<string, { symbol: ParsedSymbol; file: FileEntry }[]>();
    for (const f of this.index.files) {
      for (const s of f.parsed.symbols) {
        if (s.kind !== "function" && s.kind !== "method") continue;
        const key = bareName(s.name);
        const list = out.get(key) ?? [];
        list.push({ symbol: s, file: f });
        out.set(key, list);
      }
    }
    this.byName = out;
    return out;
  }

  /** True when a symbol of `file` may be named by a bare name used in `from`: same workspace or one it depends on, and no test file unless `from` is one. */
  private reachable(from: FileEntry, file: FileEntry): boolean {
    if (this.isTest(file.rel) && !this.isTest(from.rel)) return false;
    const a = from.workspace;
    const b = file.workspace;
    return a?.id === b?.id || (a !== undefined && b !== undefined && a.deps.includes(b.name));
  }

  /** The symbol a callee expression names, or null when it has no single candidate. */
  private resolve(entry: FileEntry, callee: SyntaxNode | null): Target | null {
    if (!callee) return null;
    const rule = this.pack.nodes.callee;
    const only = (list: ParsedSymbol[], confidence: "high" | "low"): Target | null =>
      list.length === 1 && list[0] ? { symbol: list[0], confidence } : null;
    const kind = callee.kind();
    if (rule.names.includes(kind)) {
      const name = callee.text();
      const here = entry.parsed.symbols.filter((s) => s.kind === "function" && s.name === name);
      if (here.length > 0) return only(here, "high");
      // Every function and method of that name counts: a clash of any kind gives no edge, and the one candidate must be a function.
      const all = (this.symbolsByName().get(name) ?? [])
        .filter((c) => this.reachable(entry, c.file))
        .map((c) => c.symbol);
      return only(all.length === 1 ? all.filter((s) => s.kind === "function") : [], "low");
    }
    if (kind !== rule.member.kind) return null;
    const name = callee.field(rule.member.name)?.text();
    const operand = callee.field(rule.member.operand);
    if (!name || !operand || !rule.member.operands.includes(operand.kind())) return null;
    const specifier = this.importsOf(entry).get(operand.text());
    if (specifier === undefined) return null;
    const r = this.index.resolve(entry, specifier);
    if (r.kind === "external") return null;
    return only(
      r.files.flatMap((f) => f.parsed.symbols.filter((s) => s.kind === "function" && s.name === name)),
      "high",
    );
  }

  /** The innermost function or method of the file whose body holds the offset. */
  private callerAt(parsed: ParsedFile, offset: number): ParsedSymbol | null {
    let best: ParsedSymbol | null = null;
    let size = Number.POSITIVE_INFINITY;
    for (const s of parsed.symbols) {
      if (s.kind !== "function" && s.kind !== "method") continue;
      const r = parsed.bodies.get(s.id);
      if (r && r.start <= offset && offset < r.end && r.end - r.start < size) {
        best = s;
        size = r.end - r.start;
      }
    }
    return best;
  }

  edgesForFile(fileId: string, parsed: ParsedFile): EdgeRecord[] {
    const entry = this.index.byFileId.get(fileId);
    const root = entry ? this.root(entry) : null;
    if (!entry || !root) return [];
    const set = new EdgeSet(fileId);
    const sites = root.findAll({ rule: { any: this.pack.nodes.call.map((kind) => ({ kind })) } });
    for (const site of sites) {
      const callee = site.field(this.pack.nodes.callee.field);
      const target = this.resolve(entry, callee);
      const caller = this.callerAt(parsed, site.range().start.index);
      if (!target || !caller || target.symbol.id === caller.id) continue;
      set.add(
        caller.id,
        target.symbol.id,
        target.confidence,
        `${entry.rel}:${(callee ?? site).range().start.line + 1}`,
      );
    }
    return set.edges().sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
  }

  /** The expressions of a file a place can name: call sites, bare names and member names, by exact range. */
  private expressionsOf(entry: FileEntry, root: SyntaxNode): Map<string, SyntaxNode> {
    let m = this.at.get(entry.fileId);
    if (!m) {
      m = new Map();
      const rule = this.pack.nodes;
      const kinds = [...rule.call, ...rule.callee.names, rule.callee.member.kind];
      for (const n of root.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })) {
        const r = n.range();
        const key = `${r.start.index}:${r.end.index}`;
        if (!m.has(key)) m.set(key, n);
      }
      this.at.set(entry.fileId, m);
    }
    return m;
  }

  targetAt(fileId: string, start: number, end: number): string | null {
    const entry = this.index.byFileId.get(fileId);
    const root = entry ? this.root(entry) : null;
    if (!entry || !root) return null;
    const node = this.expressionsOf(entry, root).get(`${start}:${end}`);
    if (!node) return null;
    const callee = this.pack.nodes.call.includes(node.kind())
      ? node.field(this.pack.nodes.callee.field)
      : node;
    return this.resolve(entry, callee)?.symbol.id ?? null;
  }

  /** Level 1 reads no types. */
  typeNameAt(): string | null {
    return null;
  }
}

/** The call resolver of a pack for `buildLanguage`: level 1, names alone. */
export const nameCallResolver =
  (pack: LanguagePack) =>
  (ctx: ResolveContext): CallResolver =>
    new NameCalls(pack, ctx);
