import { describe, expect, it } from "vitest";
import { type Form, readForms } from "./reader.js";

/** A form as a short string: collections in their brackets, symbols as written, other atoms as `<t>`. */
function show(f: Form): string {
  switch (f.t) {
    case "sym":
      return f.ns === undefined ? f.name : `${f.ns}/${f.name}`;
    case "kw":
    case "num":
      return f.text;
    case "str":
    case "char":
    case "other":
      return `<${f.t}>`;
    case "quote":
      return `'${f.items.map(show).join(" ")}`;
    default: {
      const inner = f.items.map(show).join(" ");
      if (f.t === "rcond")
        return `#?${f.splice ? "@" : ""}(${f.items.map((x, k) => `${f.features?.[k]} ${show(x)}`).join(" ")})`;
      if (f.anon) return `#(${inner})`;
      return f.t === "list"
        ? `(${inner})`
        : f.t === "vec"
          ? `[${inner}]`
          : f.t === "map"
            ? `{${inner}}`
            : `#{${inner}}`;
    }
  }
}

const read = (src: string): string => readForms(src).forms.map(show).join(" ");

describe("clojure reader", () => {
  it("reads collections, symbols with namespaces, keywords and literals", () => {
    expect(read(`(defn f [x] {:a #{1 2} "s" \\c})`)).toBe("(defn f [x] {:a #{1 2} <str> <char>})");
    expect(read("(str/join a/b clojure.core// /)")).toBe("(str/join a/b clojure.core// /)");
    expect(read("(f ::alias/k :k)")).toBe("(f ::alias/k :k)");
  });

  it("drops comments, discarded forms and metadata, and keeps quotes apart", () => {
    expect(read("; a comment\n(a #_(b c) d) #_x")).toBe("(a d)");
    expect(read("[a #_ #_ b c d]")).toBe("[a d]");
    expect(read("(a #_b)")).toBe("(a)");
    expect(read('(def ^:private ^{:doc "x"} n 1)')).toBe("(def n 1)");
    expect(read("(a 'b '(c d) `(e ~f ~@g) @h #'i)")).toBe("(a 'b '(c d) (e f g) h i)");
  });

  it("keeps the metadata on the form it precedes", () => {
    const f = readForms("(defn ^:private f [])").forms[0];
    const name = f && "items" in f ? f.items[1] : undefined;
    expect(name?.meta?.map(show)).toEqual([":private"]);
  });

  it("reads reader conditionals with their features, spliced or not", () => {
    expect(read("#?(:clj a :cljs b)")).toBe("#?(:clj a :cljs b)");
    expect(read("[#?@(:clj [a b])]")).toBe("[#?@(:clj [a b])]");
  });

  it("reads anonymous functions, regular expressions, characters that are brackets and tagged literals", () => {
    expect(read('#(f % %2) #"a(b" \\( \\) (g \\space)')).toBe("#(f % %2) <str> <char> <char> (g <char>)");
    expect(read('#inst "2020" #:a{:b 1} ##Inf')).toBe("<str> {:b 1} ##Inf");
  });

  it("keeps the source offsets of every form", () => {
    const src = "(ns a)\n\n(defn f [x] (g x))";
    const [, f] = readForms(src).forms;
    expect(f && src.slice(f.s, f.e)).toBe("(defn f [x] (g x))");
    const g = f && "items" in f ? f.items[3] : undefined;
    expect(g && src.slice(g.s, g.e)).toBe("(g x)");
  });

  it("reports an unclosed collection or string and a stray bracket, and never throws", () => {
    expect(readForms("(a [b").errors.map((e) => e.message)).toEqual(["unclosed [", "unclosed ("]);
    expect(readForms('"abc').errors.map((e) => e.message)).toEqual(["unclosed string"]);
    expect(readForms("a)").errors.map((e) => e.message)).toEqual(["unexpected )"]);
  });

  it("records the ranges of comments", () => {
    const src = "a ; one\n#! two\nb";
    expect(readForms(src).comments.map((c) => src.slice(c.s, c.e))).toEqual(["; one", "#! two"]);
  });
});
