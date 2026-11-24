import { describe, expect, it } from "vitest";
import { languageModule, languageOfPath } from "../index.js";
import { factsOf } from "./facts.js";
import { parseClojure } from "./parse.js";

const parse = (src: string, path = "src/a/core.clj") => parseClojure("r", path, src);
const names = (src: string, path?: string): string[] =>
  parse(src, path).symbols.map((s) => `${s.name}:${s.kind}${s.exported ? "" : ":private"}`);

describe("clojure symbols", () => {
  it("makes a symbol of every defining form, custom macros included", () => {
    const src = [
      "(ns a.core (:require [utils.re-frame :as rf]))",
      "(def limit 10)",
      "(def inc2 (fn [x] (+ x 2)))",
      "(defonce state (atom {}))",
      "(defn f [x] x)",
      "(defn- g [] 1)",
      "(def ^:private h 2)",
      "(defmacro m [& body] `(do ~@body))",
      "(defmulti area :shape)",
      "(rf/defn on-click {:events [:click]} [cofx] {})",
      "(deftest checks (is true))",
      "(defview screen [] [:view])",
      "(defschema User {:name :string})",
    ].join("\n");
    expect(names(src)).toEqual([
      "limit:const",
      "inc2:function",
      "state:const",
      "f:function",
      "g:function:private",
      "h:const:private",
      "m:function",
      "area:function",
      "on-click:function",
      "checks:function",
      "screen:function",
      "User:const",
    ]);
  });

  it("names protocol methods, record constructors and defmethods, and skips a declared name that is defined", () => {
    const src = [
      "(ns a.shapes)",
      "(declare circle orphan)",
      "(defprotocol Shape (area [s]) (scale [s k] [s k j]))",
      "(defrecord Circle [r] Shape (area [_] r))",
      "(deftype Box [w])",
      "(defn circle [r] (->Circle r))",
      "(defmethod draw :circle [c] c)",
    ].join("\n");
    const p = parse(src);
    expect(p.symbols.map((s) => `${s.name}:${s.kind}:${s.signature}`)).toEqual([
      "orphan:function:",
      "Shape:interface:",
      "Shape.area:method:[s]",
      "Shape.scale:method:([s k] [s k j])",
      "Circle:class:[r]",
      "->Circle:function:[r]",
      "map->Circle:function:[m]",
      "Box:class:[w]",
      "->Box:function:[w]",
      "circle:function:[r]",
      "draw.:circle:method:[c]",
    ]);
  });

  it("reads definitions through do, comment and reader conditionals, repeating a name with ~2", () => {
    const src = [
      "(ns a.util)",
      "#?(:clj (defn now [] 1) :cljs (defn now [] 2))",
      "#?(:fdroid [(def token 1)] :cljs [(def token 2)])",
      "(do (defn x [] 1))",
      "(goog-define DEBUG false)",
    ].join("\n");
    expect(
      parse(src, "src/a/util.cljc").symbols.map((s) => s.id.replace(/^sym:r:src\/a\/util\.cljc#/, "")),
    ).toEqual(["now", "now~2", "token", "token~2", "x", "DEBUG"]);
  });

  it("gives lines, the body range, the signature of each arity, statements and complexity", () => {
    const src =
      '(ns a)\n\n(defn f\n  "doc"\n  ([x] (f x 1))\n  ([x y]\n   (if (pos? x) (inc y) (cond (neg? y) 1 :else 2))))\n';
    const p = parse(src);
    const f = p.symbols[0];
    expect(f).toMatchObject({ name: "f", signature: "([x] [x y])", startLine: 3, endLine: 7, loc: 5 });
    expect(f?.stmtCount).toBe(6);
    expect(f?.complexity).toBe(4);
    const r = p.bodies.get(f?.id as string);
    expect(r && src.slice(r.start, r.end).startsWith("(defn f")).toBe(true);
  });

  it("turns the ns form into imports: aliases, refers, renames, refer all, prefix lists and use", () => {
    const src = [
      "(ns a.core",
      "  (:require [b.one :as one :refer [x y] :rename {y why}]",
      "            [b.two :refer :all]",
      "            [b.three :as-alias three]",
      "            (b four [five :as f])",
      "            b.six",
      '            ["react" :as react]',
      "            #?(:cljs [b.seven :as seven]))",
      "  (:use [b.eight :only [z]] b.nine))",
    ].join("\n");
    const f = factsOf(src);
    expect(f.ns).toBe("a.core");
    expect([...f.requires.aliases]).toEqual([
      ["one", "b.one"],
      ["three", "b.three"],
      ["f", "b.five"],
      ["seven", "b.seven"],
    ]);
    expect([...f.requires.refers]).toEqual([
      ["x", { ns: "b.one", name: "x" }],
      ["why", { ns: "b.one", name: "y" }],
      ["z", { ns: "b.eight", name: "z" }],
    ]);
    expect(f.requires.all).toEqual(["b.two", "b.nine"]);
    expect(parse(src).imports.map((i) => `${i.local}<-${i.imported}@${i.specifier}`)).toEqual([
      "one<-*@b.one",
      "x<-x@b.one",
      "why<-y@b.one",
      "*<-*@b.two",
      "three<-*@b.three",
      "b.four<-*@b.four",
      "f<-*@b.five",
      "b.six<-*@b.six",
      "seven<-*@b.seven",
      "z<-z@b.eight",
      "b.nine<-*@b.nine",
    ]);
  });

  it("reports what the reader could not close", () => {
    expect(parse("(ns a)\n(defn f [x]\n  (g x)").errors).toEqual(["line 2: unclosed ("]);
  });
});

describe("clojure module", () => {
  it("claims .clj, .cljs and .cljc and skips build output", () => {
    for (const p of ["src/a.clj", "src/a.cljs", "src/a.cljc"]) expect(languageOfPath(p)?.id).toBe("clojure");
    expect(languageOfPath("deps.edn")).toBeUndefined();
    const skip = languageModule("clojure").skipPath;
    expect(skip?.("app/target/classes/a.clj")).toBe(true);
    expect(skip?.("ui/.shadow-cljs/builds/a.cljs")).toBe(true);
    expect(skip?.("src/a.clj")).toBe(false);
  });

  it("gives the same exact stream to two functions that differ only in their names and locals", () => {
    const m = languageModule("clojure");
    const a = '(defn f [x] (let [y (inc x)] (g y "s")))';
    const b = '(defn h [p] (let [q (inc p)] (g q "t")))';
    const sa = m.streams(a, { start: 0, end: a.length }, "a.clj");
    const sb = m.streams(b, { start: 0, end: b.length }, "a.clj");
    expect(sa.exact.filter((t) => !t.startsWith("I:f") && !t.startsWith("S:"))).toEqual(
      sb.exact.filter((t) => !t.startsWith("I:h") && !t.startsWith("S:")),
    );
    expect(sa.shape).toEqual(sb.shape);
    expect(sa.exact).toContain("$1");
    expect(sa.selfRefs).toEqual([2]); // `(`, `defn`, then the name
    expect(m.embeddingText(a, { start: 0, end: a.length }, "a.clj")).toBe(
      '(defn v1 [v2] (let [v3 (inc v2)] (g v3 "s")))',
    );
  });
});
