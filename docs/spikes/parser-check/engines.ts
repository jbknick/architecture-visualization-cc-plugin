// The two extraction engines: tree-sitter with the grammar's own tags.scm, and @ast-grep/napi with a node-kind table.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { LANGS, type Lang } from "./langs.ts";
import { TABLES, type Table } from "./tables.ts";

export interface Counts {
  function: number;
  method: number;
  class: number;
  interface: number;
  module: number;
  call: number;
  new: number;
  macro: number;
  import: number;
  /** Tags that fall outside the categories above (constants, type aliases, macros definitions, references). */
  other: number;
}

export const KINDS = ["function", "method", "class", "interface", "module"] as const;

export const emptyCounts = (): Counts => ({
  function: 0,
  method: 0,
  class: 0,
  interface: 0,
  module: 0,
  call: 0,
  new: 0,
  macro: 0,
  import: 0,
  other: 0,
});

export function addCounts(into: Counts, add: Counts): void {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += add[k];
}

// ---------------------------------------------------------------- tree-sitter with tags.scm

interface TsNode {
  type: string;
  id: number;
}
interface TsTree {
  rootNode: TsNode & { hasError: boolean };
  delete(): void;
}
interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): TsTree | null;
  delete(): void;
}
interface TsQuery {
  matches(node: TsNode): { captures: { name: string; node: TsNode }[] }[];
  captureNames: string[];
  patternCount(): number;
  delete(): void;
}
interface TsModule {
  Parser: { new (): TsParser; init(): Promise<void> };
  Language: { load(path: string): Promise<{ abiVersion: number }> };
  Query: new (language: unknown, source: string) => TsQuery;
}

export interface TagsEngine {
  /** Parses and, when `extract` is true, runs the tags query. Frees the tree unless `free` is false. */
  run(source: string, extract: boolean, free: boolean): { counts: Counts; hasError: boolean } | null;
  query: TsQuery;
  abiVersion: number;
  tagsPath: string;
}

export const depsRequire = (work: string): NodeJS.Require => createRequire(join(work, "package.json"));

export async function loadTags(work: string, lang: Lang): Promise<TagsEngine> {
  const req = depsRequire(work);
  const ts = req("web-tree-sitter") as TsModule;
  await ts.Parser.init();
  const dir = join(work, "node_modules", lang.grammarPkg);
  const language = await ts.Language.load(join(dir, lang.wasm));
  const tags = readFileSync(join(dir, "queries", "tags.scm"), "utf8");
  const query = new ts.Query(language, tags);
  const parser = new ts.Parser();
  parser.setLanguage(language);
  return {
    query,
    abiVersion: language.abiVersion,
    tagsPath: join(dir, "queries", "tags.scm"),
    run(source, extract, free) {
      const tree = parser.parse(source);
      if (!tree) return null;
      const counts = emptyCounts();
      const hasError = tree.rootNode.hasError;
      if (extract) tagCounts(query.matches(tree.rootNode), counts);
      if (free) tree.delete();
      return { counts, hasError };
    },
  };
}

/**
 * Buckets the tags of one file. A tag is the one `@definition.*` or `@reference.*` capture of a match. Definitions go
 * by capture name; a call reference whose node is a macro invocation, and a class reference whose node is an object
 * creation, are counted as `macro` and `new`. Everything else is `other`. Where one node is tagged both as a method
 * and as a function (Rust), only the method is kept.
 */
export function tagCounts(matches: { captures: { name: string; node: TsNode }[] }[], counts: Counts): void {
  const methodNodes = new Set<number>();
  const functionNodes: number[] = [];
  for (const m of matches) {
    const tag = m.captures.find((c) => c.name.startsWith("definition.") || c.name.startsWith("reference."));
    if (!tag) continue;
    const role = tag.name;
    const type = tag.node.type;
    if (role === "definition.method") {
      counts.method++;
      methodNodes.add(tag.node.id);
    } else if (role === "definition.function") {
      counts.function++;
      functionNodes.push(tag.node.id);
    } else if (role === "definition.class") counts.class++;
    else if (role === "definition.interface") counts.interface++;
    else if (role === "definition.module") counts.module++;
    else if (role === "reference.call" || role === "reference.send") {
      if (type === "macro_invocation") counts.macro++;
      else counts.call++;
    } else if (role === "reference.class" && type === "object_creation_expression") counts.new++;
    else counts.other++;
  }
  for (const id of functionNodes) {
    if (methodNodes.has(id)) {
      counts.function--;
      counts.other++;
    }
  }
}

// ---------------------------------------------------------------- @ast-grep/napi with a node-kind table

interface SgNode {
  kind(): string;
  parent(): SgNode | null;
  field(name: string): SgNode | null;
  text(): string;
  findAll(matcher: { rule: Record<string, unknown> }): SgNode[];
  find(matcher: { rule: Record<string, unknown> }): SgNode | null;
}
interface SgModule {
  parse(lang: string, source: string): { root(): SgNode };
  registerDynamicLanguage(registrations: Record<string, unknown>): void;
}

export interface AstEngine {
  run(source: string, extract: boolean): { counts: Counts; hasError: boolean } | null;
}

let registered = false;

export function loadAstGrep(work: string, lang: Lang): AstEngine {
  const req = depsRequire(work);
  const sg = req("@ast-grep/napi") as SgModule;
  if (!registered) {
    const registrations: Record<string, unknown> = {};
    for (const l of LANGS) registrations[l.id] = req(l.astPkg);
    sg.registerDynamicLanguage(registrations);
    registered = true;
  }
  const table = TABLES[lang.id] as Table;
  const byKind = kindIndex(table);
  const matcher = { rule: { any: [...byKind.keys()].map((kind) => ({ kind })) } };
  return {
    run(source, extract) {
      const root = sg.parse(lang.id, source).root();
      const counts = emptyCounts();
      if (!extract) return { counts, hasError: false };
      for (const node of root.findAll(matcher)) classify(node, byKind, table, counts);
      return { counts, hasError: root.find({ rule: { kind: "ERROR" } }) !== null };
    },
  };
}

type Category = keyof Counts;

const DEFINITIONS = new Set<Category>(["function", "method", "class", "interface", "module"]);

function kindIndex(table: Table): Map<string, Category> {
  const byKind = new Map<string, Category>();
  const categories: Category[] = [
    "function",
    "method",
    "class",
    "interface",
    "module",
    "import",
    "call",
    "new",
    "macro",
  ];
  for (const category of categories) {
    for (const kind of table[category as keyof Table]) byKind.set(kind, category);
  }
  return byKind;
}

// classify:begin
function classify(node: SgNode, byKind: Map<string, Category>, table: Table, counts: Counts): void {
  const kind = node.kind();
  let category = byKind.get(kind) as Category;
  if (category === "function" && table.methodIn.length > 0) {
    for (let up = node.parent(); up; up = up.parent()) {
      const k = up.kind();
      if (table.methodIn.includes(k)) category = "method";
      if (table.methodIn.includes(k) || DEFINITIONS.has(byKind.get(k) as Category)) break;
    }
  }
  counts[category]++;
  if (table.importCalls.length > 0 && category === "call") {
    const name = node.field("method");
    if (name && table.importCalls.includes(name.text())) counts.import++;
  }
}
// classify:end
