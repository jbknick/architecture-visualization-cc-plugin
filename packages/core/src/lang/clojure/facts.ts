import type { SymbolKind } from "../../types.js";
import { type Coll, type Form, isSym, itemsOf, kwText, readForms, type Sym } from "./reader.js";

/**
 * What one Clojure file declares (spec section 7, Clojure kinds), read from its forms: the namespace of its `ns` form, the
 * names its requires bind, and its definitions. The parser and the call resolver both read a file through this, so the
 * symbols they name are the same.
 */

/** One definition of a file, in source order. */
export interface Definition {
  /** The name of the var the definition makes in its namespace (`area`, `->Circle`); empty for a `defmethod`. */
  var: string;
  /** The name of the symbol: the var, `<Protocol>.<method>` for a protocol method, `<multi>.<dispatch>` for a `defmethod`. */
  name: string;
  kind: SymbolKind;
  exported: boolean;
  signature: string;
  /** Source range of the symbol: the whole form, or the name for a record's constructor functions and a `declare`. */
  s: number;
  e: number;
  /** The top-level form the definition is in. */
  form: Coll;
  /** `def` (a form that makes a var), `method` (of a protocol), `ctor` (of a record or type), `declare`, `defmethod`. */
  role: "def" | "method" | "ctor" | "declare" | "defmethod";
}

/** The names a file's `ns` form (and its top-level `require` and `use` calls) bind. */
export interface Requires {
  /** Alias to namespace (`:as`, `:as-alias`). */
  aliases: Map<string, string>;
  /** A name brought in by `:refer` (or `:only`), to the namespace it comes from and its name there. */
  refers: Map<string, { ns: string; name: string }>;
  /** Namespaces whose every public name is brought in (`:refer :all`, `:use` without `:only`), in order. */
  all: string[];
  /** One entry per name bound, for the parsed file's imports. */
  imports: { local: string; imported: string; specifier: string; line: number }[];
}

export interface FileFacts {
  ns: string | null;
  requires: Requires;
  /** The top-level forms, through `do`, `comment` and reader conditionals. */
  tops: Coll[];
  definitions: Definition[];
  errors: string[];
  comments: { s: number; e: number }[];
}

const SIGNATURE_MAX = 200;

/** Heads whose body is walked for top-level forms. */
const TRANSPARENT = new Set(["do", "comment"]);

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string): string => (s.length > SIGNATURE_MAX ? `${s.slice(0, SIGNATURE_MAX - 1)}…` : s);

/** The head symbol of a list, or undefined. */
export const headOf = (f: Form | undefined): Sym | undefined =>
  f?.t === "list" && f.items[0]?.t === "sym" ? (f.items[0] as Sym) : undefined;

/** True when metadata marks a definition private (`^:private`, `^{:private true}`). */
function metaPrivate(meta: Form[] | undefined): boolean {
  for (const m of meta ?? []) {
    if (kwText(m) === ":private") return true;
    if (m.t === "map")
      for (let k = 0; k + 1 < m.items.length; k += 2)
        if (kwText(m.items[k]) === ":private") {
          const v = m.items[k + 1];
          return v?.t === "sym" && v.name === "true";
        }
  }
  return false;
}

/**
 * The top-level forms of a file, through `do`, `comment` and reader conditionals: a spliced one, and a branch that is a
 * vector of forms (`#?(:clj [(def a 1) (def b 2)])`), stand for the forms they hold.
 */
export function topForms(forms: readonly Form[], out: Coll[] = []): Coll[] {
  for (const f of forms) {
    if (f.t === "rcond")
      topForms(
        f.items.flatMap((x) => (x.t === "vec" ? x.items : [x])),
        out,
      );
    else if (f.t === "list") {
      const h = headOf(f);
      if (h && h.ns === undefined && TRANSPARENT.has(h.name)) topForms(f.items.slice(1), out);
      else out.push(f);
    }
  }
  return out;
}

/**
 * The name a defining form declares: a form whose head starts with `def` (any namespace), or is ClojureScript's
 * `goog-define`, and whose second item is a symbol.
 */
export function definedName(f: Coll): { head: Sym; name: Sym } | null {
  const head = headOf(f);
  if (!head || head.name === "default" || !(head.name.startsWith("def") || head.name === "goog-define"))
    return null;
  const name = f.items[1];
  if (name?.t !== "sym" || (name.ns !== undefined && head.name !== "defmethod")) return null;
  return { head, name };
}

/** The parameter vectors of a function body: the first vector after the name, or the vector of each arity list. */
function paramsText(src: string, rest: readonly Form[]): string | null {
  for (const x of rest) {
    if (x.t === "vec") return collapse(src.slice(x.s, x.e));
    if (x.t === "list" && x.items[0]?.t === "vec") {
      const arities = rest.filter((a) => a.t === "list" && a.items[0]?.t === "vec") as Coll[];
      return `(${arities.map((a) => collapse(src.slice((a.items[0] as Form).s, (a.items[0] as Form).e))).join(" ")})`;
    }
  }
  return null;
}

/** The kind of the var a defining form makes. */
function kindOf(head: string, f: Coll): SymbolKind {
  if (head === "defprotocol" || head === "definterface") return "interface";
  if (head === "defrecord" || head === "deftype") return "class";
  if (head === "def" || head === "defonce") {
    const value = f.items[f.items.length - 1];
    if (f.items.length < 3 || value === undefined) return "const";
    const vh = headOf(value);
    return (value.t === "list" && value.anon) || (vh && (vh.name === "fn" || vh.name === "fn*"))
      ? "function"
      : "const";
  }
  if (
    head === "defn" ||
    head === "defn-" ||
    head === "defmacro" ||
    head === "defmulti" ||
    head === "definline"
  )
    return "function";
  // Another defining macro: a function when it has parameters, or is a test.
  const rest = f.items.slice(2);
  const hasParams = rest.some((x) => x.t === "vec" || (x.t === "list" && x.items[0]?.t === "vec"));
  return hasParams || /(test|spec)$/.test(head) ? "function" : "const";
}

/** The definitions of the top-level forms, in source order. */
function definitionsOf(src: string, tops: readonly Coll[]): Definition[] {
  const out: Definition[] = [];
  const declared: { name: Sym; form: Coll }[] = [];
  for (const f of tops) {
    const head = headOf(f);
    if (head?.name === "declare" && head.ns === undefined) {
      for (const d of f.items.slice(1)) if (isSym(d)) declared.push({ name: d, form: f });
      continue;
    }
    const def = definedName(f);
    if (!def) continue;
    const h = def.head.name;
    if (h === "defmethod") {
      const dispatch = f.items[2];
      const label = dispatch ? collapse(src.slice(dispatch.s, dispatch.e)) : "";
      const rest = f.items.slice(3);
      out.push({
        var: "",
        name: `${def.name.name}.${label}`,
        kind: "method",
        exported: true,
        signature: clip(paramsText(src, rest) ?? ""),
        s: f.s,
        e: f.e,
        form: f,
        role: "defmethod",
      });
      continue;
    }
    const name = def.name.name;
    const exported = h !== "defn-" && !metaPrivate(def.name.meta);
    const kind = kindOf(h, f);
    const rest = f.items.slice(2);
    let signature = "";
    if (kind === "function") signature = paramsText(src, rest) ?? "";
    else if (kind === "class" && f.items[2]?.t === "vec")
      signature = collapse(src.slice(f.items[2].s, f.items[2].e));
    out.push({
      var: name,
      name,
      kind,
      exported,
      signature: clip(signature),
      s: f.s,
      e: f.e,
      form: f,
      role: "def",
    });
    if (h === "defprotocol" || h === "definterface") {
      for (const m of rest) {
        const mh = headOf(m);
        if (!mh || mh.ns !== undefined || m.t !== "list") continue;
        const sigs = m.items.filter((x) => x.t === "vec").map((x) => collapse(src.slice(x.s, x.e)));
        out.push({
          var: mh.name,
          name: `${name}.${mh.name}`,
          kind: "method",
          exported,
          signature: clip(sigs.length === 1 ? (sigs[0] as string) : `(${sigs.join(" ")})`),
          s: m.s,
          e: m.e,
          form: f,
          role: "method",
        });
      }
    }
    if (h === "defrecord" || h === "deftype") {
      const fields = f.items[2]?.t === "vec" ? collapse(src.slice(f.items[2].s, f.items[2].e)) : "[]";
      const ctors = h === "defrecord" ? [`->${name}`, `map->${name}`] : [`->${name}`];
      for (const c of ctors)
        out.push({
          var: c,
          name: c,
          kind: "function",
          exported,
          signature: c.startsWith("map->") ? "[m]" : fields,
          s: def.name.s,
          e: def.name.e,
          form: f,
          role: "ctor",
        });
    }
  }
  // A declared name that no form of the file defines (a forward declaration of a var made elsewhere) is a symbol of its own.
  const defined = new Set(out.map((d) => d.var));
  for (const d of declared) {
    if (defined.has(d.name.name)) continue;
    defined.add(d.name.name);
    out.push({
      var: d.name.name,
      name: d.name.name,
      kind: "function",
      exported: !metaPrivate(d.name.meta),
      signature: "",
      s: d.name.s,
      e: d.name.e,
      form: d.form,
      role: "declare",
    });
  }
  return out.sort((a, b) => a.s - b.s || a.e - b.e);
}

/** A line table: the 1-based line of an offset. */
export class Lines {
  private readonly starts: number[] = [0];
  constructor(src: string) {
    for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) this.starts.push(k + 1);
  }
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

/** Reads the libspecs of `:require`, `:use` and `:require-macros` clauses, and of top-level `require` and `use` calls. */
function requiresOf(nsForm: Coll | undefined, tops: readonly Coll[], lines: Lines): Requires {
  const req: Requires = { aliases: new Map(), refers: new Map(), all: [], imports: [] };
  const libspec = (s: Form, prefix: string, use: boolean): void => {
    if (s.t === "quote") {
      for (const x of s.items) libspec(x, prefix, use);
      return;
    }
    if (s.t === "rcond") {
      for (const x of s.splice ? s.items.flatMap((y) => itemsOf(y)) : s.items) libspec(x, prefix, use);
      return;
    }
    const line = lines.lineOf(s.s);
    if (s.t === "sym") {
      const lib = prefix ? `${prefix}.${s.name}` : s.name;
      if (use) req.all.push(lib);
      req.imports.push({ local: lib, imported: "*", specifier: lib, line });
      return;
    }
    if (s.t !== "vec" && s.t !== "list") return;
    const head = s.items[0];
    if (head?.t !== "sym") return; // a string names a JavaScript module
    const lib = prefix ? `${prefix}.${head.name}` : head.name;
    // A prefix list: `[a.b c [d :as e]]` names `a.b.c` and `a.b.d`.
    if (s.items.length > 1 && s.items[1]?.t !== "kw") {
      for (const sub of s.items.slice(1)) libspec(sub, lib, use);
      return;
    }
    let aliased = false;
    let only = false;
    const renames = new Map<string, string>();
    for (let k = 1; k + 1 < s.items.length; k += 2)
      if (kwText(s.items[k]) === ":rename" && s.items[k + 1]?.t === "map") {
        const m = s.items[k + 1] as Coll;
        for (let j = 0; j + 1 < m.items.length; j += 2) {
          const from = m.items[j];
          const to = m.items[j + 1];
          if (from?.t === "sym" && to?.t === "sym") renames.set(from.name, to.name);
        }
      }
    for (let k = 1; k + 1 < s.items.length; k += 2) {
      const key = kwText(s.items[k]);
      const val = s.items[k + 1] as Form;
      if ((key === ":as" || key === ":as-alias") && val.t === "sym") {
        req.aliases.set(val.name, lib);
        req.imports.push({ local: val.name, imported: "*", specifier: lib, line });
        aliased = true;
      } else if (
        (key === ":refer" || key === ":only" || key === ":refer-macros") &&
        (val.t === "vec" || val.t === "list")
      ) {
        if (key === ":only") only = true;
        for (const r of val.items) {
          if (r.t !== "sym") continue;
          const local = renames.get(r.name) ?? r.name;
          req.refers.set(local, { ns: lib, name: r.name });
          req.imports.push({ local, imported: r.name, specifier: lib, line });
        }
      } else if (key === ":refer" && kwText(val) === ":all") {
        req.all.push(lib);
        req.imports.push({ local: "*", imported: "*", specifier: lib, line });
        aliased = true;
      }
    }
    if (use && !only) req.all.push(lib);
    if (!aliased && !req.imports.some((x) => x.specifier === lib && x.line === line))
      req.imports.push({ local: lib, imported: "*", specifier: lib, line });
  };
  const clauses = (forms: readonly Form[]): void => {
    for (const cl of forms) {
      if (cl.t === "rcond") {
        clauses(cl.splice ? cl.items.flatMap((x) => itemsOf(x)) : cl.items);
        continue;
      }
      if (cl.t !== "list") continue;
      const k = kwText(cl.items[0]);
      if (k === ":require" || k === ":use" || k === ":require-macros" || k === ":use-macros")
        for (const s of cl.items.slice(1)) libspec(s, "", k === ":use" || k === ":use-macros");
    }
  };
  if (nsForm) clauses(nsForm.items.slice(2));
  for (const f of tops) {
    const h = headOf(f);
    if (h && h.ns === undefined && (h.name === "require" || h.name === "use"))
      for (const s of f.items.slice(1)) libspec(s, "", h.name === "use");
  }
  return req;
}

/** The facts of one file: its namespace, what its requires bind and its definitions. */
export function factsOf(src: string): FileFacts {
  const read = readForms(src);
  const lines = new Lines(src);
  const tops = topForms(read.forms);
  const nsForm = tops.find((f) => isSym(f.items[0], "ns") && f.items[1]?.t === "sym");
  const nsName = nsForm?.items[1] as Sym | undefined;
  return {
    ns: nsName ? nsName.name : null,
    requires: requiresOf(nsForm, tops, lines),
    tops,
    definitions: definitionsOf(src, tops),
    errors: read.errors.map((e) => `line ${lines.lineOf(e.offset)}: ${e.message}`),
    comments: read.comments,
  };
}
