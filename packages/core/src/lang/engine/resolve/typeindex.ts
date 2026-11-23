import type { ResolveContext } from "../../../resolve/index.js";
import type { EdgeRecord, WorkspaceRecord } from "../../../types.js";
import type { LanguagePack, TypingRules } from "../pack.js";
import { defaultImportName, importBinding } from "../parse.js";
import { dependsOn, nameKey } from "../workspace.js";
import type { FileEntry, ImportIndex } from "./imports.js";
import { Reader } from "./read.js";
import { withTree } from "./source.js";
import type { Arity, Expr, FileDecls, ImplDecl, Results, TypeDecl, TypeRef } from "./typing.js";

/**
 * A type as far as the resolver reads it: a named type, with the type arguments written after it (null for one that is
 * not known), or a sequence or map with element types.
 */
export type Ty =
  | { k: "named"; pkg: string; name: string; args?: readonly (Ty | null)[] }
  | { k: "seq"; elem: Ty | null }
  | { k: "map"; key: Ty | null; elem: Ty | null };

export type Named = Extract<Ty, { k: "named" }>;

/** What the type parameters in scope stand for: a type, or null for a parameter whose type is not known. */
export type Bindings = ReadonlyMap<string, Ty | null>;

export interface FuncInfo {
  results: Results;
  file: FileInfo;
  /** Offset of the declaration in its file; it names the symbol. */
  start: number;
  arity: Arity | null;
  tparams: string[];
  /** True for a method the type's body declares more than once: which one a call means is not known. */
  ambiguous?: true;
}

export interface TypeInfo extends TypeDecl {
  file: FileInfo;
  /** The other parts of a type that is declared in several (`types.partial`), each with its own file; empty for any other type. `bases` and `opaque` already hold those of every part. */
  parts: TypeInfo[];
  /** The interfaces blocks of members name for the type (`types.impls`), as written in the file of each block. */
  impls: { interface: TypeRef | null; file: FileInfo; line: number }[];
}

/** An extension method (`typing.extensions`): the method, the type it extends as written in its file, and how many arguments a call passes besides the receiver. */
export interface ExtInfo {
  func: FuncInfo;
  receiver: TypeRef | null;
  arity: Arity | null;
}

export interface VarInfo {
  declared: { type: TypeRef | null } | null;
  value: Expr | null;
  /** True when the value gives the variable a type only for the flow resolver. */
  flow?: true;
  file: FileInfo;
}

export interface Pkg {
  path: string;
  name: string;
  /** A package that nothing imports (its name ends as the pack's `package.separate` says). */
  separate: boolean;
  funcs: Map<string, FuncInfo>;
  /** Names a file declares as a function twice: which one a call means is not known, so none is in `funcs`. */
  redefined: Set<string>;
  types: Map<string, TypeInfo>;
  /** Names the package declares with different numbers of type parameters (`typing.type.byParameterCount`): no type of it, nor any member, is kept. */
  mixed: Set<string>;
  /** Keyed `Recv.Name` with the receiver's base type (the dotted name of the type for a method in a type body). Overloads share a key. */
  methods: Map<string, FuncInfo[]>;
  /** Extension methods by name. */
  extensions: Map<string, ExtInfo[]>;
  vars: Map<string, VarInfo>;
  /** True for a package a file's own declaration names (not one made from the folder the file is in). */
  declared: boolean;
}

/** The module a file is, for a pack whose packages are files: its dotted path below its workspace (empty for the workspace's own index file) and whether the file stands for its folder. */
export interface ModuleInfo {
  path: string;
  index: boolean;
}

/** A file of the index: where its names come from. */
export interface FileInfo {
  rel: string;
  fileId: string;
  /** The workspace that holds the file. */
  workspace: WorkspaceRecord;
  /** Set for a pack whose packages are files. */
  module: ModuleInfo | null;
  /** Local import name to import path. Imports that bind no name are left out. */
  imports: Map<string, string>;
  /** Local names that two imports of a file bind (only a pack whose packages are files reads them). */
  rebound: Set<string>;
  /** True when the file imports every name of a module (a pack whose packages are files): any name it binds may be rebound by that import. */
  starred: boolean;
  /** Types the file imports by name: local name to type. */
  named: Map<string, Named>;
  /** Packages whose types the file imports all at once. */
  demand: string[];
  /** Members the file imports by name: member name to the types that declare it. */
  statics: Map<string, Named[]>;
  /** Types whose members the file imports all at once. */
  staticDemand: Named[];
  pkg: Pkg;
}

/** What a method lookup found. `file` and `start` give the symbol. */
export interface MethodHit {
  /** `func-field`: a field holding a function; `ambiguous`: a method declared more than once. Neither is the target of an edge. */
  kind: "method" | "interface-method" | "func-field" | "ambiguous";
  file: FileInfo;
  start: number;
  results: Results;
  /** What the type parameters of the declaring type and of the method itself stand for in `results`. */
  bind?: Bindings;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The types around a type of a package, innermost first, the type itself included: each is the `outer` of the one before. */
const chainOf = (pkg: Pkg, owner: string | null | undefined): string[] => {
  const out: string[] = [];
  let cur = owner ?? null;
  while (cur !== null && out.length < 32) {
    out.push(cur);
    cur = pkg.types.get(cur)?.outer ?? null;
  }
  return out;
};

/**
 * The package index behind level 2 call resolution (spec section 7): one `Pkg` per package path over the files the
 * indexer parsed (functions with result types, types with fields, embedded types, supertypes and interface method sets,
 * methods by receiver base type or enclosing type, package-level variables), imports mapped through the workspaces, and
 * the type helpers the inference in `typed.ts` stands on. It is built from plain data; the tree of a file is gone once
 * its declarations are read.
 */
export class TypeIndex {
  readonly pkgs = new Map<string, Pkg>();
  /** Files in path order. */
  readonly files: FileInfo[] = [];
  readonly byFileId = new Map<string, FileInfo>();
  /** Every symbol id of the parsed files: an edge is emitted only to a symbol that exists. */
  readonly symbolIds = new Set<string>();
  private readonly idAt = new Map<string, Map<number, string>>();
  private readonly typing: TypingRules;
  private readonly predeclared: ReadonlySet<string>;
  private readonly builtin: ReadonlySet<string>;
  private readonly workspaces: WorkspaceRecord[];
  private readonly sep: string;
  private readonly rawImports = new Map<string, FileDecls["imports"]>();
  private readonly order = new Map<string, TypeInfo[]>();
  /** The files that stand for their folder, by the key of the package they make. */
  private readonly indexFiles = new Map<string, FileInfo[]>();
  private implementsByFile: Map<string, EdgeRecord[]> | null = null;
  private multiBase: Named[] | null = null;
  /** The blocks of members of each file, as written (`types.impls`). */
  private readonly blockDecls = new Map<string, ImplDecl[]>();
  /** The methods declared with no type body around them, with the file of each: a block of members may be in another package than its type. */
  private readonly looseMethods: { file: FileInfo; key: string; info: FuncInfo }[] = [];
  /** The blocks of members whose type is a type of the repo, by file: the type, the interface the block names and its line. */
  private readonly blocks = new Map<string, { type: Named; interface: TypeRef | null; line: number }[]>();
  /** The name of the entry file that stands for each workspace (`typing.package.entries`), by workspace id. */
  private readonly rootEntries = new Map<string, string>();

  constructor(
    private readonly pack: LanguagePack,
    ctx: ResolveContext,
    imports: ImportIndex,
    reader: Reader,
  ) {
    if (!pack.nodes.typing) throw new Error(`${pack.id}: the pack has no typing rules`);
    this.typing = pack.nodes.typing;
    this.predeclared = new Set(this.typing.type.predeclared);
    this.builtin = new Set(this.typing.type.builtin);
    this.sep = pack.nodes.import.separator;
    this.workspaces = ctx.workspaces
      .filter((w) => w.lang === pack.id)
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
    const entries = this.typing.package.entries;
    if (entries && this.typing.package.path === "file") {
      // The first of the entry names that a workspace has directly in its root folder is the file that stands for it.
      for (const entry of imports.files) {
        if (!entry.workspace) continue;
        const place = this.placeOf(entry, entry.workspace);
        const at = entries.indexOf(place.stem);
        const have = this.rootEntries.get(entry.workspace.id);
        if (place.dirs.length === 0 && at >= 0 && (have === undefined || at < entries.indexOf(have)))
          this.rootEntries.set(entry.workspace.id, place.stem);
      }
    }
    for (const entry of imports.files) {
      const starts = new Map<number, string>();
      for (const s of entry.parsed.symbols) {
        this.symbolIds.add(s.id);
        const r = entry.parsed.bodies.get(s.id);
        if (r && !starts.has(r.start)) starts.set(r.start, s.id);
      }
      this.idAt.set(entry.fileId, starts);
      if (!entry.workspace) continue;
      const decls = withTree(pack, ctx.root, entry.rel, (root) => reader.declarations(root));
      if (!decls) continue;
      const rule = this.typing.package;
      const mod = rule.path === "file" ? this.moduleOf(entry, entry.workspace) : null;
      const packageName = mod ? (mod.path.split(this.sep).pop() ?? "") : decls.packageName;
      const test = rule.separate !== undefined && packageName.endsWith(rule.separate);
      const path = mod ? this.moduleKey(entry.workspace, mod.path) : this.packagePath(entry, decls);
      const key = test ? `${path} [test]` : path;
      let pkg = this.pkgs.get(key);
      if (!pkg) {
        pkg = {
          path: key,
          name: packageName,
          separate: test,
          funcs: new Map(),
          redefined: new Set(),
          types: new Map(),
          mixed: new Set(),
          methods: new Map(),
          extensions: new Map(),
          vars: new Map(),
          declared: !mod && rule.path === "clause" && decls.packaged,
        };
        this.pkgs.set(key, pkg);
      }
      const file: FileInfo = {
        rel: entry.rel,
        fileId: entry.fileId,
        workspace: entry.workspace,
        module: mod,
        imports: new Map(),
        rebound: new Set(),
        starred: false,
        named: new Map(),
        demand: [],
        statics: new Map(),
        staticDemand: [],
        pkg,
      };
      this.files.push(file);
      this.byFileId.set(entry.fileId, file);
      this.rawImports.set(entry.fileId, decls.imports);
      this.blockDecls.set(entry.fileId, decls.impls);
      if (mod?.index) this.indexFiles.set(key, [...(this.indexFiles.get(key) ?? []), file]);
      for (const f of this.settled(decls.funcs, (x) => x.name)) {
        const earlier = pkg.funcs.get(f.name);
        // A function declared twice in one file (a redefinition, an overload stub) has no one meaning; a second file
        // of the package that declares the name (a build-constrained file, a stub) does not take the first one's.
        if (pkg.redefined.has(f.name) || earlier?.file === file) {
          pkg.funcs.delete(f.name);
          pkg.redefined.add(f.name);
        } else if (!earlier)
          pkg.funcs.set(f.name, {
            results: f.results,
            file,
            start: f.start,
            arity: f.arity,
            tparams: f.tparams,
          });
      }
      for (const t of decls.types) {
        const earlier = pkg.types.get(t.name);
        const info: TypeInfo = { ...t, file, parts: [], impls: [] };
        if (earlier) {
          // The same name with another number of type parameters is another type, which no use site is matched to.
          if (this.typing.type.byParameterCount && earlier.params.length !== t.params.length) {
            pkg.mixed.add(t.name);
            continue;
          }
          // A part of a type another file declared too is read in its own file; any other repeated name is left out.
          if (!earlier.partial || !t.partial) continue;
          earlier.parts.push(info);
          earlier.bases += t.bases;
          earlier.opaque ||= t.opaque;
        } else pkg.types.set(t.name, info);
        const list = this.order.get(entry.fileId) ?? [];
        list.push(info);
        this.order.set(entry.fileId, list);
      }
      const methods = this.settled(decls.methods, (x) => x.key);
      // Without overloads told apart by their arguments, a method declared twice in a file has no one meaning.
      const seenKeys = new Set<string>();
      const repeated = new Set<string>();
      for (const m of methods) {
        if (seenKeys.has(m.key)) repeated.add(m.key);
        seenKeys.add(m.key);
      }
      for (const m of methods) {
        // A method in a type body belongs to the type the index took (any part of it); one of a type another file declared first is left out.
        const owner = m.owner === null ? undefined : pkg.types.get(m.owner);
        if (m.owner !== null && !(owner && [owner, ...owner.parts].some((p) => p.file === file))) continue;
        const info: FuncInfo = {
          results: m.results,
          file,
          start: m.start,
          arity: m.arity,
          tparams: m.tparams,
          ...(repeated.has(m.key) && !this.typing.arity ? { ambiguous: true as const } : {}),
        };
        this.addMethod(pkg, m.key, info);
        if (m.owner === null) this.looseMethods.push({ file, key: m.key, info });
        if (m.extension) {
          const name = m.key.slice(m.key.lastIndexOf(".") + 1);
          // The receiver is the first parameter, not an argument.
          const arity = m.arity && { min: Math.max(0, m.arity.min - 1), max: m.arity.max - 1 };
          pkg.extensions.set(name, [
            ...(pkg.extensions.get(name) ?? []),
            { func: info, receiver: m.extension.type, arity },
          ]);
        }
      }
      for (const v of decls.vars) {
        const earlier = pkg.vars.get(v.name);
        // A variable assigned again, with no declared type, has no one value to read its type from.
        if (earlier) {
          if (earlier.flow) earlier.value = null;
          continue;
        }
        pkg.vars.set(v.name, {
          declared: v.declared,
          value: v.value,
          ...(v.flow ? { flow: true as const } : {}),
          file,
        });
      }
    }
    for (const pkg of this.pkgs.values()) {
      for (const name of pkg.mixed) {
        const inside = (key: string): boolean => key === name || key.startsWith(`${name}.`);
        for (const key of [...pkg.types.keys()]) if (inside(key)) pkg.types.delete(key);
        for (const key of [...pkg.methods.keys()]) if (key.startsWith(`${name}.`)) pkg.methods.delete(key);
      }
    }
    for (const f of this.files) this.mapImports(f);
    const hops = this.typing.package.reexports;
    if (hops) this.followReexports(hops);
    this.placeBlocks();
  }

  /** Adds a method to the package under its key; a second declaration of the key is kept only where overloads are told apart. */
  private addMethod(pkg: Pkg, key: string, info: FuncInfo): void {
    const list = pkg.methods.get(key);
    if (!list) pkg.methods.set(key, [info]);
    else if (this.typing.arity && !list.includes(info)) list.push(info);
  }

  /**
   * Places what blocks of members (`types.impls`) declare where the type is: a method declared with no type body around
   * it whose type is a type of another package is also a method of that type there, and the interface a block names
   * is a supertype of its type (an `implements` edge from the type to it, found wherever the block is).
   */
  private placeBlocks(): void {
    for (const { file, key, info } of this.pack.nodes.types.impls ? this.looseMethods : []) {
      const dot = key.lastIndexOf(".");
      const type = this.typeNamed(key.slice(0, dot), file, null);
      const target = type && type.pkg !== file.pkg.path ? this.pkgs.get(type.pkg) : undefined;
      if (type && target) this.addMethod(target, `${type.name}.${key.slice(dot + 1)}`, info);
    }
    for (const file of this.files) {
      for (const b of this.blockDecls.get(file.fileId) ?? []) {
        const type = this.resolveType(b.type, file);
        const info = type?.k === "named" ? this.typeInfo(type) : undefined;
        if (type?.k !== "named" || !info) continue;
        if (b.interface) info.impls.push({ interface: b.interface, file, line: b.line });
        const list = this.blocks.get(file.fileId) ?? [];
        list.push({ type, interface: b.interface, line: b.line });
        this.blocks.set(file.fileId, list);
      }
    }
    this.blockDecls.clear();
  }

  /** The blocks of members of a file whose type is a type of the repo (`types.impls`): the type, the interface the block names, its line. */
  blocksOf(fileId: string): { type: Named; interface: TypeRef | null; line: number }[] {
    return this.blocks.get(fileId) ?? [];
  }

  /**
   * The declarations of one file with the stubs set aside: of a name declared several times, those the pack marks as
   * overload stubs go when exactly one is not marked (the declaration they stand for). Any other repetition stays.
   */
  private settled<T extends { overload?: true }>(list: T[], key: (t: T) => string): T[] {
    if (!this.typing.decorators) return list;
    const groups = new Map<string, T[]>();
    for (const x of list) groups.set(key(x), [...(groups.get(key(x)) ?? []), x]);
    return list.filter((x) => {
      const group = groups.get(key(x)) ?? [];
      return !x.overload || group.filter((y) => !y.overload).length !== 1;
    });
  }

  /**
   * Replaces each name a file imports from a package's index file by the name that index file binds it to with an import
   * of its own, through at most `hops` index files. A name the index file declares, binds twice or binds by a star import
   * is not followed.
   */
  private followReexports(hops: number): void {
    for (const f of this.files) {
      for (const [local, n] of [...f.named]) {
        const r = this.reexport(n, hops);
        if ("module" in r) {
          f.named.delete(local);
          f.imports.set(local, r.module);
        } else if (r.named !== n) f.named.set(local, r.named);
      }
    }
  }

  /** What a name imported from the module `n.pkg` is bound to, following the imports of its index file. */
  private reexport(n: Named, hops: number): { named: Named } | { module: string } {
    const module = this.pkgs.get(n.pkg);
    const declared =
      module?.funcs.has(n.name) ||
      module?.redefined.has(n.name) ||
      module?.types.has(n.name) ||
      module?.vars.has(n.name);
    if (!module || declared || hops <= 0) return { named: n };
    for (const file of this.indexFiles.get(n.pkg) ?? []) {
      if (file.starred || file.rebound.has(n.name)) continue;
      const next = file.named.get(n.name);
      if (next) return this.reexport(next, hops - 1);
      const target = file.imports.get(n.name);
      if (target) return { module: target };
    }
    return { named: n };
  }

  /** The symbol id of the declaration at an offset of a file; null when the file has no symbol there. */
  symbolAt(fileId: string, start: number): string | null {
    return this.idAt.get(fileId)?.get(start) ?? null;
  }

  /** The packages a package is nested in (`typing.package.nested`), innermost first: those its name starts with. Empty for a package no declaration names. */
  private enclosingPkgs(pkg: Pkg): Pkg[] {
    if (!this.typing.package.nested || !pkg.declared) return [];
    const out: Pkg[] = [];
    for (let p = pkg.path; p.includes(this.sep); ) {
      p = p.slice(0, p.lastIndexOf(this.sep));
      const outer = this.pkgs.get(p);
      if (outer?.declared) out.push(outer);
    }
    return out;
  }

  /** The supertypes a type declares, each with the file it is written in: a type of several parts has those of every part. */
  supersOf(
    ti: TypeInfo,
  ): { type: TypeRef | null; edge: TypeInfo["supers"][number]["edge"]; line: number; file: FileInfo }[] {
    return [
      ...[ti, ...ti.parts].flatMap((p) => p.supers.map((s) => ({ ...s, file: p.file }))),
      ...ti.impls.map((i) => ({
        type: i.interface,
        edge: "implements" as const,
        line: i.line,
        file: i.file,
      })),
    ];
  }

  /** The types a file declared that the index took (a name an earlier file of the package declared first is not one). */
  typesOf(fileId: string): TypeInfo[] {
    return (this.order.get(fileId) ?? []).filter((t) => t.file.fileId === fileId);
  }

  /** Package path of a file: the name its package declaration gives, or the workspace name and then the folder below the workspace's own. */
  private packagePath(entry: FileEntry, decls: FileDecls): string {
    if (this.typing.package.path === "clause" && decls.packaged) return decls.packageName;
    const w = entry.workspace as NonNullable<FileEntry["workspace"]>;
    const sep = this.pack.nodes.import.separator;
    const sub = w.dir === "." ? entry.dir : entry.dir === w.dir ? "." : entry.dir.slice(w.dir.length + 1);
    return sub === "." ? w.name : `${w.name}${sep}${sub.split("/").join(sep)}`;
  }

  /**
   * The module a file is, for a pack whose packages are files: its path below its workspace, without a folder the pack
   * names as the holder of packages (`roots`) and without the extension, and the file that stands for its folder is that
   * folder.
   */
  private moduleOf(entry: FileEntry, w: WorkspaceRecord): ModuleInfo {
    const { dirs, stem } = this.placeOf(entry, w);
    // The entry file of the workspace stands for the workspace itself.
    const index =
      stem === this.typing.package.index || (dirs.length === 0 && this.rootEntries.get(w.id) === stem);
    return { path: (index ? dirs : [...dirs, stem]).join(this.sep), index };
  }

  /** Where a file is below its workspace: the folders (without the folder the pack names as the holder of packages) and the file name without its extension. */
  private placeOf(entry: FileEntry, w: WorkspaceRecord): { dirs: string[]; stem: string } {
    const below = w.dir === "." ? entry.rel : entry.rel.slice(w.dir.length + 1);
    const parts = below.split("/");
    if (parts.length > 1 && this.typing.package.roots?.includes(parts[0] ?? "")) parts.shift();
    const file = parts.pop() ?? "";
    const ext = this.pack.extensions.find((x) => file.endsWith(x));
    return { dirs: parts, stem: ext ? file.slice(0, file.length - ext.length) : file };
  }

  /** The key of a module of a workspace in `pkgs`: the workspace name, then the module's path. */
  private moduleKey(w: WorkspaceRecord, path: string): string {
    return path === "" ? w.name : `${w.name}${this.sep}${path}`;
  }

  /**
   * The keys a module path written in `from` may name, best first. A relative path is read from the package of the file
   * (each extra leading character goes one package up) and stays in its workspace; any other is looked for in the
   * workspace of the file, then in each workspace it depends on.
   */
  private moduleKeys(from: FileInfo, specifier: string): string[] {
    const words = this.typing.package.paths;
    if (words) return this.pathKeys(from, specifier.split(this.sep), words);
    const relative = this.pack.nodes.import.modules?.relative ?? "";
    if (relative !== "" && specifier.startsWith(relative)) {
      let dots = 0;
      while (specifier.startsWith(relative, dots)) dots += relative.length;
      const levels = dots / relative.length;
      const here = from.module?.path === "" ? [] : (from.module?.path.split(this.sep) ?? []);
      const base = from.module?.index ? here : here.slice(0, -1);
      if (levels - 1 > base.length) return [];
      const rest = specifier.slice(dots);
      const up = base.slice(0, base.length - (levels - 1));
      const parts = [...up, ...(rest === "" ? [] : rest.split(this.sep))];
      return [this.moduleKey(from.workspace, parts.join(this.sep))];
    }
    const deps = this.workspaces.filter(
      (w) => w.id !== from.workspace.id && dependsOn(this.pack, from.workspace, w),
    );
    return [from.workspace, ...deps].map((w) => this.moduleKey(w, specifier));
  }

  /**
   * The keys a module path (its segments) written in `from` may name, best first, for a pack whose paths start with a
   * word (`typing.package.paths`): the module of the workspace root, of the file or the one above it; else a workspace
   * the segment names (the file's own or one it depends on), then a module inside the module of the file.
   */
  private pathKeys(
    from: FileInfo,
    segments: readonly string[],
    words: NonNullable<TypingRules["package"]["paths"]>,
  ): string[] {
    const here = from.module?.path === "" ? [] : (from.module?.path.split(this.sep) ?? []);
    const [first = "", ...rest] = segments;
    const at = (w: WorkspaceRecord, path: readonly string[]): string =>
      this.moduleKey(w, path.join(this.sep));
    if (first === words.root) return [at(from.workspace, rest)];
    if (first === words.self) return [at(from.workspace, [...here, ...rest])];
    if (first === words.parent) {
      let up = here;
      let tail = segments;
      while (tail[0] === words.parent) {
        if (up.length === 0) return [];
        up = up.slice(0, -1);
        tail = tail.slice(1);
      }
      return [at(from.workspace, [...up, ...tail])];
    }
    const named = [
      from.workspace,
      ...this.workspaces.filter((w) => w.id !== from.workspace.id && dependsOn(this.pack, from.workspace, w)),
    ]
      .filter((w) => nameKey(this.pack, w.name) === nameKey(this.pack, first))
      .map((w) => at(w, rest));
    return [...named, at(from.workspace, [...here, ...segments])];
  }

  /** The module an import of `name` from the module `specifier` names, when the repo has one. */
  private submoduleKey(from: FileInfo, specifier: string, name: string): string | undefined {
    const relative = this.pack.nodes.import.modules?.relative ?? "";
    const whole =
      specifier === ""
        ? name
        : relative !== "" && specifier.split(relative).every((s) => s === "")
          ? `${specifier}${name}`
          : `${specifier}${this.sep}${name}`;
    return this.moduleKeys(from, whole).find((k) => this.pkgs.has(k));
  }

  /** Reads the imports of a file for a pack whose packages are files: modules, names of a module, and names of any module. */
  private mapModuleImports(f: FileInfo): void {
    const first = (keys: string[]): string | undefined => keys.find((k) => this.pkgs.has(k)) ?? keys[0];
    const bind = (local: string): void => {
      if (f.named.has(local) || f.imports.has(local)) f.rebound.add(local);
    };
    for (const i of this.rawImports.get(f.fileId) ?? []) {
      if (i.name === null) {
        const b = importBinding(this.pack, i);
        const key = first(this.moduleKeys(f, b.path));
        if (key) {
          bind(b.local);
          f.imports.set(b.local, key);
        }
      } else if (i.name === "*") {
        f.starred = true;
        const key = this.moduleKeys(f, i.specifier).find((k) => this.pkgs.has(k));
        if (key) f.demand.push(key);
      } else {
        const local = i.alias ?? i.name;
        const sub = this.submoduleKey(f, i.specifier, i.name);
        if (sub) {
          bind(local);
          f.imports.set(local, sub);
        } else if (i.specifier !== "") {
          const key = first(this.moduleKeys(f, i.specifier));
          if (key) {
            bind(local);
            f.named.set(local, { k: "named", pkg: key, name: i.name });
          }
        }
      }
    }
    this.rawImports.delete(f.fileId);
  }

  /** Local name of an import without an alias: the package's own name for a package of the repo, the path's last piece otherwise. */
  private localName(path: string): string {
    return this.pkgs.get(path)?.name ?? defaultImportName(this.pack, path);
  }

  /** The name a name of a module is bound to there, when the module re-exports it (`typing.package.reexports`); the name itself otherwise. */
  private followed(n: Named): Named {
    const hops = this.typing.package.reexports;
    if (!hops) return n;
    const r = this.reexport(n, hops);
    return "named" in r ? { k: "named", pkg: r.named.pkg, name: r.named.name } : n;
  }

  /** The module a path of names written in `file` names (`typing.package.paths`); null when it names none of the repo. */
  private moduleAt(file: FileInfo, segments: readonly string[]): string | null {
    if (!this.typing.package.paths) return null;
    const [first = "", ...rest] = segments;
    // A name an import or a module declaration bound is the module it was bound to.
    const bound = file.imports.get(first);
    const keys =
      bound === undefined
        ? this.moduleKeys(file, segments.join(this.sep))
        : [rest.length === 0 ? bound : `${bound}${this.sep}${rest.join(this.sep)}`];
    return keys.find((k) => this.pkgs.has(k)) ?? null;
  }

  /**
   * What the prefix of a called path names (`typing.callee.paths`): a module of the repo, or a type of it (the last
   * segment, found in the module the segments before it name, in the file's own scope when it is the only one, or as the
   * type `typing.type.self` stands for, which is `owner`). Null for anything else.
   */
  resolvePrefix(
    file: FileInfo,
    prefix: readonly string[],
    owner: Named | null,
  ): { module: string } | { type: Named } | null {
    if (prefix.length === 0) return null;
    const whole = this.moduleAt(file, prefix);
    if (whole !== null) return { module: whole };
    const last = prefix[prefix.length - 1] ?? "";
    if (prefix.length === 1) {
      if (last === this.typing.type.self) return owner ? { type: owner } : null;
      const t = this.typeNamed(last, file, null);
      return t ? { type: t } : null;
    }
    const module = this.moduleAt(file, prefix.slice(0, -1));
    if (module === null) return null;
    const t = this.followed({ k: "named", pkg: module, name: last });
    return this.typeInfo(t) ? { type: t } : null;
  }

  /** The function a module declares (or re-exports) under a name. */
  functionIn(module: string, name: string): FuncInfo | undefined {
    const at = this.followed({ k: "named", pkg: module, name });
    return this.pkgs.get(at.pkg)?.funcs.get(at.name);
  }

  /** The type a path names (`a.b.Outer.Inner`): the longest prefix that is a package of the repo, then the types below it. */
  private typeAt(path: string): Named {
    const sep = this.pack.nodes.import.separator;
    const parts = path.split(sep);
    for (let k = parts.length - 1; k >= 1; k--) {
      const pkg = parts.slice(0, k).join(sep);
      if (this.pkgs.has(pkg)) return { k: "named", pkg, name: parts.slice(k).join(".") };
    }
    return {
      k: "named",
      pkg: parts.slice(0, -1).join(sep),
      name: parts[parts.length - 1] ?? path,
    };
  }

  private mapImports(f: FileInfo): void {
    if (f.module) {
      this.mapModuleImports(f);
      return;
    }
    for (const i of this.rawImports.get(f.fileId) ?? []) {
      if (i.name === null) {
        if (i.specifier === "" || (i.alias !== null && this.typing.unboundAliases.includes(i.alias)))
          continue;
        f.imports.set(i.alias ?? this.localName(i.specifier), i.specifier);
      } else if (i.name === "*") {
        if (i.static) f.staticDemand.push(this.typeAt(i.specifier));
        else f.demand.push(i.specifier);
      } else if (i.static) {
        const list = f.statics.get(i.alias ?? i.name) ?? [];
        list.push(this.typeAt(i.specifier));
        f.statics.set(i.alias ?? i.name, list);
      } else {
        const sep = this.pack.nodes.import.separator;
        f.named.set(
          i.alias ?? i.name,
          this.typeAt(i.specifier === "" ? i.name : `${i.specifier}${sep}${i.name}`),
        );
      }
    }
    this.rawImports.delete(f.fileId);
  }

  typeInfo(r: Named): TypeInfo | undefined {
    return this.pkgs.get(r.pkg)?.types.get(r.name);
  }

  /**
   * Resolves a type as written in `file` to a named type, sequence or map; null for anything else. A name in `bound` is a
   * type parameter and stands for what it is bound to (nothing is known of an unbound one).
   */
  resolveType(t: TypeRef | null, file: FileInfo, bound?: Bindings): Ty | null {
    if (!t) return null;
    switch (t.k) {
      case "name": {
        // A type parameter of the function around hides any type of that name.
        if (t.param) return bound?.get(t.name) ?? null;
        if (!t.args && bound?.has(t.name)) return bound.get(t.name) ?? null;
        const base = this.resolveName(t, file);
        if (!t.args || base?.k !== "named") return base;
        return { ...base, args: t.args.map((a) => this.resolveType(a, file, bound)) };
      }
      case "qual": {
        const byPath = this.typing.type.qualified?.packages && this.pkgs.get(t.qualifier)?.declared;
        const path =
          file.imports.get(t.qualifier) ??
          (byPath ? t.qualifier : undefined) ??
          this.moduleAt(file, t.qualifier.split(this.sep)) ??
          undefined;
        if (!path) return null;
        const at: Named = { k: "named", pkg: path, name: t.name };
        return this.typing.package.paths ? this.followed(at) : at;
      }
      case "seq":
        return { k: "seq", elem: this.resolveType(t.elem, file, bound) };
      case "map":
        return {
          k: "map",
          key: this.resolveType(t.key, file, bound),
          elem: this.resolveType(t.elem, file, bound),
        };
    }
  }

  /** The type a plain name written in `file` stands for, without its type arguments. */
  private resolveName(t: Extract<TypeRef, { k: "name" }>, file: FileInfo): Named | null {
    if (this.builtin.has(t.name)) return { k: "named", pkg: "", name: t.name };
    const around = chainOf(file.pkg, t.owner);
    // A type parameter of an enclosing type is not a type of the repo; nothing is known of it.
    for (const o of around) if (file.pkg.types.get(o)?.params.includes(t.name)) return null;
    // A type of the enclosing types first, then a name the file imports (it hides a type of the package), the package,
    // and the packages the file imports whole.
    for (const o of around) {
      const nested = `${o}.${t.name}`;
      if (file.pkg.types.has(nested)) return { k: "named", pkg: file.pkg.path, name: nested };
    }
    const imported = file.named.get(t.name);
    if (imported) return imported;
    // A name the package declares with several numbers of type parameters is no type, and hides the same name further out.
    if (file.pkg.mixed.has(t.name)) return null;
    if (file.pkg.types.has(t.name)) return { k: "named", pkg: file.pkg.path, name: t.name };
    for (const p of this.enclosingPkgs(file.pkg)) {
      if (p.mixed.has(t.name)) return null;
      if (p.types.has(t.name)) return { k: "named", pkg: p.path, name: t.name };
    }
    for (const p of file.demand) {
      if (this.pkgs.get(p)?.mixed.has(t.name)) return null;
      if (this.pkgs.get(p)?.types.has(t.name)) return { k: "named", pkg: p, name: t.name };
    }
    // A type of a library the pack knows, brought in by an import of its whole package.
    for (const e of this.typing.type.library ?? [])
      if (e.types.includes(t.name) && file.demand.includes(e.package))
        return { k: "named", pkg: e.package, name: t.name };
    if (this.predeclared.has(t.name)) return null;
    return { k: "named", pkg: file.pkg.path, name: t.name };
  }

  /** What the type parameters of a type stand for when it is written with the arguments of `r` (none, for a raw type). */
  bindings(ti: TypeInfo, r: Named): Bindings {
    return new Map(ti.params.map((p, i) => [p, r.args?.[i] ?? null]));
  }

  /**
   * The type a method of a type outside the repo that the pack knows returns (`List<T>.get`): the type argument the
   * pack names. Undefined when the type is not a known library type or the method is not one of its accessors; null when
   * it is but the argument is not known.
   */
  libraryResult(r: Named, method: string): Ty | null | undefined {
    if (this.typeInfo(r)) return undefined;
    const entry = (this.typing.type.library ?? []).find(
      (e) => e.package === r.pkg && e.types.includes(r.name),
    );
    const at = entry && Object.hasOwn(entry.returns, method) ? entry.returns[method] : undefined;
    return at === undefined ? undefined : (r.args?.[at] ?? null);
  }

  /** The type a name written in `file` inside the type `owner` names, when it is a type of the repo. */
  typeNamed(name: string, file: FileInfo, owner: string | null): Named | null {
    const t = this.resolveType({ k: "name", name, owner }, file);
    return t?.k === "named" && this.typeInfo(t) ? t : null;
  }

  /** The types around a type, innermost first, the type itself included. */
  chain(owner: Named): Named[] {
    const pkg = this.pkgs.get(owner.pkg);
    return pkg ? chainOf(pkg, owner.name).map((name) => ({ k: "named", pkg: owner.pkg, name })) : [owner];
  }

  /** True when the type, or a type in its chain of supertypes, is not a type of the repo: what it inherits is not known. */
  hasUnknownSupers(r: Named, depth = 0): boolean {
    const c = this.canon(r);
    const ti = c?.k === "named" ? this.typeInfo(c) : undefined;
    if (!ti || depth > 8) return true;
    return this.supersOf(ti).some((s) => {
      const sr = this.resolveType(s.type, s.file);
      return sr?.k !== "named" || this.hasUnknownSupers(sr, depth + 1);
    });
  }

  /** Follows aliases (`type A = B`) to the target. */
  canon(t: Ty | null, depth = 0): Ty | null {
    if (!t || depth > 8 || t.k !== "named") return t;
    const ti = this.typeInfo(t);
    if (ti?.kind === "alias") return this.canon(this.resolveType(ti.target, ti.file), depth + 1);
    return t;
  }

  /** A named type whose declared underlying type is a sequence or map reads as that composite. */
  shape(t: Ty | null): Ty | null {
    const c = this.canon(t);
    if (!c) return null;
    if (c.k !== "named") return c;
    const ti = this.typeInfo(c);
    if (ti?.kind === "other") {
      const u = this.resolveType(ti.target, ti.file);
      if (u && u.k !== "named") return u;
    }
    return c;
  }

  /** The type of a field of a named type: its own, one an embedded type brings, or one a supertype declares. */
  fieldType(r: Named, name: string, depth = 0): Ty | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 4) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "class") return null;
    const bound = this.bindings(ti, c);
    for (const p of [ti, ...ti.parts])
      if (p.fields.has(name)) return this.resolveType(p.fields.get(name) ?? null, p.file, bound);
    for (const e of ti.embedded) {
      const er = this.resolveType(e.type, ti.file, bound);
      if (er?.k !== "named") continue;
      if (er.name === name) return er;
      const sub = this.fieldType(er, name, depth + 1);
      if (sub) return sub;
    }
    for (const s of this.supersOf(ti)) {
      const sr = this.resolveType(s.type, s.file, bound);
      const sub = sr?.k === "named" ? this.fieldType(sr, name, depth + 1) : null;
      if (sub) return sub;
    }
    return null;
  }

  /** The candidates of a list of overloads that take `args` arguments (all of them when the count or an arity is unknown). */
  private fitting(list: FuncInfo[] | undefined, args: number | null): FuncInfo[] {
    return (list ?? []).filter(
      (f) => args === null || f.arity === null || (args >= f.arity.min && args <= f.arity.max),
    );
  }

  /**
   * Method `m` of a named type with `args` arguments: declared on it, promoted through embedding, a method of an
   * interface, or inherited from a supertype (`inherit`). The hits are the overloads that fit, from the nearest type
   * that has any.
   */
  lookupMethods(
    r: Named,
    m: string,
    args: number | null,
    inherit = true,
    depth = 0,
    viaClass = false,
  ): MethodHit[] {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return [];
    const pkg = this.pkgs.get(c.pkg);
    if (!pkg) return [];
    const ti = pkg.types.get(c.name);
    // A type with no declaration in the repo has methods the repo does not show, which blocks of members only add to.
    if (!ti && this.pack.nodes.types.impls) return [];
    const bound = ti ? this.bindings(ti, c) : undefined;
    const own = this.fitting(pkg.methods.get(`${c.name}.${m}`), args);
    const unsure = own.find((f) => f.ambiguous);
    if (unsure) return [{ kind: "ambiguous", file: unsure.file, start: -1, results: [] }];
    if (own.length > 0)
      return own.map((f) => ({
        kind: "method",
        file: f.file,
        start: f.start,
        results: f.results,
        // The method's own type parameters hide those of the type, and nothing is inferred for them.
        bind: new Map([...(bound ?? []), ...f.tparams.map((p): [string, null] => [p, null])]),
      }));
    if (!inherit) return [];
    if (!ti) return [];
    if (ti.kind === "interface") {
      // A direct call is the interface's own method; one promoted through a class names the declaring interface.
      const hit = this.interfaceMethod(c, m, 0);
      if (hit) return [{ ...hit, kind: viaClass ? "method" : "interface-method" }];
    }
    if (ti.kind === "class") {
      if (this.typing.members.callable && ti.fields.has(m))
        return [{ kind: "func-field", file: ti.file, start: -1, results: [] }];
      for (const e of ti.embedded) {
        const er = this.resolveType(e.type, ti.file, bound);
        const sub = er?.k === "named" ? this.lookupMethods(er, m, args, true, depth + 1, true) : [];
        if (sub.length > 0) return sub;
      }
    }
    for (const s of this.supersOf(ti)) {
      const sr = this.resolveType(s.type, s.file, bound);
      const sub = sr?.k === "named" ? this.lookupMethods(sr, m, args, true, depth + 1, true) : [];
      if (sub.length > 0) return sub;
    }
    return [];
  }

  /** True when `r` is `target` or has it among its supertypes in the repo (through at most eight levels). */
  private isSubtype(r: Named, target: Named, depth = 0): boolean {
    const c = this.canon(r);
    if (c?.k !== "named" || depth > 8) return false;
    if (c.pkg === target.pkg && c.name === target.name) return true;
    const ti = this.typeInfo(c);
    if (!ti) return false;
    return this.supersOf(ti).some((s) => {
      const sr = this.resolveType(s.type, s.file);
      return sr?.k === "named" && this.isSubtype(sr, target, depth + 1);
    });
  }

  /**
   * The extension methods (`typing.extensions`) named `m` that a call with `args` arguments on a value of type `r`, written
   * in `file`, may mean: those of the packages the file sees (its own, those it is nested in, those it imports whole) whose
   * first parameter has the type `r` or one of its supertypes in the repo. When a fitting one has a first parameter that
   * is not read (a type parameter, a type with type arguments), which of them the call means is not known: none.
   */
  extensionHits(r: Named, file: FileInfo, m: string, args: number | null): MethodHit[] {
    const seen = new Set<string>();
    const hits: MethodHit[] = [];
    const visible = [
      file.pkg,
      ...this.enclosingPkgs(file.pkg),
      ...file.demand.flatMap((p) => this.pkgs.get(p) ?? []),
    ];
    for (const pkg of visible) {
      if (seen.has(pkg.path)) continue;
      seen.add(pkg.path);
      for (const e of pkg.extensions.get(m) ?? []) {
        if (args !== null && e.arity && (args < e.arity.min || args > e.arity.max)) continue;
        const recv = this.canon(this.resolveType(e.receiver, e.func.file));
        if (recv?.k !== "named" || recv.args) return [];
        if (!this.isSubtype(r, recv)) continue;
        hits.push({
          kind: "method",
          file: e.func.file,
          start: e.func.start,
          results: e.func.results,
          bind: new Map(e.func.tparams.map((p): [string, null] => [p, null])),
        });
      }
    }
    return hits;
  }

  /**
   * Method `m` of a class, certain: the one the class declares, else the one its only base declares or inherits the same
   * way. Null when a class on the way lists several bases or one that is not a class of the repo, or declares `m` more
   * than once: which method a call runs is then not known (the order several bases are searched in is not read).
   */
  soleMethod(r: Ty | null, m: string, depth = 0): FuncInfo | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 8) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "class") return null;
    const own = this.pkgs.get(c.pkg)?.methods.get(`${c.name}.${m}`);
    const [only] = own ?? [];
    if (only) return own?.length === 1 && !only.ambiguous ? only : null;
    // A class created some other way may run a method of its own that its declaration does not show.
    if (ti.opaque) return null;
    const supers = this.supersOf(ti);
    const base = supers[0];
    if (ti.bases !== 1 || supers.length !== 1 || !base) return null;
    return this.soleMethod(this.resolveType(base.type, base.file), m, depth + 1);
  }

  /**
   * True when a type of the repo that lists several bases has `r` among its ancestors: which method the base of `r` means
   * then depends on the class of the value, whose bases are searched in an order that is not read.
   */
  hasMultiBaseDescendant(r: Named): boolean {
    if (!this.multiBase) {
      const found: Named[] = [];
      for (const p of this.pkgs.values())
        for (const [name, ti] of p.types) if (ti.bases > 1) found.push({ k: "named", pkg: p.path, name });
      this.multiBase = found;
    }
    return this.multiBase.some((t) => this.descendsFrom(t, r, new Set()));
  }

  private descendsFrom(t: Named, target: Named, seen: Set<string>): boolean {
    const key = `${t.pkg}\0${t.name}`;
    const ti = this.typeInfo(t);
    if (!ti || seen.has(key)) return false;
    seen.add(key);
    return this.supersOf(ti).some((s) => {
      const sr = this.canon(this.resolveType(s.type, s.file));
      if (sr?.k !== "named") return false;
      return (sr.pkg === target.pkg && sr.name === target.name) || this.descendsFrom(sr, target, seen);
    });
  }

  /**
   * The method a call of a type runs (`typing.construction`): the initializer the type declares, else the one of its
   * nearest base. Null when the type, or any type of the repo among its ancestors, is created some other way (it has a
   * decorator or a keyword option, declares a method that creates the value, or has a base the pack lists as special),
   * or when no initializer is found along bases that are each the only one.
   */
  initializer(r: Named): FuncInfo | null {
    const rule = this.typing.construction;
    if (!rule || !this.createdByInitializer(r, rule, new Set())) return null;
    return this.soleMethod(r, rule.initializer);
  }

  private createdByInitializer(
    r: Named,
    rule: NonNullable<TypingRules["construction"]>,
    seen: Set<string>,
  ): boolean {
    const c = this.canon(r);
    if (c?.k !== "named") return true;
    const key = `${c.pkg}\0${c.name}`;
    if (seen.has(key)) return true;
    seen.add(key);
    const ti = this.typeInfo(c);
    // A type outside the repo is judged by the way a type of the repo names it as a base.
    if (!ti) return true;
    const pkg = this.pkgs.get(c.pkg);
    if (ti.kind !== "class" || ti.opaque || rule.creators.some((n) => pkg?.methods.has(`${c.name}.${n}`)))
      return false;
    for (const s of this.supersOf(ti)) {
      if ((s.type?.k === "name" || s.type?.k === "qual") && rule.special.includes(s.type.name)) return false;
      const base = this.canon(this.resolveType(s.type, s.file));
      if (base?.k === "named" && !this.createdByInitializer(base, rule, seen)) return false;
    }
    return true;
  }

  /** Interface method lookup; the hit names the interface that declares the method (embedded ones included). */
  interfaceMethod(r: Named, m: string, depth: number): MethodHit | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "interface") return null;
    const own = ti.methods.get(m);
    if (own) return { kind: "interface-method", file: ti.file, start: own.start, results: own.results };
    for (const e of ti.embeds) {
      const er = this.resolveType(e, ti.file);
      const hit = er?.k === "named" ? this.interfaceMethod(er, m, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  }

  // --- interface satisfaction by method names -------------------------------------------------

  /** Method names of an in-repo interface, embedded interfaces included; null when one is outside the repo or open. */
  interfaceNames(r: Named, depth = 0): Set<string> | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "interface" || ti.open) return null;
    const out = new Set(ti.methods.keys());
    for (const e of ti.embeds) {
      const er = this.resolveType(e, ti.file);
      const sub = er?.k === "named" ? this.interfaceNames(er, depth + 1) : null;
      if (!sub) return null;
      for (const n of sub) out.add(n);
    }
    return out;
  }

  /** Method names of a concrete type: its own (value or pointer receiver) and those promoted through embedding. */
  methodNames(r: Named, depth = 0): Set<string> {
    const out = new Set<string>();
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return out;
    const pkg = this.pkgs.get(c.pkg);
    if (!pkg) return out;
    for (const k of pkg.methods.keys()) if (k.startsWith(`${c.name}.`)) out.add(k.slice(c.name.length + 1));
    const ti = pkg.types.get(c.name);
    if (ti?.kind === "class") {
      for (const e of ti.embedded) {
        const er = this.resolveType(e.type, ti.file);
        if (er?.k !== "named") continue;
        const sub =
          this.typeInfo(er)?.kind === "interface"
            ? (this.interfaceNames(er) ?? new Set<string>())
            : this.methodNames(er, depth + 1);
        for (const n of sub) out.add(n);
      }
    }
    return out;
  }

  /**
   * `implements` edges at low confidence, by method names alone: a named in-repo type whose method names (value or
   * pointer receiver, promoted ones included) cover the method set of an in-repo interface. Interfaces that embed one
   * from outside the repo are skipped. Grouped by the file of the implementing type.
   */
  implementers(): Map<string, EdgeRecord[]> {
    if (this.implementsByFile) return this.implementsByFile;
    const out = new Map<string, EdgeRecord[]>();
    this.implementsByFile = out;
    const pkgs = [...this.pkgs.values()].filter((p) => !p.separate).sort((a, b) => cmp(a.path, b.path));
    const types: { name: string; info: TypeInfo; names: Set<string> }[] = [];
    const byMethod = new Map<string, number[]>();
    const ifaces: { name: string; info: TypeInfo; want: string[] }[] = [];
    for (const p of pkgs) {
      for (const name of [...p.types.keys()].sort()) {
        const info = p.types.get(name);
        if (!info || info.generic || info.kind === "alias") continue;
        const ref: Named = { k: "named", pkg: p.path, name };
        if (info.kind === "interface") {
          const want = this.interfaceNames(ref);
          if (want && want.size > 0) ifaces.push({ name, info, want: [...want].sort() });
          continue;
        }
        const i = types.length;
        types.push({ name, info, names: this.methodNames(ref) });
        for (const m of types[i]?.names ?? []) {
          const list = byMethod.get(m) ?? [];
          list.push(i);
          byMethod.set(m, list);
        }
      }
    }
    for (const iface of ifaces) {
      let candidates: number[] | undefined;
      for (const m of iface.want) {
        const list = byMethod.get(m);
        if (!list) {
          candidates = [];
          break;
        }
        if (!candidates || list.length < candidates.length) candidates = list;
      }
      for (const i of candidates ?? []) {
        const t = types[i];
        if (!t || !iface.want.every((m) => t.names.has(m))) continue;
        const src = this.symbolAt(t.info.file.fileId, t.info.start);
        const dst = this.symbolAt(iface.info.file.fileId, iface.info.start);
        if (!src || !dst || src === dst) continue;
        const fileId = t.info.file.fileId;
        const list = out.get(fileId) ?? [];
        list.push({
          src,
          dst,
          kind: "implements",
          confidence: "low",
          count: 1,
          evidence: [`${t.info.file.rel}:${t.info.line}`],
          fileId,
        });
        out.set(fileId, list);
      }
    }
    return out;
  }
}
