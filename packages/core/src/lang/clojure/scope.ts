import { type Definition, headOf } from "./facts.js";
import type { Coll, Form, Sym } from "./reader.js";

/**
 * The walk over the code of one definition (spec section 7, Clojure call edges): every symbol that is not a local is a
 * reference, handed to `visit` with the names bound around it. Locals come from the binding forms: `let`-like vectors
 * (sequential, with destructuring), function parameters, `letfn`, `catch`, `as->`, the `%` parameters of `#(...)`, the
 * fields of a record and the parameters of the method bodies of `reify`, `defrecord`, `deftype`, `extend-type`,
 * `extend-protocol`, `proxy` and `extend`. Quoted forms hold no reference.
 */

export type Env = ReadonlySet<string>;
export type Visit = (s: Sym, env: Env) => void;

/** Heads whose vector binds names in order, each visible to the values after it and to the body. */
const LETS = new Set([
  "let",
  "let*",
  "loop",
  "loop*",
  "when-let",
  "if-let",
  "when-some",
  "if-some",
  "when-first",
  "for",
  "doseq",
  "dotimes",
  "with-open",
  "with-local-vars",
  "go-loop",
]);
/** Heads of a function: parameters, then a body; or several arities, each a list that starts with its parameters. */
const FNS = new Set(["fn", "fn*", "defn", "defn-", "defmacro", "definline", "defmethod", "bound-fn"]);
/** Heads whose items are method bodies (`(name [params] body)`). */
const METHODS = new Set([
  "reify",
  "defrecord",
  "deftype",
  "extend-type",
  "extend-protocol",
  "proxy",
  "extend",
]);
const ANON = ["%", "%&", "%1", "%2", "%3", "%4", "%5", "%6", "%7", "%8", "%9"];
const KEYS = /^:(.*\/)?(keys|strs|syms)$/;

/** Adds the names a binding form (a symbol, or a vector or map destructuring) binds to `env`. */
export function bindNames(f: Form | undefined, env: Set<string>): void {
  if (!f) return;
  if (f.t === "sym") {
    if (f.ns === undefined && f.name !== "&") env.add(f.name);
  } else if (f.t === "kw") {
    // `{:keys [:a]}` and `{:keys [ns/a]}` bind `a`.
    env.add(f.text.replace(/^:+/, "").split("/").pop() as string);
  } else if (f.t === "vec") {
    for (const x of f.items) bindNames(x, env);
  } else if (f.t === "map") {
    for (let k = 0; k + 1 < f.items.length; k += 2) {
      const key = f.items[k] as Form;
      const val = f.items[k + 1];
      if (key.t === "kw" && KEYS.test(key.text)) {
        for (const x of val?.t === "vec" ? val.items : []) {
          if (x.t === "sym")
            env.add(x.name); // `ns/a` binds `a`
          else bindNames(x, env);
        }
      } else if (key.t === "kw" && key.text === ":as") bindNames(val, env);
      else if (key.t !== "kw") bindNames(key, env);
    }
  }
}

/** The default values (`:or {a (f)}`) of the map destructurings in a binding form: code, not names. */
export function defaultsOf(f: Form | undefined, out: Form[] = []): Form[] {
  if (f?.t === "vec") for (const x of f.items) defaultsOf(x, out);
  else if (f?.t === "map")
    for (let k = 0; k + 1 < f.items.length; k += 2) {
      const key = f.items[k] as Form;
      const val = f.items[k + 1] as Form;
      if (key.t === "kw" && key.text === ":or" && val.t === "map")
        for (let j = 1; j < val.items.length; j += 2) out.push(val.items[j] as Form);
      else if (key.t !== "kw") defaultsOf(key, out);
    }
  return out;
}

const isVec = (f: Form | undefined): f is Coll => f?.t === "vec";
const isArity = (f: Form | undefined): f is Coll => f?.t === "list" && f.items[0]?.t === "vec";

/** A walker of the code of one file; `visit` gets each reference. */
export class ScopeWalk {
  /** `onBind` gets every set of names a binding form makes, after the names are added. */
  constructor(
    private readonly visit: Visit,
    private readonly onBind?: (env: ReadonlySet<string>) => void,
  ) {}

  private bound<T extends ReadonlySet<string>>(env: T): T {
    this.onBind?.(env);
    return env;
  }

  /** Walks a function: an optional name (with `named`), forms before the parameters (walked when `pre`), the parameters and the body. */
  private fn(items: readonly Form[], env: Env, from: number, named: boolean, pre: boolean): void {
    const e = new Set(env);
    let k = from;
    if (named && items[k]?.t === "sym") e.add((items[k] as Sym).name);
    if (named && items[k]?.t === "sym") k++;
    for (; k < items.length; k++) {
      const x = items[k] as Form;
      if (isVec(x)) {
        bindNames(x, e);
        for (const d of defaultsOf(x)) this.form(d, e, false);
        k++;
        break;
      }
      if (isArity(x)) break;
      if (pre) this.form(x, env, false);
    }
    this.bound(e);
    for (; k < items.length; k++) {
      const x = items[k] as Form;
      if (isArity(x)) {
        const e2 = new Set(e);
        bindNames(x.items[0], e2);
        for (const d of defaultsOf(x.items[0])) this.form(d, e2, false);
        this.bound(e2);
        for (const y of x.items.slice(1)) this.form(y, e2, false);
      } else this.form(x, e, false);
    }
  }

  /** The items of a list or vector of bindings, sequentially: each value sees the names bound before it. */
  private bindings(b: readonly Form[], env: Set<string>): void {
    for (let k = 0; k < b.length; k += 2) {
      const name = b[k] as Form;
      if (name.t === "kw") {
        // `for` and `doseq` modifiers: `:let [..]` binds, `:when x` and `:while x` are code.
        if (name.text === ":let" && isVec(b[k + 1])) this.bindings((b[k + 1] as Coll).items, env);
        else if (b[k + 1]) this.form(b[k + 1] as Form, env, false);
        continue;
      }
      if (b[k + 1]) this.form(b[k + 1] as Form, env, false);
      for (const d of defaultsOf(name)) this.form(d, env, false);
      bindNames(name, env);
    }
    this.bound(env);
  }

  /** Walks a form; `methods` says that a list of the form `(name [params] body)` is a method body. */
  form(f: Form, env: Env, methods: boolean): void {
    // Metadata is code too (`^{:key (str id)}` in a Reagent view); a type hint names no var of the repo.
    for (const m of f.meta ?? []) this.form(m, env, false);
    if (f.t === "sym") {
      this.visit(f, env);
      return;
    }
    if (f.t === "quote" || !("items" in f)) return;
    if (f.t !== "list") {
      for (const x of f.items) this.form(x, env, false);
      return;
    }
    const head = headOf(f);
    const hn = head?.name;
    if (f.anon) {
      const e = new Set(env);
      for (const a of ANON) e.add(a);
      this.bound(e);
      for (const x of f.items) this.form(x, e, false);
      return;
    }
    if (hn === "quote" && head?.ns === undefined) return;
    if (methods && head && isVec(f.items[1])) {
      this.fn(f.items, env, 1, false, false);
      return;
    }
    if (hn !== undefined && LETS.has(hn) && isVec(f.items[1])) {
      this.form(head as Sym, env, false);
      const e = new Set(env);
      this.bindings((f.items[1] as Coll).items, e);
      for (const x of f.items.slice(2)) this.form(x, e, false);
      return;
    }
    if (hn === "letfn" && isVec(f.items[1])) {
      const e = new Set(env);
      for (const g of (f.items[1] as Coll).items)
        if (g.t === "list" && g.items[0]?.t === "sym") e.add(g.items[0].name);
      this.bound(e);
      for (const g of (f.items[1] as Coll).items) this.form(g, e, true);
      for (const x of f.items.slice(2)) this.form(x, e, false);
      return;
    }
    if (hn !== undefined && FNS.has(hn)) {
      const named = hn === "fn" || hn === "fn*" || hn === "bound-fn";
      // A `defmethod` inside other code refers to its multimethod and its dispatch value.
      this.fn(f.items, env, 1, named, hn === "defmethod");
      return;
    }
    if (hn === "catch" && f.items[2]?.t === "sym") {
      this.form(f.items[1] as Form, env, false);
      const e = new Set(env);
      e.add(f.items[2].name);
      this.bound(e);
      for (const x of f.items.slice(3)) this.form(x, e, false);
      return;
    }
    if (hn === "as->" && f.items[2]?.t === "sym") {
      if (f.items[1]) this.form(f.items[1], env, false);
      const e = new Set(env);
      e.add(f.items[2].name);
      this.bound(e);
      for (const x of f.items.slice(3)) this.form(x, e, false);
      return;
    }
    if (hn !== undefined && METHODS.has(hn)) {
      for (const x of f.items.slice(1)) this.form(x, env, true);
      return;
    }
    for (const x of f.items) this.form(x, env, false);
  }

  /**
   * Walks the code of a top-level definition. The head of a form made by a defining macro of the repo is a reference to
   * that macro; the name a form defines is not a reference.
   */
  definition(d: Pick<Definition, "form" | "role">): void {
    const f = d.form;
    const head = f.items[0] as Sym;
    const h = head.name;
    const core = head.ns === undefined && (h === "def" || h === "defonce" || FNS.has(h) || METHODS.has(h));
    if (!core) this.visit(head, new Set());
    if (d.role === "defmethod") {
      if (f.items[1]) this.visit(f.items[1] as Sym, new Set()); // the multimethod it adds a method to
      if (f.items[2]) this.form(f.items[2], new Set(), false); // the dispatch value
      this.fn(f.items, new Set(), 3, false, false);
      return;
    }
    if (h === "defprotocol" || h === "definterface") return;
    if (h === "defrecord" || h === "deftype") {
      const env = new Set<string>();
      bindNames(f.items[2], env);
      this.bound(env);
      for (const x of f.items.slice(3)) this.form(x, env, true);
      return;
    }
    if (h === "def" || h === "defonce" || h === "defmulti") {
      for (const x of f.items.slice(2)) this.form(x, new Set(), false);
      return;
    }
    // `defn`, `defmacro` and any other defining macro: a function when its items have parameters, plain code otherwise.
    const rest = f.items.slice(2);
    if (rest.some((x) => isVec(x) || isArity(x))) this.fn(f.items, new Set(), 2, false, false);
    else for (const x of rest) this.form(x, new Set(), false);
  }
}
