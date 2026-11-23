import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashStreams } from "../../hash/index.js";
import { parseWithPack } from "../engine/parse.js";
import { embeddingTextWithPack, streamsWithPack } from "../engine/streams.js";
import { packDependsOnEdges } from "../engine/workspace.js";
import { languageModule } from "../index.js";
import { rustPack } from "./index.js";

const parse = (src: string, path = "src/lib.rs") => parseWithPack(rustPack, "r", path, src);
const byName = (src: string) => new Map(parse(src).symbols.map((s) => [s.name, s]));

describe("rust symbols", () => {
  const src = `use std::fmt;

pub trait Shape: Named {
    fn area(&self) -> f64;
    fn label(&self) -> String { String::new() }
}

pub struct Circle<T> { pub r: f64, t: T }
struct Unit;
struct Pair(f64, f64);
pub(crate) enum Kind { A, B(i32) }

impl<T> Circle<T> {
    pub fn new(r: f64) -> Self { Circle { r, t: todo!() } }
    fn hidden(&self) {}
}

impl<T: Clone> Shape for Circle<T> {
    fn area(&self) -> f64 { 1.0 }
}

impl Shape for &Unit { fn area(&self) -> f64 { 0.0 } }
impl<T: ToString> Describe for T { fn describe(&self) -> String { self.to_string() } }

pub fn free<'a>(x: &'a str) -> &'a str { x }
async fn later() {}
mod inline { pub fn inner() {} }
#[cfg(test)]
mod tests { fn check() {} }
const LIMIT: u32 = 3;
macro_rules! shout { ($x:expr) => { $x }; }
fn main() { fn nested() {} nested(); }
`;

  it("names types by their name and methods by the type of their trait or impl block", () => {
    expect([...byName(src).keys()]).toEqual([
      "Shape",
      "Shape.area",
      "Shape.label",
      "Circle",
      "Unit",
      "Pair",
      "Kind",
      "Circle.new",
      "Circle.hidden",
      "Circle.area",
      "?.area",
      "?.describe",
      "free",
      "later",
      "main",
    ]);
  });

  it("maps declarations to symbol kinds", () => {
    const m = byName(src);
    expect(m.get("Shape")?.kind).toBe("interface");
    expect(m.get("Circle")?.kind).toBe("class");
    expect(m.get("Unit")?.kind).toBe("class");
    expect(m.get("Pair")?.kind).toBe("class");
    expect(m.get("Kind")?.kind).toBe("enum");
    expect(m.get("Shape.area")?.kind).toBe("method");
    expect(m.get("Circle.new")?.kind).toBe("method");
    expect(m.get("free")?.kind).toBe("function");
    expect(m.get("later")?.kind).toBe("function");
  });

  it("does not read modules written in place, items in a block, constants or macros as symbols", () => {
    const names = [...byName(src).keys()];
    for (const n of ["inline", "inner", "tests", "check", "nested", "LIMIT", "shout"]) {
      expect(names).not.toContain(n);
    }
  });

  it("is exported by `pub`, also with a restriction, and a trait's methods are the trait's", () => {
    const m = byName(src);
    expect(m.get("Shape")?.exported).toBe(true);
    expect(m.get("Circle")?.exported).toBe(true);
    expect(m.get("Unit")?.exported).toBe(false);
    expect(m.get("Kind")?.exported).toBe(true);
    expect(m.get("Circle.new")?.exported).toBe(true);
    expect(m.get("Circle.hidden")?.exported).toBe(false);
    expect(m.get("Shape.area")?.exported).toBe(true);
    expect(m.get("later")?.exported).toBe(false);
  });

  it("keeps the methods of one name that several blocks declare apart by the order of the file", () => {
    const p = parse(
      "struct A; impl A { fn f(&self) {} } trait T { fn f(&self); } impl T for A { fn f(&self) {} }",
    );
    expect(p.symbols.map((s) => s.id)).toEqual([
      "sym:r:src/lib.rs#A",
      "sym:r:src/lib.rs#A.f",
      "sym:r:src/lib.rs#T",
      "sym:r:src/lib.rs#T.f",
      "sym:r:src/lib.rs#A.f~2",
    ]);
  });

  it("writes the signature as the parameters and then the result type", () => {
    const m = byName(src);
    expect(m.get("Shape.area")?.signature).toBe("(&self) f64");
    expect(m.get("Circle.new")?.signature).toBe("(r: f64) Self");
    expect(m.get("later")?.signature).toBe("()");
  });

  it("measures the body of a function", () => {
    const m = byName(
      "fn f(a: i32) -> i32 { if a > 0 && a < 9 { return 1; } for x in xs { a += x; } match a { 1 => 2, _ => 3 } }",
    );
    expect(m.get("f")?.complexity).toBe(6);
    expect(m.get("f")?.stmtCount).toBe(5);
  });

  it("reports a syntax error and still returns what it read", () => {
    const p = parse("fn a() { let = ; } fn b() {}");
    expect(p.errors).toEqual(["line 1: syntax error"]);
    expect(p.symbols.map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("rust imports", () => {
  const imports = (src: string) => parse(src).imports.map((i) => [i.local, i.imported, i.specifier, i.line]);

  it("keeps paths, groups, renames, self and globs with the path they come from", () => {
    expect(
      imports(`use std::fmt;
use crate::shapes::{Circle, Square as Sq, self, inner::{A, B}, *};
use super::util::clamp as c;
use a::b::*;
use ::std::io;
pub use self::x::Y;
use foo;
`),
    ).toEqual([
      ["fmt", "fmt", "std", 1],
      ["Circle", "Circle", "crate::shapes", 2],
      ["Sq", "Square", "crate::shapes", 2],
      ["shapes", "shapes", "crate", 2],
      ["A", "A", "crate::shapes::inner", 2],
      ["B", "B", "crate::shapes::inner", 2],
      ["*", "*", "crate::shapes", 2],
      ["c", "clamp", "super::util", 3],
      ["*", "*", "a::b", 4],
      ["io", "io", "std", 5],
      ["Y", "Y", "self::x", 6],
      ["foo", "foo", "", 7],
    ]);
  });

  it("reads a module declared without a body as an import of that module from the module around", () => {
    expect(
      imports("pub mod a;\nmod b { fn f() {} }\n#[cfg(test)]\nmod tests;\nuse a::f;\n").slice(0, 3),
    ).toEqual([
      ["a", "a", "self", 1],
      ["tests", "tests", "self", 4],
      ["f", "f", "a", 5],
    ]);
  });

  it("reads only the declarations at the top of a file", () => {
    expect(imports("fn f() { use a::b; }\nmod m { use c::d; }\n")).toEqual([]);
  });
});

describe("rust generated files", () => {
  it("marks a file that starts with `// @generated`", () => {
    expect(parse("// @generated by build.rs\nfn a() {}").directives).toEqual(["generated"]);
    expect(parse("// @generated\nfn a() {}").directives).toEqual(["generated"]);
    expect(parse("fn a() {}\n// @generated\n").directives).toBeUndefined();
    expect(parse("// not @generated\nfn a() {}").directives).toBeUndefined();
  });
});

describe("rust token streams", () => {
  const range = (src: string, needle: string) => {
    const start = src.indexOf(needle);
    return { start, end: start + needle.length };
  };

  it("gives the same exact hash to two functions that differ only in the names of their locals", () => {
    const a = "fn total(xs: &[i32]) -> i32 { let mut sum = 0; for x in xs { sum += x; } sum }";
    const b = "fn total(ys: &[i32]) -> i32 { let mut acc = 0; for y in ys { acc += y; } acc }";
    const sa = streamsWithPack(rustPack, a, range(a, a));
    const sb = streamsWithPack(rustPack, b, range(b, b));
    expect(sa.exact).toContain("$1");
    expect(sa.shape).toContain("ID");
    expect(hashStreams(sa).exactHash).toBe(hashStreams(sb).exactHash);
  });

  it("separates different literals in the exact stream but not in the shape", () => {
    const a = 'fn f() -> String { format("a", "b") }';
    const b = 'fn f() -> String { format("c", "d") }';
    const sa = streamsWithPack(rustPack, a, range(a, a));
    const sb = streamsWithPack(rustPack, b, range(b, b));
    expect(hashStreams(sa).exactHash).not.toBe(hashStreams(sb).exactHash);
    expect(hashStreams(sa).shapeHash).toBe(hashStreams(sb).shapeHash);
  });

  it("renames locals and strings in the embedding text and drops comments", () => {
    const f = 'fn greet(name: &str) -> String { // hi\n let s = "hello "; s + name }';
    expect(embeddingTextWithPack(rustPack, f, range(f, f))).toBe(
      'fn v1(v2: &str) -> String { let v3 = "s"; v3 + v2 }',
    );
  });
});

describe("rust workspaces", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files: Record<string, string>): string => {
    const root = join(mkdtempSync(join(tmpdir(), "gantry-rust-")), "proj");
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const detect = (root: string) =>
    languageModule("rust").detectWorkspaces(root, { workspaces: { overrides: {} } }, "r");

  it("makes a workspace of each manifest that has a package, named by it", () => {
    const root = repo({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
      "crates/core/Cargo.toml": '[package]\nname = "acme-core"\nversion = "0.1.0"\n',
      "crates/core/src/lib.rs": "pub fn f() {}",
      "crates/app/Cargo.toml": `[package]
name = "acme-app" # the binary

[dependencies]
acme-core = { path = "../core" }
serde = "1"

[dev-dependencies]
tempfile = "3"
`,
      "crates/app/src/main.rs": "fn main() {}",
      "crates/core/target/other/Cargo.toml": '[package]\nname = "stale"\n',
      "vendor-less/Cargo.toml": "[lib]\n",
    });
    const ws = detect(root);
    expect(ws.map((w) => [w.name, w.dir, w.kind, w.deps])).toEqual([
      ["acme-app", "crates/app", "app", ["acme-core", "serde"]],
      ["acme-core", "crates/core", "package", []],
    ]);
    expect(packDependsOnEdges(rustPack, "r", root, ws).map((e) => [e.src, e.dst, e.fileId])).toEqual([
      ["ws:r:acme-app", "ws:r:acme-core", "file:r:crates/app/Cargo.toml"],
    ]);
  });

  it("finds a dependency by its crate name, with `-` and `_` the same", () => {
    const root = repo({
      "a/Cargo.toml": '[package]\nname = "my_lib"\n',
      "b/Cargo.toml": '[package]\nname = "app"\n[dependencies]\nmy-lib = { path = "../a" }\n',
    });
    expect(packDependsOnEdges(rustPack, "r", root, detect(root)).map((e) => [e.src, e.dst])).toEqual([
      ["ws:r:app", "ws:r:my_lib"],
    ]);
  });

  it("is an app when a source file that is not a test declares main", () => {
    const root = repo({
      "a/Cargo.toml": '[package]\nname = "a"\n',
      "a/src/main.rs": "pub async fn main() {}",
      "b/Cargo.toml": '[package]\nname = "b"\n',
      "b/src/lib.rs": "pub fn main_thing() {}",
      "c/Cargo.toml": '[package]\nname = "c"\n',
      "c/tests/t.rs": "fn main() {}",
    });
    expect(detect(root).map((w) => [w.name, w.kind])).toEqual([
      ["a", "app"],
      ["b", "package"],
      ["c", "package"],
    ]);
  });
});
