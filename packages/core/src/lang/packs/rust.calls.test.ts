import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../../indexer.js";
import { resolvePaths } from "../../paths/index.js";
import { openStore } from "../../store/index.js";
import type { EdgeRecord } from "../../types.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../test/helpers/fixture.js";
const { materializeFixture, materializeFiles } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
  materializeFiles: (files: Record<string, string>) => Promise<MaterializedFixture>;
};

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

interface Edge {
  kind: string;
  src: string;
  dst: string;
  conf: string;
  level: number | undefined;
}

/** Indexes a repo directory and returns the `calls`, `extends` and `implements` edges with the repo prefix cut off. */
async function edgesOf(dir: string): Promise<Edge[]> {
  const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const s = openStore(paths.dbPath);
  try {
    const short = (id: string): string => id.replace(/^sym:[^:]+:/, "");
    return (dumpGraph(s).edges as EdgeRecord[])
      .filter((e) => e.kind === "calls" || e.kind === "extends" || e.kind === "implements")
      .map((e) => ({
        kind: e.kind,
        src: short(e.src),
        dst: short(e.dst),
        conf: e.confidence,
        level: e.level,
      }));
  } finally {
    s.close();
  }
}

const CORE = "crates/core/src";
const APP = "crates/app/src";

describe("rust call edges on fixtures/rust-basic", () => {
  let edges: Edge[];
  const find = (kind: string, src: string, dst: string): Edge[] =>
    edges.filter((e) => e.kind === kind && e.src === src && e.dst === dst);
  const has = (kind: string, src: string, dst: string, conf?: string): boolean =>
    find(kind, src, dst).some((e) => conf === undefined || e.conf === conf);

  it("indexes the fixture", async () => {
    const fx = await materializeFixture("rust-basic");
    cleanups.push(() => fx.cleanup());
    edges = await edgesOf(fx.dir);
    expect(edges.length).toBeGreaterThan(0);
  });

  it("every call edge is level 2", () => {
    for (const e of edges.filter((x) => x.kind === "calls")) expect(e.level).toBe(2);
  });

  it("a call on a value whose type is a trait goes to the trait's method, high, and not to its implementers", () => {
    const print = `${APP}/report.rs#print`;
    expect(has("calls", print, `${CORE}/shapes/mod.rs#Shape.area`, "high")).toBe(true);
    expect(has("calls", print, `${CORE}/shapes/mod.rs#Shape.describe`, "high")).toBe(true);
    expect(edges.some((e) => e.src === print && e.dst.endsWith("#Circle.area"))).toBe(false);
    // The default method calls the method of the trait it belongs to.
    expect(
      has("calls", `${CORE}/shapes/mod.rs#Shape.describe`, `${CORE}/shapes/mod.rs#Shape.area`, "high"),
    ).toBe(true);
  });

  it("a call on a value of a concrete type goes to the method of its impl, also one of `impl Trait for Type`", () => {
    const main = `${APP}/main.rs#main`;
    expect(has("calls", main, `${CORE}/shapes/circle.rs#Circle.new`, "high")).toBe(true);
    expect(has("calls", main, `${CORE}/shapes/circle.rs#Circle.area`, "high")).toBe(true);
    expect(has("calls", main, `${CORE}/shapes/mod.rs#Shape.area`)).toBe(false);
    expect(
      has("calls", `${CORE}/shapes/circle.rs#Circle.scaled`, `${CORE}/shapes/circle.rs#Circle.new`, "high"),
    ).toBe(true);
  });

  it("a call of a name a `use` group brings in, in a crate the workspace depends on", () => {
    const main = `${APP}/main.rs#main`;
    expect(has("calls", main, `${CORE}/util.rs#clamp`, "high")).toBe(true);
    expect(has("calls", main, `${CORE}/util.rs#round_to`, "high")).toBe(true);
  });

  it("a call into a nested module, through `self` in a group, `crate::` and `mod`", () => {
    const main = `${APP}/main.rs#main`;
    expect(has("calls", main, `${CORE}/shapes/circle.rs#unit`, "high")).toBe(true);
    expect(has("calls", main, `${APP}/report.rs#print`, "high")).toBe(true);
    expect(has("calls", `${CORE}/shapes/circle.rs#Circle.new`, `${CORE}/util.rs#clamp`, "high")).toBe(true);
    expect(has("calls", `${CORE}/shapes/circle.rs#unit`, `${CORE}/shapes/circle.rs#Circle.new`, "high")).toBe(
      true,
    );
  });

  it("a test file's call reaches the code it tests", () => {
    expect(
      has("calls", "crates/app/tests/report_test.rs#clamps_above", `${CORE}/util.rs#clamp`, "high"),
    ).toBe(true);
  });

  it("implements comes from the block that names the trait, at high confidence", () => {
    expect(has("implements", `${CORE}/shapes/circle.rs#Circle`, `${CORE}/shapes/mod.rs#Shape`, "high")).toBe(
      true,
    );
    expect(edges.filter((e) => e.kind === "implements" && e.conf === "low")).toEqual([]);
  });
});

describe("rust calls on small repos", () => {
  const CARGO = '[package]\nname = "m"\n';

  async function repo(files: Record<string, string>): Promise<Edge[]> {
    const fx = await materializeFiles({ "Cargo.toml": CARGO, ...files });
    cleanups.push(() => fx.cleanup());
    return edgesOf(fx.dir);
  }
  const show = (edges: Edge[], kind = "calls"): string[] =>
    edges
      .filter((e) => e.kind === kind)
      .map((e) => `${e.src} -> ${e.dst} ${e.conf}`)
      .sort();

  it("a call on a value typed as a trait goes to the trait's method: `&dyn`, `impl`, a bound parameter, a result", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub trait Shape { fn area(&self) -> f64; }
pub struct C;
impl Shape for C { fn area(&self) -> f64 { 1.0 } }
pub struct D;
impl Shape for D { fn area(&self) -> f64 { 2.0 } }
fn a(s: &dyn Shape) { s.area(); }
fn b(s: impl Shape) { s.area(); }
fn c<T: Shape>(s: T) { s.area(); }
fn d<T>(s: &T) where T: Shape { s.area(); }
fn e<T: Shape + 'static>(s: T) { s.area(); }
fn f(s: &mut dyn Shape) { s.area(); }
fn g() -> impl Shape { C }
fn h() { g().area(); }
`,
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#a -> src/lib.rs#Shape.area high",
      "src/lib.rs#b -> src/lib.rs#Shape.area high",
      "src/lib.rs#c -> src/lib.rs#Shape.area high",
      "src/lib.rs#d -> src/lib.rs#Shape.area high",
      "src/lib.rs#e -> src/lib.rs#Shape.area high",
      "src/lib.rs#f -> src/lib.rs#Shape.area high",
      "src/lib.rs#h -> src/lib.rs#Shape.area high",
      "src/lib.rs#h -> src/lib.rs#g high",
    ]);
    expect(show(edges, "implements")).toEqual([
      "src/lib.rs#C -> src/lib.rs#Shape high",
      "src/lib.rs#D -> src/lib.rs#Shape high",
    ]);
  });

  it("a supertrait is `extends`, and a method of it is found on a value typed by the trait; the bounds of an impl block read in its methods", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub trait Named { fn name(&self) -> String; }
pub trait Shape: Named + std::fmt::Debug { fn area(&self) -> f64; }
fn a(s: &dyn Shape) { s.name(); s.area(); s.fmt(); }
pub struct W<T> { t: T }
impl<T> W<T> where T: Named {
    fn go(&self, x: T) { x.name(); }
    fn same(&self, x: &T) { x.name(); }
}
impl<T: Named + Shape> W<T> { fn two(&self, x: T) { x.name(); } }
`,
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#W.go -> src/lib.rs#Named.name high",
      "src/lib.rs#W.same -> src/lib.rs#Named.name high",
      "src/lib.rs#a -> src/lib.rs#Named.name high",
      "src/lib.rs#a -> src/lib.rs#Shape.area high",
    ]);
    expect(show(edges, "extends")).toEqual(["src/lib.rs#Shape -> src/lib.rs#Named high"]);
  });

  it("a parameter with several bounds, a smart pointer and a type outside the repo give no edge", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub trait A { fn a(&self); }
pub trait B { fn b(&self); }
pub struct S;
impl S { fn m(&self) {} }
fn two<T: A + B>(x: T) { x.a(); x.b(); }
fn split<T: A>(x: T) where T: B { x.a(); }
fn boxed(x: Box<dyn A>, y: &Box<dyn A>, z: std::rc::Rc<dyn A>) { x.a(); y.a(); z.a(); }
fn smart(x: Box<S>, y: Rc<S>, z: Arc<S>, w: &Unknown, v: Option<S>) { x.m(); y.m(); z.m(); w.m(); v.m(); }
fn free<T>(x: T) { x.m(); }
`,
    });
    expect(show(edges)).toEqual([]);
  });

  it("reads the type of a local from its annotation, a constructor, a struct literal, a result or a reference", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub struct S { n: i32 }
impl S {
    pub fn new() -> Self { S { n: 0 } }
    pub fn make() -> S { S { n: 1 } }
    pub fn m(&self) {}
}
fn mk() -> S { S::new() }
fn opt() -> Option<S> { None }
fn annotated() { let a: S = S::new(); a.m(); }
fn ctor() { let a = S::new(); a.m(); }
fn assoc() { let a = S::make(); a.m(); }
fn literal() { let a = S { n: 2 }; a.m(); }
fn result() { let a = mk(); a.m(); }
fn reference(s: &S) { let a = &s; a.m(); }
fn unread() { let a = opt(); a.m(); let b = unknown(); b.m(); }
fn tuple() { let (a, b) = (S::new(), S::new()); a.m(); }
fn shadowed() { let a = S::new(); let a = unknown(); a.m(); }
`,
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#annotated -> src/lib.rs#S.m high",
      "src/lib.rs#annotated -> src/lib.rs#S.new high",
      "src/lib.rs#assoc -> src/lib.rs#S.m high",
      "src/lib.rs#assoc -> src/lib.rs#S.make high",
      "src/lib.rs#ctor -> src/lib.rs#S.m high",
      "src/lib.rs#ctor -> src/lib.rs#S.new high",
      "src/lib.rs#literal -> src/lib.rs#S.m high",
      "src/lib.rs#mk -> src/lib.rs#S.new high",
      "src/lib.rs#reference -> src/lib.rs#S.m high",
      "src/lib.rs#result -> src/lib.rs#S.m high",
      "src/lib.rs#result -> src/lib.rs#mk high",
      "src/lib.rs#shadowed -> src/lib.rs#S.new high",
      "src/lib.rs#tuple -> src/lib.rs#S.new high",
      "src/lib.rs#unread -> src/lib.rs#opt high",
    ]);
  });

  it("`self`, `Self::` and the fields of the type", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub struct Inner;
impl Inner { fn go(&self) {} }
pub struct W { inner: Inner, boxed: Box<Inner>, count: usize }
impl W {
    fn new() -> Self { W { inner: Inner, boxed: Box::new(Inner), count: 0 } }
    fn run(&self) { self.step(); Self::new(); self.inner.go(); self.boxed.go(); self.count.go(); }
    fn step(&self) {}
}
pub trait T { fn one(&self); fn two(&self) { self.one(); Self::three(); } fn three() {} }
`,
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#T.two -> src/lib.rs#T.one high",
      "src/lib.rs#T.two -> src/lib.rs#T.three high",
      "src/lib.rs#W.run -> src/lib.rs#Inner.go high",
      "src/lib.rs#W.run -> src/lib.rs#W.new high",
      "src/lib.rs#W.run -> src/lib.rs#W.step high",
    ]);
  });

  it("a method that both an inherent impl and a trait impl declare, or several impl blocks, is no edge", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub trait T1 { fn go(&self); fn dflt(&self) {} fn only_trait(&self); }
pub trait T2 { fn go(&self); }
pub struct S;
impl S { fn go(&self) {} fn only(&self) {} }
impl T1 for S { fn go(&self) {} fn only_trait(&self) {} }
impl T2 for S { fn go(&self) {} }
fn x(s: &S) { s.go(); s.only(); s.dflt(); s.only_trait(); }
pub struct Q;
#[cfg(unix)]
impl Q { fn p(&self) {} fn same(&self) {} }
#[cfg(windows)]
impl Q { fn p(&self) {} }
fn y(q: Q) { q.p(); q.same(); }
`,
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#x -> src/lib.rs#S.only high",
      "src/lib.rs#x -> src/lib.rs#S.only_trait high",
      "src/lib.rs#x -> src/lib.rs#T1.dflt high",
      "src/lib.rs#y -> src/lib.rs#Q.same high",
    ]);
  });

  it("an impl on a type that is not read, a blanket impl and a type outside the repo are no type of the repo", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub trait Describe { fn d(&self) -> String; fn make() -> Self; }
pub struct T;
impl<T: ToString> Describe for T { fn d(&self) -> String { self.to_string() } fn make() -> Self { Self::make() } }
pub struct W;
impl Describe for &W { fn d(&self) -> String { String::new() } fn make() -> Self { Self::d() } }
impl Describe for String { fn d(&self) -> String { self.d() } fn make() -> Self { String::new() } }
fn z(t: T, w: W, s: String) { t.d(); w.d(); s.d(); }
fn generic<T: Default>() -> T { T::default() }
`,
    });
    expect(show(edges)).toEqual([]);
  });

  it("a trait implemented in another file or module is a supertype of the type, and its methods are the type's", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub mod shape;
pub mod circle;
pub mod extra;
use shape::Shape;
use circle::Circle;
fn use_it(c: Circle) { c.area(); c.perimeter(); c.label(); c.nothing(); }
`,
      "src/shape.rs": `pub trait Shape { fn area(&self) -> f64; fn label(&self) -> String { String::new() } }`,
      "src/circle.rs": `pub struct Circle; impl Circle { pub fn perimeter(&self) -> f64 { 1.0 } }`,
      "src/extra.rs": `
use crate::shape::Shape;
use crate::circle::Circle;
impl Shape for Circle { fn area(&self) -> f64 { 3.0 } }
impl Circle { fn nothing_here(&self) {} }
`,
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#use_it -> src/circle.rs#Circle.perimeter high",
      "src/lib.rs#use_it -> src/extra.rs#Circle.area high",
      "src/lib.rs#use_it -> src/shape.rs#Shape.label high",
    ]);
    expect(show(edges, "implements")).toEqual(["src/circle.rs#Circle -> src/shape.rs#Shape high"]);
  });

  it("imports: paths, groups, renames, `self` in a group and nested groups", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub mod a;
use a::{f1, f2 as g2, inner::{deep, deeper::deepest}, self as aa};
fn go() { f1(); }
fn go2() { g2(); }
fn go3() { deep(); }
fn go4() { deepest(); }
fn go5() { aa::f1(); }
fn go6() { a::f2(); }
fn go7() { a::inner::deep(); }
fn go8() { crate::a::f1(); }
fn go9() { self::local(); }
fn local() {}
fn none() { f2(); a::missing(); b::f1(); }
`,
      "src/a/mod.rs": "pub fn f1() {} pub fn f2() {} pub mod inner;",
      "src/a/inner/mod.rs": "pub fn deep() {} pub mod deeper;",
      "src/a/inner/deeper.rs": "pub fn deepest() {}",
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#go -> src/a/mod.rs#f1 high",
      "src/lib.rs#go2 -> src/a/mod.rs#f2 high",
      "src/lib.rs#go3 -> src/a/inner/mod.rs#deep high",
      "src/lib.rs#go4 -> src/a/inner/deeper.rs#deepest high",
      "src/lib.rs#go5 -> src/a/mod.rs#f1 high",
      "src/lib.rs#go6 -> src/a/mod.rs#f2 high",
      "src/lib.rs#go7 -> src/a/inner/mod.rs#deep high",
      "src/lib.rs#go8 -> src/a/mod.rs#f1 high",
      "src/lib.rs#go9 -> src/lib.rs#local high",
    ]);
  });

  it("`super::` and `self::` go by the module of the file, in a file named by its module or by `mod.rs`", async () => {
    const edges = await repo({
      "src/lib.rs": "pub mod a; pub fn root() {}",
      "src/a.rs": "pub mod b; pub fn up() {} pub fn go() { super::root(); b::down(); self::up(); }",
      "src/a/b.rs":
        "pub fn down() { super::up(); super::super::root(); crate::root(); super::super::super::root(); }",
    });
    expect(show(edges)).toEqual([
      "src/a.rs#go -> src/a.rs#up high",
      "src/a.rs#go -> src/a/b.rs#down high",
      "src/a.rs#go -> src/lib.rs#root high",
      "src/a/b.rs#down -> src/a.rs#up high",
      "src/a/b.rs#down -> src/lib.rs#root high",
    ]);
  });

  it("a glob import names no module: a name that two globs could supply, or one, gives no edge", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub mod b; pub mod c;
use b::*;
use c::*;
fn go() { shared(); only_b(); own(); }
fn own() {}
`,
      "src/b.rs": "pub fn shared() {} pub fn only_b() {}",
      "src/c.rs": "pub fn shared() {}",
    });
    expect(show(edges)).toEqual(["src/lib.rs#go -> src/lib.rs#own high"]);
  });

  it("a name an `as` import or a local binds hides the function of that name", async () => {
    const edges = await repo({
      "src/lib.rs": `
fn helper() {}
fn inner() {}
fn closure() { let f = |helper: fn()| helper(); f(helper); }
fn looped(v: Vec<fn()>) { for helper in v { helper(); } }
fn iflet(o: Option<fn()>) { if let Some(helper) = o { helper(); } }
fn matched(o: Option<fn()>) { match o { Some(helper) => helper(), None => {} } }
fn tupled((helper, y): (fn(), u8)) { helper(); }
fn letted() { let helper = 1; helper(); }
fn nested() { fn inner() {} inner(); }
fn plain() { helper(); }
`,
    });
    expect(show(edges)).toEqual(["src/lib.rs#plain -> src/lib.rs#helper high"]);
  });

  it("a macro's arguments and body are not read, and a name a macro or a derive brings is no function of the repo", async () => {
    const edges = await repo({
      "src/lib.rs": `
macro_rules! shout { ($x:expr) => { $x }; }
macro_rules! make { ($n:ident) => { fn $n() {} }; }
make!(generated);
fn t() {}
#[derive(Default, Clone)]
pub struct S;
fn go() {
    shout!(t());
    println!("{}", t());
    let v = vec![t()];
    generated();
    S::default();
    S.clone();
    t();
}
#[cfg(test)]
mod tests { fn check() { t(); } }
`,
    });
    expect(show(edges)).toEqual(["src/lib.rs#go -> src/lib.rs#t high"]);
  });

  it("a crate the workspace depends on is named by its crate name, with `_` for `-`; `lib.rs` is the crate", async () => {
    const fx = await materializeFiles({
      "Cargo.toml": '[workspace]\nmembers = ["a", "b"]\n',
      "a/Cargo.toml": '[package]\nname = "my-core"\n',
      "a/src/lib.rs": "pub mod util; pub fn root() {}\npub use util::helper;",
      "a/src/util.rs": "pub fn helper() {}",
      "b/Cargo.toml": '[package]\nname = "my-app"\n[dependencies]\nmy-core = { path = "../a" }\n',
      "b/src/main.rs": `
use my_core::util::helper as h;
use my_core::{root, helper};
fn main() { h(); root(); my_core::util::helper(); my_core::root(); other(); }
fn second() { helper(); }
fn other() {}
`,
      "c/Cargo.toml": '[package]\nname = "stranger"\n',
      "c/src/lib.rs": "use my_core::root;\nfn f() { root(); my_core::root(); }",
    });
    cleanups.push(() => fx.cleanup());
    const edges = await edgesOf(fx.dir);
    expect(show(edges)).toEqual([
      "b/src/main.rs#main -> a/src/lib.rs#root high",
      "b/src/main.rs#main -> a/src/util.rs#helper high",
      "b/src/main.rs#main -> b/src/main.rs#other high",
      "b/src/main.rs#second -> a/src/util.rs#helper high",
    ]);
  });

  it("in a package with a library, `main.rs` is a module of its own and refers to the library by its name", async () => {
    const edges = await repo({
      "src/lib.rs": "pub fn run() {} pub fn shared() {}",
      "src/main.rs": "use m::run;\nfn shared() {}\nfn main() { run(); shared(); m::shared(); }",
    });
    expect(show(edges)).toEqual([
      "src/main.rs#main -> src/lib.rs#run high",
      "src/main.rs#main -> src/lib.rs#shared high",
      "src/main.rs#main -> src/main.rs#shared high",
    ]);
  });

  it("names re-exported by `pub use` are followed, a type is found through the module that holds it", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub mod shapes;
pub use shapes::Circle;
use shapes::Circle as C2;
pub struct Holder { c: Circle, n: shapes::Circle, p: crate::shapes::Circle }
impl Holder { fn go(&self) { self.c.area(); self.n.area(); self.p.area(); } }
fn t1(c: C2) { c.area(); }
fn t2() { Circle::new(); shapes::Circle::new(); crate::shapes::Circle::new(); }
`,
      "src/shapes/mod.rs": "mod circle; pub use circle::Circle;",
      "src/shapes/circle.rs":
        "pub struct Circle; impl Circle { pub fn new() -> Self { Circle } pub fn area(&self) -> f64 { 1.0 } }",
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#Holder.go -> src/shapes/circle.rs#Circle.area high",
      "src/lib.rs#t1 -> src/shapes/circle.rs#Circle.area high",
      "src/lib.rs#t2 -> src/shapes/circle.rs#Circle.new high",
    ]);
  });

  it("an item in a module written in place, and in a test module, is no symbol and has no edge", async () => {
    const edges = await repo({
      "src/lib.rs": `
fn t() {}
mod inline { pub fn f() { super::t(); } }
#[cfg(test)]
mod tests { use super::*; fn check() { t(); } }
fn go() { inline::f(); }
`,
    });
    expect(show(edges)).toEqual([]);
  });

  it("a type parameter or an associated function of one is not a type of the repo of that name", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub struct T;
impl T { pub fn new() -> T { T } pub fn m(&self) {} }
fn a<T>(x: T) { x.m(); T::new(); }
fn b<T: Clone>(x: T) { x.m(); T::new(); }
fn c(x: T) { x.m(); T::new(); }
`,
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#c -> src/lib.rs#T.m high",
      "src/lib.rs#c -> src/lib.rs#T.new high",
    ]);
  });

  it("a call of a field written in parentheses is no call of the method of that name", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub struct S { run: fn(i32) }
impl S { fn run(&self, n: i32) {} fn go(&self) { (self.run)(1); self.run(2); } }
`,
    });
    expect(show(edges)).toEqual(["src/lib.rs#S.go -> src/lib.rs#S.run high"]);
  });

  it("a tuple struct called by its name gives its value the type, a variant of an enum gives none", async () => {
    const edges = await repo({
      "src/lib.rs": `
pub enum E { A(i32), B }
impl E { pub fn go(&self) {} }
pub struct P(i32);
impl P { pub fn go(&self) {} }
fn f(e: &E) { e.go(); let v = E::A(1); v.go(); let p = P(1); p.go(); }
`,
    });
    expect(show(edges)).toEqual([
      "src/lib.rs#f -> src/lib.rs#E.go high",
      "src/lib.rs#f -> src/lib.rs#P.go high",
    ]);
  });
});
