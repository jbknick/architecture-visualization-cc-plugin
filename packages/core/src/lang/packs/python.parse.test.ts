import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashStreams } from "../../hash/index.js";
import { readIni, readToml } from "../engine/config.js";
import { isExportedName, parseWithPack } from "../engine/parse.js";
import { embeddingTextWithPack, streamsWithPack } from "../engine/streams.js";
import { nameKey, packDependsOnEdges, parseManifestDeps, parseManifestName } from "../engine/workspace.js";
import { languageModule } from "../index.js";
import { pythonPack } from "./index.js";

const parse = (src: string, path = "src/acme/mod.py") => parseWithPack(pythonPack, "r", path, src);
const byName = (src: string) => new Map(parse(src).symbols.map((s) => [s.name, s]));

describe("python symbols", () => {
  const src = `import os

@decorator
def top(p, q: int = 4):
    return p.go()


async def fetch(x):
    return await x


@dataclass
class Service(Base):
    """doc"""

    count: int = 0

    def __init__(self, repo: Repo) -> None:
        self.repo = repo

    @staticmethod
    def build() -> "Service":
        return Service()

    @property
    def size(self):
        return 1

    @size.setter
    def size(self, v):
        self._size = v

    class Inner:
        def go(self):
            pass

    def _private(self):
        pass


def _helper():
    pass
`;

  it("names functions, classes, and the methods and classes in class bodies by the classes around them", () => {
    expect(parse(src).symbols.map((s) => s.id.replace(/^.*#/, ""))).toEqual([
      "top",
      "fetch",
      "Service",
      "Service.__init__",
      "Service.build",
      "Service.size",
      "Service.size~2",
      "Service.Inner",
      "Service.Inner.go",
      "Service._private",
      "_helper",
    ]);
  });

  it("maps declarations to symbol kinds; a decorator and async change nothing", () => {
    const m = byName(src);
    expect(m.get("top")?.kind).toBe("function");
    expect(m.get("fetch")?.kind).toBe("function");
    expect(m.get("Service")?.kind).toBe("class");
    expect(m.get("Service.Inner")?.kind).toBe("class");
    expect(m.get("Service.build")?.kind).toBe("method");
    expect(m.get("Service.size")?.kind).toBe("method");
  });

  it("starts a decorated definition at the definition, not at the decorator", () => {
    const m = byName(src);
    expect(m.get("top")?.startLine).toBe(4);
    expect(m.get("Service")?.startLine).toBe(13);
  });

  it("is exported unless its name starts with an underscore", () => {
    const m = byName(src);
    expect(m.get("top")?.exported).toBe(true);
    expect(m.get("Service.build")?.exported).toBe(true);
    expect(m.get("Service._private")?.exported).toBe(false);
    expect(m.get("Service.__init__")?.exported).toBe(false);
    expect(m.get("_helper")?.exported).toBe(false);
  });

  it("writes the signature as the parameters and the result written after them", () => {
    const m = byName(src);
    expect(m.get("top")?.signature).toBe("(p, q: int = 4)");
    expect(m.get("Service.__init__")?.signature).toBe("(self, repo: Repo) None");
  });

  it("measures the body of a function", () => {
    const m = byName(
      "def f(a):\n  if a > 0 and a < 9:\n    return 1\n  elif a:\n    pass\n  for i in a:\n    a += 1\n  return 0\n",
    );
    expect(m.get("f")?.complexity).toBe(5);
    expect(m.get("f")?.stmtCount).toBe(6);
  });

  it("reports a syntax error and still returns what it read", () => {
    const p = parse("def f():\n  pass\n\nclass A(:\n  pass\n\ndef g(): pass\n");
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.symbols.map((s) => s.name)).toContain("f");
  });

  it("makes no symbol of an assignment", () => {
    expect(parse("X = 1\nY: int = 2\n__all__ = ['X']\n").symbols).toEqual([]);
  });
});

describe("python imports", () => {
  it("keeps plain, aliased, from, relative and on-demand imports with what they bring in", () => {
    const p = parse(`import os, sys as system
import a.b.c
import a.b as ab
from pkg.mod import Foo, bar as baz
from . import sibling
from ..util import helper
from x import *
`);
    expect(p.imports.map((i) => [i.local, i.imported, i.specifier, i.line])).toEqual([
      ["os", "*", "os", 1],
      ["system", "*", "sys", 1],
      ["a", "*", "a", 2],
      ["ab", "*", "a.b", 3],
      ["Foo", "Foo", "pkg.mod", 4],
      ["baz", "bar", "pkg.mod", 4],
      ["sibling", "sibling", ".", 5],
      ["helper", "helper", "..util", 6],
      ["*", "*", "x", 7],
    ]);
  });

  it("finds an import under a condition or a try, and not one inside a function", () => {
    const p = parse(`try:
    import fast
except ImportError:
    import slow
if TYPE_CHECKING:
    from a import A
else:
    from b import B

def f():
    import inner
`);
    expect(p.imports.map((i) => i.specifier)).toEqual(["fast", "slow", "a", "b"]);
  });
});

describe("python generated files", () => {
  it("marks a protobuf module by its path", () => {
    expect(parse("class A: pass", "api/thing_pb2.py").directives).toEqual(["generated"]);
    expect(parse("class A: pass", "api/thing_pb2_grpc.py").directives).toEqual(["generated"]);
    expect(parse("class A: pass").directives).toBeUndefined();
  });
});

describe("python token streams", () => {
  const range = (src: string, needle: string) => {
    const start = src.indexOf(needle);
    return { start, end: start + needle.length };
  };

  it("gives the same exact hash to two functions that differ only in the names of their locals", () => {
    const a = "def total(xs):\n    s = 0\n    for x in xs:\n        s += x\n    return s";
    const b = "def total(ys):\n    acc = 0\n    for y in ys:\n        acc += y\n    return acc";
    const sa = streamsWithPack(pythonPack, `${a}\n`, range(`${a}\n`, a));
    const sb = streamsWithPack(pythonPack, `${b}\n`, range(`${b}\n`, b));
    expect(sa.exact).toContain("$1");
    expect(sa.shape).toContain("ID");
    expect(hashStreams(sa).exactHash).toBe(hashStreams(sb).exactHash);
  });

  it("separates different literals in the exact stream but not in the shape", () => {
    const a = 'def f():\n    return "a" + "b"';
    const b = 'def f():\n    return "c" + "d"';
    const sa = streamsWithPack(pythonPack, `${a}\n`, range(`${a}\n`, a));
    const sb = streamsWithPack(pythonPack, `${b}\n`, range(`${b}\n`, b));
    expect(hashStreams(sa).exactHash).not.toBe(hashStreams(sb).exactHash);
    expect(hashStreams(sa).shapeHash).toBe(hashStreams(sb).shapeHash);
  });

  it("renames locals and strings in the embedding text and drops comments", () => {
    const m = 'def greet(name):\n    # hi\n    return "hello " + name';
    expect(embeddingTextWithPack(pythonPack, `${m}\n`, range(`${m}\n`, m))).toBe(
      'def v1(v2): return "s" + v2',
    );
  });
});

describe("the exported rule", () => {
  it("is a name without a leading underscore", () => {
    expect(isExportedName(pythonPack, "name")).toBe(true);
    expect(isExportedName(pythonPack, "Name")).toBe(true);
    expect(isExportedName(pythonPack, "_name")).toBe(false);
  });
});

describe("readToml", () => {
  it("keeps the strings each key holds by its dotted path, and the keys of each table", () => {
    const t = readToml(`# a comment
title = "x"
[project]
name = "demo"  # trailing
dependencies = [
  "a>=1",   # one
  'b',
  ["nested"],
]
version = 1
flag = true

[tool.poetry.dependencies]
python = "^3.9"
foo = { path = "../foo", develop = true }
"quoted.key" = "v"

[[tool.items]]
name = "first"
multi = """
text with = and [ brackets
"""
after = "ok"
a.b.c = "dotted"
`);
    expect(t.values.get("title")).toEqual(["x"]);
    expect(t.values.get("project.name")).toEqual(["demo"]);
    expect(t.values.get("project.dependencies")).toEqual(["a>=1", "b"]);
    expect(t.values.get("project.version")).toBeUndefined();
    expect(t.values.get("tool.poetry.dependencies.python")).toEqual(["^3.9"]);
    expect(t.values.get("tool.items.name")).toEqual(["first"]);
    expect(t.values.get("tool.items.after")).toEqual(["ok"]);
    expect(t.values.get("tool.items.a.b.c")).toEqual(["dotted"]);
    expect(t.keys.get("tool.poetry.dependencies")).toEqual(["python", "foo", "quoted.key"]);
    expect(t.keys.get("project")).toEqual(["name", "dependencies", "version", "flag"]);
    expect(t.keys.get("tool")).toEqual(["poetry", "items"]);
  });
});

describe("readIni", () => {
  it("keeps the lines each key holds by section and key", () => {
    const t = readIni(`[metadata]
name = my-pkg
; a comment
# another
[options]
install_requires =
    requests>=2
    other
python_requires = >=3.9

[options.extras_require]
dev: pytest
`);
    expect(t.values.get("metadata.name")).toEqual(["my-pkg"]);
    expect(t.values.get("options.install_requires")).toEqual(["requests>=2", "other"]);
    expect(t.values.get("options.python_requires")).toEqual([">=3.9"]);
    expect(t.values.get("options.extras_require.dev")).toEqual(["pytest"]);
    expect(t.keys.get("options")).toEqual(["install_requires", "python_requires"]);
  });
});

describe("python workspaces", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files: Record<string, string>): string => {
    const root = join(mkdtempSync(join(tmpdir(), "gantry-python-")), "proj");
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const detect = (root: string) =>
    languageModule("python").detectWorkspaces(root, { workspaces: { overrides: {} } }, "r");

  it("makes a workspace of each folder with a manifest, named from `[project]`, `[tool.poetry]`, setup.cfg or setup.py", () => {
    const root = repo({
      "pyproject.toml": `[project]
name = "Core_Lib"
dependencies = ["requests>=2", "util.pkg[extra] ; python_version > '3.8'"]
`,
      "a/pyproject.toml": `[tool.poetry]
name = "app"
[tool.poetry.dependencies]
python = "^3.10"
core-lib = { path = ".." }
util-pkg = "*"
`,
      "b/setup.cfg": "[metadata]\nname = b\n[options]\ninstall_requires =\n    app>=1\n    ext\n",
      "b/main.py": "if __name__ == '__main__':\n    pass\n",
      "c/setup.py":
        "from setuptools import setup\n\nsetup(\n    name='c',\n    install_requires=['b', \"ext2>=1\"],\n)\n",
      "d/pyproject.toml": "[tool.black]\nline-length = 100\n",
      "d/setup.py": "setup(name='d')\n",
      "e/pyproject.toml": "[tool.black]\nline-length = 100\n",
      "venv/pyproject.toml": '[project]\nname = "venv"\n',
    });
    const ws = detect(root);
    expect(ws.map((w) => [w.name, w.dir, w.kind, w.deps])).toEqual([
      ["Core_Lib", ".", "package", ["requests", "util.pkg"]],
      ["app", "a", "package", ["core-lib", "python", "util-pkg"]],
      ["b", "b", "app", ["app", "ext"]],
      ["c", "c", "package", ["b", "ext2"]],
      ["d", "d", "package", []],
    ]);
    // `core-lib` is `Core_Lib`: names are compared after folding case and separators.
    expect(packDependsOnEdges(pythonPack, "r", root, ws).map((e) => [e.src, e.dst, e.fileId])).toEqual([
      ["ws:r:app", "ws:r:Core_Lib", "file:r:a/pyproject.toml"],
      ["ws:r:b", "ws:r:app", "file:r:b/setup.cfg"],
      ["ws:r:c", "ws:r:b", "file:r:c/setup.py"],
    ]);
  });

  it("reads the name and the dependencies of a manifest on their own", () => {
    const rule = pythonPack.workspace.manifests[0];
    expect(parseManifestName(pythonPack, '[project]\nname = "x"\n', rule)).toBe("x");
    expect(parseManifestName(pythonPack, "[tool.black]\nx = 1\n", rule)).toBeNull();
    expect(parseManifestDeps(pythonPack, '[project]\ndependencies = ["b>=1", "a"]\n', rule)).toEqual([
      "a",
      "b",
    ]);
  });

  it("compares names the way a distribution does", () => {
    expect(nameKey(pythonPack, "My_Pkg.core")).toBe("my-pkg-core");
    expect(nameKey(pythonPack, "my--pkg-core")).toBe("my-pkg-core");
  });
});
