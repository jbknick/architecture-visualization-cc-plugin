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

const SRC = "src/acme";

describe("python call edges on fixtures/python-basic", () => {
  let edges: Edge[];
  const find = (kind: string, src: string, dst: string): Edge[] =>
    edges.filter((e) => e.kind === kind && e.src === src && e.dst === dst);
  const has = (src: string, dst: string, conf: string, level: number): boolean =>
    find("calls", src, dst).some((e) => e.conf === conf && e.level === level);

  it("indexes the fixture", async () => {
    const fx = await materializeFixture("python-basic");
    cleanups.push(() => fx.cleanup());
    edges = await edgesOf(fx.dir);
    expect(edges.length).toBeGreaterThan(0);
  });

  it("every call edge is level 2 and high, or level 3 and low; none is level 1", () => {
    const calls = edges.filter((x) => x.kind === "calls");
    expect(calls.length).toBeGreaterThan(0);
    for (const e of calls) {
      if (e.level === 2) expect(e.conf).toBe("high");
      else {
        expect(e.level).toBe(3);
        expect(e.conf).toBe("low");
      }
    }
  });

  it("a call on a parameter with an annotation is level 2, high", () => {
    expect(has(`${SRC}/cli.py#report`, `${SRC}/store.py#Store.count`, "high", 2)).toBe(true);
    expect(has(`${SRC}/cli.py#report`, `${SRC}/models.py#Admin.revoke`, "high", 2)).toBe(true);
    expect(has(`${SRC}/service.py#Service.run`, `${SRC}/models.py#User.display`, "high", 2)).toBe(true);
  });

  it("a call on a name assigned a constructor call is level 3, low", () => {
    expect(has(`${SRC}/cli.py#main`, `${SRC}/service.py#Service.run`, "low", 3)).toBe(true);
    expect(
      has("tests/test_service.py#test_run_saves_the_user", `${SRC}/service.py#Service.run`, "low", 3),
    ).toBe(true);
  });

  it("a call on an attribute the initializer assigns, and a call on self, are level 3, low", () => {
    const s = `${SRC}/service.py`;
    expect(has(`${s}#Service.run`, `${SRC}/store.py#Store.save`, "low", 3)).toBe(true);
    expect(has(`${s}#Service.touch`, `${SRC}/store.py#Store.count`, "low", 3)).toBe(true);
    expect(has(`${s}#Service.run`, `${s}#Service.touch`, "low", 3)).toBe(true);
    // A method of the base class.
    expect(has(`${s}#Service.run`, `${SRC}/base.py#Base.audit`, "low", 3)).toBe(true);
  });

  it("a relative import names the module of the package, and a function it imports by name", () => {
    expect(has(`${SRC}/service.py#Service.run`, `${SRC}/util.py#slug`, "high", 2)).toBe(true);
    expect(has(`${SRC}/cli.py#main`, `${SRC}/util.py#slug`, "high", 2)).toBe(true);
  });

  it("a bare call to a function of the same file is level 2, high", () => {
    expect(has(`${SRC}/util.py#slug`, `${SRC}/util.py#clean`, "high", 2)).toBe(true);
  });

  it("a call on a parameter without an annotation has no edge", () => {
    expect(edges.filter((e) => e.src === `${SRC}/cli.py#describe`)).toEqual([]);
  });

  it("calling a class is a level 2, high edge to its initializer, or to the nearest base's", () => {
    const m = `${SRC}/models.py`;
    const s = `${SRC}/service.py`;
    expect(has(`${SRC}/cli.py#main`, `${s}#Service.__init__`, "high", 2)).toBe(true);
    // `Admin` declares none, so `Admin("root")` runs the one of `User`.
    expect(has(`${SRC}/cli.py#main`, `${m}#User.__init__`, "high", 2)).toBe(true);
    expect(has(`${s}#Service.__init__`, `${SRC}/store.py#Store.__init__`, "high", 2)).toBe(true);
    const test = "tests/test_service.py#test_run_saves_the_user";
    expect(has(test, `${s}#Service.__init__`, "high", 2)).toBe(true);
    expect(has(test, `${m}#User.__init__`, "high", 2)).toBe(true);
  });

  it("super() without arguments is a level 2, high edge to the method of the one base", () => {
    expect(has(`${SRC}/models.py#Admin.display`, `${SRC}/models.py#User.display`, "high", 2)).toBe(true);
  });

  it("extends comes from the class declaration, at high confidence", () => {
    const e = find("extends", `${SRC}/models.py#Admin`, `${SRC}/models.py#User`);
    expect(e.map((x) => x.conf)).toEqual(["high"]);
    expect(find("extends", `${SRC}/service.py#Service`, `${SRC}/base.py#Base`).length).toBe(1);
    expect(edges.filter((x) => x.kind === "implements")).toEqual([]);
  });

  it("skipped folders add no symbol", () => {
    expect(edges.some((e) => e.src.startsWith("build/") || e.src.startsWith(".venv/"))).toBe(false);
  });
});

describe("python calls on small repos", () => {
  const PYPROJECT = (name: string, deps: string[] = []): string =>
    `[project]\nname = "${name}"\ndependencies = [${deps.map((d) => `"${d}"`).join(", ")}]\n`;

  async function repo(files: Record<string, string>): Promise<Edge[]> {
    const fx = await materializeFiles({ "pyproject.toml": PYPROJECT("m"), ...files });
    cleanups.push(() => fx.cleanup());
    return edgesOf(fx.dir);
  }
  const callsOf = (edges: Edge[]): string[] =>
    edges
      .filter((e) => e.kind === "calls")
      .map((e) => `${e.src} -> ${e.dst} ${e.conf} ${e.level}`)
      .sort();

  it("a call on a parameter is typed by its annotation only", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass

def typed(x: A): x.go()
def bare(x): x.go()
def quoted(x: 'A'): x.go()
def union(x: A | None): x.go()
`,
    });
    expect(callsOf(edges)).toEqual([
      "a.py#quoted -> a.py#A.go high 2",
      "a.py#typed -> a.py#A.go high 2",
      "a.py#union -> a.py#A.go high 2",
    ]);
  });

  it("a name assigned a constructor call is low, level 3; an annotation is high, level 2", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass

def flow():
  a = A()
  a.go()

def declared():
  a: A = make()
  a.go()
`,
    });
    expect(callsOf(edges)).toEqual(["a.py#declared -> a.py#A.go high 2", "a.py#flow -> a.py#A.go low 3"]);
  });

  it("a name has a type only when every assignment to it in the function agrees", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass
class B:
  def go(self): pass

def f(y):
  a = A()
  a = y
  a.go()

def g(c):
  if c:
    a = A()
  else:
    a = B()
  a.go()

def h(c):
  if c:
    a = A()
  else:
    a = A()
  a.go()

def i(a: A):
  a = B()
  a.go()
`,
    });
    expect(callsOf(edges)).toEqual(["a.py#h -> a.py#A.go low 3"]);
  });

  it("a parameter, a loop variable, a comprehension variable and a nested function hide a name of the file", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass

def helper(): pass

a = A()

def f(a):
  a.go()

def g(items):
  for a in items:
    a.go()

def h(items):
  [a.go() for a in items]

def i():
  def helper(): pass
  helper()

def j(items):
  with items as a:
    a.go()
  lam = lambda a: a.go()
`,
    });
    expect(callsOf(edges)).toEqual([]);
  });

  it("a variable at the top of a file assigned a constructor call is low, level 3, unless it is assigned again", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass
class B:
  def stop(self): pass

shared = A()
twice = B()
twice = None

def f():
  shared.go()
  twice.stop()
`,
    });
    expect(callsOf(edges)).toEqual(["a.py#f -> a.py#A.go low 3"]);
  });

  it("an imported module, an imported function and a function of the file", async () => {
    const edges = await repo({
      "pkg/__init__.py": "",
      "pkg/util.py": "def one(): pass\ndef two(): pass\n",
      "pkg/use.py": `import pkg.util
import pkg.util as u
from pkg import util
from pkg.util import two as second

def own(): pass

def f():
  u.one()
  util.two()
  second()
  own()
  pkg.util.one()
  other.one()
`,
    });
    expect(callsOf(edges)).toEqual([
      "pkg/use.py#f -> pkg/use.py#own high 2",
      "pkg/use.py#f -> pkg/util.py#one high 2",
      "pkg/use.py#f -> pkg/util.py#two high 2",
    ]);
  });

  it("a variable annotated at the top of a file has that type, and a parenthesized import binds every name", async () => {
    const edges = await repo({
      "a.py": "class A:\n  def go(self): pass\n\ndef make() -> A: ...\n",
      "b.py": `from a import (
    A,
    make as build,
)

cfg: A = build()

def f():
  cfg.go()
  build().go()
`,
    });
    expect(callsOf(edges)).toEqual(["b.py#f -> a.py#A.go high 2", "b.py#f -> a.py#make high 2"]);
  });

  it("a function the file declares twice has no one meaning, and a stub next to the module does not replace it", async () => {
    const edges = await repo({
      "a.py": "def f(): pass\ndef f(): pass\ndef g(): pass\n\ndef h():\n  f()\n  g()\n",
      "b.py": "def k(): pass\n",
      "b.pyi": "def k() -> None: ...\n",
      "c.py": "from b import k\n\ndef use():\n  k()\n",
    });
    expect(callsOf(edges)).toEqual(["a.py#h -> a.py#g high 2", "c.py#use -> b.py#k high 2"]);
  });

  it("reads relative imports of every level", async () => {
    const edges = await repo({
      "src/p/__init__.py": "",
      "src/p/top.py": "def top(): pass\n",
      "src/p/sub/__init__.py": "from .leaf import leaf\n",
      "src/p/sub/leaf.py": "def leaf(): pass\n",
      "src/p/sub/use.py": `from . import leaf as mod
from .leaf import leaf
from .. import top as t
from ..top import top
from ... import nothing

def f():
  mod.leaf()
  leaf()
  t.top()
  top()
  nothing.go()
`,
    });
    expect(callsOf(edges)).toEqual([
      "src/p/sub/use.py#f -> src/p/sub/leaf.py#leaf high 2",
      "src/p/sub/use.py#f -> src/p/top.py#top high 2",
    ]);
  });

  it("an import under a condition or a try counts", async () => {
    const edges = await repo({
      "a.py": "class A:\n  def go(self): pass\n",
      "b.py": `from typing import TYPE_CHECKING
if TYPE_CHECKING:
  from a import A
try:
  import a as mod
except ImportError:
  mod = None

def f(x: A): x.go()
`,
    });
    expect(callsOf(edges)).toEqual(["b.py#f -> a.py#A.go high 2"]);
  });

  it("the type of an attribute is the type every assignment in the initializer agrees on", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass
class B:
  def go(self): pass

class Agree:
  def __init__(self, flag, x: A):
    self.one = A()
    self.two = x
    self.both = A() if flag else B()
    if flag:
      self.same = A()
    else:
      self.same = A()
    if flag:
      self.mixed = A()
    else:
      self.mixed = B()
    self.later = None

  def use(self):
    self.one.go()
    self.two.go()
    self.both.go()
    self.same.go()
    self.mixed.go()
    self.later.go()
    self.unknown.go()

  def other(self):
    self.later = A()
    self.later.go()
`,
    });
    // `one`, `two` and `same` make one edge between the same pair of symbols.
    expect(callsOf(edges)).toEqual(["a.py#Agree.use -> a.py#A.go low 3"]);
  });

  it("an attribute that only a method other than the initializer assigns has no type", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass
class H:
  def run(self):
    self.a.go()
  def set(self):
    self.a = A()
`,
    });
    expect(callsOf(edges)).toEqual([]);
  });

  it("a call on self is looked up in the class, then in its bases, and goes no further down", async () => {
    const edges = await repo({
      "a.py": `class Base:
  def hello(self): pass
  def shared(self): pass

class Mid(Base):
  def shared(self): pass

class Leaf(Mid):
  def run(self):
    self.hello()
    self.shared()
    self.missing()
    super().shared()

class Sub(Leaf):
  def hello(self): pass
`,
    });
    expect(callsOf(edges)).toEqual([
      "a.py#Leaf.run -> a.py#Base.hello low 3",
      // `super().shared()` is the same pair of symbols at level 2, which an edge of level 3 does not replace.
      "a.py#Leaf.run -> a.py#Mid.shared high 2",
    ]);
  });

  it("a method the class declares is found when a base is outside the repo, one that is not declared is not", async () => {
    const edges = await repo({
      "a.py": `from lib import Outside
class A(Outside):
  def run(self):
    self.go()
    self.go2()
  def go2(self): pass
`,
    });
    expect(callsOf(edges)).toEqual(["a.py#A.run -> a.py#A.go2 low 3"]);
  });

  it("a call through a base type is not also an edge to each method that overrides it", async () => {
    const edges = await repo({
      "a.py": `class Base:
  def go(self): pass
class Sub(Base):
  def go(self): pass

def f(x: Base): x.go()
`,
    });
    expect(callsOf(edges)).toEqual(["a.py#f -> a.py#Base.go high 2"]);
  });

  it("the result of an async function is not its declared type", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass
  def stop(self): pass

async def make() -> A: ...
def sync() -> A: ...

async def f():
  x = await make()
  x.go()
  make().go()
  sync().go()
  y = sync()
  y.stop()
`,
    });
    expect(callsOf(edges)).toEqual([
      "a.py#f -> a.py#A.go high 2",
      "a.py#f -> a.py#A.stop low 3",
      "a.py#f -> a.py#make high 2",
      "a.py#f -> a.py#sync high 2",
    ]);
  });

  it("an attribute annotated in the class body has that type, one that is only assigned has none", async () => {
    const edges = await repo({
      "a.py": `class A:
  def go(self): pass

class H:
  a: A
  b = A()
  def run(self):
    self.a.go()
    self.b.go()
    a.go()
`,
    });
    expect(callsOf(edges)).toEqual(["a.py#H.run -> a.py#A.go low 3"]);
  });

  it("a generic base is not read as a base", async () => {
    const edges = await repo({
      "a.py": `class Model:
  def go(self): pass
class Gen: pass
class H(Gen[Model]):
  def run(self):
    self.go()
`,
    });
    expect(callsOf(edges)).toEqual([]);
    expect(edges.filter((e) => e.kind === "extends")).toEqual([]);
  });

  it("two workspaces that have a module of the same name are kept apart", async () => {
    const edges = await repo({
      "pyproject.toml": "",
      "one/pyproject.toml": PYPROJECT("one"),
      "one/util.py": "def f(): pass\n",
      "one/use.py": "import util\n\ndef g():\n  util.f()\n",
      "two/pyproject.toml": PYPROJECT("two"),
      "two/util.py": "def f(): pass\n",
      "two/use.py": "import util\n\ndef g():\n  util.f()\n",
    });
    expect(callsOf(edges)).toEqual([
      "one/use.py#g -> one/util.py#f high 2",
      "two/use.py#g -> two/util.py#f high 2",
    ]);
  });

  it("a module of a workspace the caller depends on is reached, one it does not depend on is not", async () => {
    const edges = await repo({
      "pyproject.toml": "",
      "core/pyproject.toml": PYPROJECT("my_core"),
      "core/lib.py": "def f(): pass\n",
      "app/pyproject.toml": PYPROJECT("app", ["My-Core>=1"]),
      "app/use.py": "import lib\n\ndef g():\n  lib.f()\n",
      "other/pyproject.toml": PYPROJECT("other"),
      "other/use.py": "import lib\n\ndef g():\n  lib.f()\n",
    });
    expect(callsOf(edges)).toEqual(["app/use.py#g -> core/lib.py#f high 2"]);
  });

  it("every call edge in a repo of unannotated code is low, level 3", async () => {
    const edges = await repo({
      "a.py": `class A:
  def __init__(self):
    self.b = B()
  def run(self):
    self.b.go()
class B:
  def go(self): pass
`,
    });
    const calls = edges.filter((e) => e.kind === "calls");
    expect(calls.length).toBe(1);
    expect(calls.every((e) => e.conf === "low" && e.level === 3)).toBe(true);
  });

  describe("calling a class", () => {
    it("runs the initializer the class declares, else the one of its nearest base", async () => {
      const edges = await repo({
        "a.py": `class Own:
  def __init__(self): pass
  def go(self): pass
class Child(Own): pass
class Grand(Child): pass
class Over(Own):
  def __init__(self): pass

def own(): Own()
def child(): Child()
def grand(): Grand()
def over(): Over()
`,
      });
      expect(callsOf(edges)).toEqual([
        "a.py#child -> a.py#Own.__init__ high 2",
        "a.py#grand -> a.py#Own.__init__ high 2",
        "a.py#over -> a.py#Over.__init__ high 2",
        "a.py#own -> a.py#Own.__init__ high 2",
      ]);
    });

    it("finds a class by an import of its name or of its module", async () => {
      const edges = await repo({
        "a.py": "class Own:\n  def __init__(self): pass\n",
        "b.py": `import a
from a import Own as Other

def f():
  a.Own()
  Other()
`,
      });
      expect(callsOf(edges)).toEqual(["b.py#f -> a.py#Own.__init__ high 2"]);
    });

    it("keeps the call of a method on the name the call is assigned to a level 3, low edge", async () => {
      const edges = await repo({
        "a.py": `class Own:
  def __init__(self): pass
  def go(self): pass

def f():
  x = Own()
  x.go()
`,
      });
      expect(callsOf(edges)).toEqual(["a.py#f -> a.py#Own.__init__ high 2", "a.py#f -> a.py#Own.go low 3"]);
    });

    it("has no edge for a class with no initializer in a chain of the repo, or when the chain leaves the repo first", async () => {
      const edges = await repo({
        "a.py": `from lib import Outside
class Plain: pass
class Kid(Plain): pass
class Out(Outside): pass
class Deep(Out): pass
class OutOwn(Outside):
  def __init__(self): pass
class Kin(OutOwn): pass

def plain(): Plain()
def kid(): Kid()
def out(): Out()
def deep(): Deep()
def outOwn(): OutOwn()
def kin(): Kin()
def unknown(): Missing()
`,
      });
      expect(callsOf(edges)).toEqual([
        "a.py#kin -> a.py#OutOwn.__init__ high 2",
        "a.py#outOwn -> a.py#OutOwn.__init__ high 2",
      ]);
    });

    it("has no edge where several bases leave open which initializer runs", async () => {
      const edges = await repo({
        "a.py": `class One:
  def __init__(self): pass
class Two:
  def __init__(self): pass
class Both(One, Two): pass
class Both2(One, Two):
  def __init__(self): pass
class Below(Both): pass

def both(): Both()
def both2(): Both2()
def below(): Below()
`,
      });
      expect(callsOf(edges)).toEqual(["a.py#both2 -> a.py#Both2.__init__ high 2"]);
    });

    it("has no edge for a class created some other way: a keyword among its bases, a decorator, `__new__`, an enumeration", async () => {
      const edges = await repo({
        "a.py": `from enum import Enum
class Own:
  def __init__(self): pass
class Meta(Own, metaclass=type):
  def __init__(self): pass
class MetaKid(Meta): pass
@wrap
class Deco:
  def __init__(self): pass
class DecoKid(Deco): pass
class New:
  def __new__(cls): ...
  def __init__(self): pass
class NewKid(New): pass
class Color(Enum):
  def __init__(self, v): pass
class Colder(Color): pass

def meta(): Meta()
def metaKid(): MetaKid()
def deco(): Deco()
def decoKid(): DecoKid()
def new(): New()
def newKid(): NewKid()
def color(): Color()
def colder(): Colder()
`,
      });
      expect(callsOf(edges)).toEqual([]);
    });

    it("has no edge for an initializer declared twice", async () => {
      const edges = await repo({
        "a.py": `class A:
  def __init__(self): pass
  def __init__(self, x): pass

def f(): A()
`,
      });
      expect(callsOf(edges)).toEqual([]);
    });
  });

  describe("super()", () => {
    it("goes to the method the one base declares or inherits, also its initializer", async () => {
      const edges = await repo({
        "a.py": `class Base:
  def __init__(self): pass
  def go(self): pass
class Mid(Base): pass
class Leaf(Mid, metaclass=type):
  def __init__(self):
    super().__init__()
  def go(self):
    super().go()
`,
      });
      expect(callsOf(edges)).toEqual([
        "a.py#Leaf.__init__ -> a.py#Base.__init__ high 2",
        "a.py#Leaf.go -> a.py#Base.go high 2",
      ]);
    });

    it("has no edge with several bases, a base outside the repo, no base, arguments or outside a method", async () => {
      const edges = await repo({
        "a.py": `from lib import Outside
class Base:
  def go(self): pass
class Plain:
  def go(self): pass
class Two(Base, Plain):
  def go(self): super().go()
class Out(Outside):
  def go(self): super().go()
class Lonely:
  def go(self): super().go()
class Explicit(Base):
  def go(self): super(Explicit, self).go()
class Mixed(Two):
  def go(self): super().go()
class Both(Two, Base):
  def go(self): super().go()

def top(): super().go()
`,
      });
      // `Mixed` has the one base `Two`, which declares `go`: that one edge.
      expect(callsOf(edges)).toEqual(["a.py#Mixed.go -> a.py#Two.go high 2"]);
    });

    it("has no edge where the base declares the method twice, or inherits it past a class with several bases", async () => {
      const edges = await repo({
        "a.py": `class Twice:
  def go(self): pass
  def go(self, x): pass
class Base:
  def go(self): pass
class Plain: pass
class Two(Base, Plain): pass
class A(Twice):
  def go(self): super().go()
class B(Two):
  def go(self): super().go()
`,
      });
      expect(callsOf(edges)).toEqual([]);
    });
  });

  describe("overload stubs", () => {
    it("a call of a function declared with stubs reaches the declaration without the mark", async () => {
      const edges = await repo({
        "a.py": `import typing as t
from typing import overload

@overload
def f(x: int) -> int: ...
@overload
def f(x: str) -> str: ...
def f(x): return x

@t.overload
def g(x: int) -> int: ...
def g(x): return x

def use():
  f(1)
  g(1)
`,
      });
      expect(callsOf(edges)).toEqual(["a.py#use -> a.py#f~3 high 2", "a.py#use -> a.py#g~2 high 2"]);
    });

    it("a plain redefinition, stubs with no declaration, or several declarations without the mark stay no target", async () => {
      const edges = await repo({
        "a.py": `from typing import overload

def plain(): pass
def plain(): pass

@overload
def stubs(): ...
@overload
def stubs(x): ...

@overload
def mixed(): ...
def mixed(x): pass
def mixed(x, y): pass

@other
def marked(): ...
def marked(x): pass

def use():
  plain()
  stubs()
  mixed()
  marked()
`,
      });
      expect(callsOf(edges)).toEqual([]);
    });

    it("a method and an initializer with stubs resolve to the declaration; a method declared twice does not", async () => {
      const edges = await repo({
        "a.py": `from typing import overload

class C:
  @overload
  def __init__(self, a: int): ...
  @overload
  def __init__(self, a: str): ...
  def __init__(self, a): pass
  @overload
  def m(self, a: int) -> int: ...
  def m(self, a): return a
  @property
  def p(self): return 1
  @p.setter
  def p(self, v): pass

def use(c: C):
  C(1)
  c.m(1)
  c.p()
`,
      });
      expect(callsOf(edges)).toEqual([
        "a.py#use -> a.py#C.__init__~3 high 2",
        "a.py#use -> a.py#C.m~2 high 2",
      ]);
    });
  });

  describe("names re-exported by a package's __init__.py", () => {
    const MOD = `def f(): pass
def g(): pass
class Foo:
  def __init__(self): pass
  def go(self): pass
`;

    it("a name imported from the package reaches its declaration, also under another name and for a class", async () => {
      const edges = await repo({
        "pkg/__init__.py": "from .mod import f, Foo\nfrom .mod import g as h\n",
        "pkg/mod.py": MOD,
        "use.py": `from pkg import f, Foo, h

def u():
  f()
  h()
  Foo()

def v(x: Foo): x.go()
`,
      });
      expect(callsOf(edges)).toEqual([
        "use.py#u -> pkg/mod.py#Foo.__init__ high 2",
        "use.py#u -> pkg/mod.py#f high 2",
        "use.py#u -> pkg/mod.py#g high 2",
        "use.py#v -> pkg/mod.py#Foo.go high 2",
      ]);
    });

    it("follows at most three index files, and an import of an absolute path as well", async () => {
      const edges = await repo({
        "real.py": "def f(): pass\n",
        "p3/__init__.py": "from real import f\n",
        "p2/__init__.py": "from p3 import f\n",
        "p1/__init__.py": "from p2 import f\n",
        "p0/__init__.py": "from p1 import f\n",
        "three.py": "from p1 import f\n\ndef u():\n  f()\n",
        "four.py": "from p0 import f\n\ndef u():\n  f()\n",
      });
      expect(callsOf(edges)).toEqual(["three.py#u -> real.py#f high 2"]);
    });

    it("does not follow a star import, a name the index declares itself, or a name it binds twice", async () => {
      const edges = await repo({
        "pkg/__init__.py": `from .mod import *
from .mod import g
try:
  from .mod import f
except ImportError:
  from .other import f

def own(): pass
`,
        "pkg/mod.py": MOD,
        "pkg/other.py": "def f(): pass\n",
        "use.py": `from pkg import f, g, Foo, own

def u():
  f()
  g()
  Foo()
  own()
`,
      });
      expect(callsOf(edges)).toEqual([
        "use.py#u -> pkg/__init__.py#own high 2",
        "use.py#u -> pkg/mod.py#g high 2",
      ]);
    });
  });

  describe("annotations that allow no value", () => {
    it("Optional[A], A | None and None | A read as A, also in a string; a union of two classes does not", async () => {
      const edges = await repo({
        "a.py": `import typing
from typing import Optional

class A:
  def go(self): pass
class B:
  def go(self): pass

def one(x: Optional[A]): x.go()
def two(x: typing.Optional[A]): x.go()
def three(x: A | None): x.go()
def four(x: None | A): x.go()
def five(x: "A"): x.go()
def six(x: Optional["A"]): x.go()
def seven(x: "A | None"): x.go()
def eight(x: A | B): x.go()
def nine(x: Optional[A | B]): x.go()
def ten(x: typing.Union[A, None]): x.go()
def eleven(x: Optional[A, B]): x.go()
def twelve(x: None | None): x.go()
def thirteen(x: "Optional[A]"): x.go()
`,
      });
      expect(callsOf(edges)).toEqual([
        "a.py#five -> a.py#A.go high 2",
        "a.py#four -> a.py#A.go high 2",
        "a.py#one -> a.py#A.go high 2",
        "a.py#six -> a.py#A.go high 2",
        "a.py#three -> a.py#A.go high 2",
        "a.py#two -> a.py#A.go high 2",
      ]);
    });

    it("a string that names a class qualified by a module, and the result and attribute types, read the same way", async () => {
      const edges = await repo({
        "a.py": "class A:\n  def go(self): pass\n\ndef make() -> A | None: ...\n",
        "b.py": `import a
from typing import Optional

def f(x: "a.A"): x.go()
def g(): a.make().go()

class H:
  def __init__(self):
    self.item: Optional[a.A] = None
  def run(self):
    self.item.go()
`,
      });
      expect(callsOf(edges)).toEqual([
        "b.py#H.run -> a.py#A.go low 3",
        "b.py#f -> a.py#A.go high 2",
        "b.py#g -> a.py#A.go high 2",
        "b.py#g -> a.py#make high 2",
      ]);
    });
  });
});
