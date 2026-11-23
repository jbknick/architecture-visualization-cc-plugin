import { describe, expect, it } from "vitest";
import { grammarAvailable, parseTree } from "../engine/grammar.js";
import { pythonPack } from "./index.js";

const parsePython = (source: string) => parseTree(pythonPack, source);

const SNIPPET = `import a.b as c, d
from . import e
from ..f import g as h, i
from j import *

@deco
class S(P, metaclass=M):
    n: int = 1
    def __init__(self, x: T, y=1, *args, **kw):
        self.r = R()
    async def run(self, z: "Q" = None) -> list[R]:
        for v in zs:
            v.go()
        with open(f) as fh:
            fh.read()
        m = lambda q: q.go()
        return await self.r.go()

def top(p):
    return p.go()
`;

describe("tree-sitter Python grammar", () => {
  it("loads on this platform", () => {
    expect(grammarAvailable(pythonPack)).toBe(true);
  });

  it("names the node kinds the pack relies on", () => {
    const kinds = new Set<string>();
    const walk = (n: ReturnType<typeof parsePython>): void => {
      kinds.add(n.kind());
      for (const c of n.children()) walk(c);
    };
    walk(parsePython(SNIPPET));
    for (const k of [
      "import_statement",
      "import_from_statement",
      "aliased_import",
      "dotted_name",
      "relative_import",
      "import_prefix",
      "wildcard_import",
      "class_definition",
      "function_definition",
      "decorated_definition",
      "async",
      "parameters",
      "typed_parameter",
      "default_parameter",
      "typed_default_parameter",
      "list_splat_pattern",
      "dictionary_splat_pattern",
      "lambda_parameters",
      "assignment",
      "expression_statement",
      "attribute",
      "call",
      "await",
      "for_statement",
      "as_pattern_target",
      "generic_type",
      "type_parameter",
      "type",
      "keyword_argument",
      "argument_list",
      "block",
      "string",
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it("exposes the fields the pack reads", () => {
    const root = parsePython(SNIPPET);
    const cls = root.find({ rule: { kind: "class_definition" } });
    expect(cls?.field("name")?.text()).toBe("S");
    expect(cls?.field("superclasses")?.kind()).toBe("argument_list");
    expect(cls?.field("body")?.kind()).toBe("block");
    const init = root.find({ rule: { kind: "function_definition" } });
    expect(init?.field("name")?.text()).toBe("__init__");
    expect(init?.field("parameters")?.kind()).toBe("parameters");
    const run = root.findAll({ rule: { kind: "function_definition" } })[1];
    expect(run?.field("return_type")?.kind()).toBe("type");
    expect(run?.children().some((c) => c.kind() === "async")).toBe(true);
    expect(init?.children().some((c) => c.kind() === "async")).toBe(false);
    const typed = root.find({ rule: { kind: "typed_parameter" } });
    expect(typed?.field("type")?.kind()).toBe("type");
    expect(typed?.namedChildren().map((c) => c.kind())).toEqual(["identifier", "type"]);
    const first = (kind: string) => root.find({ rule: { kind } });
    expect(first("typed_default_parameter")?.field("name")?.text()).toBe("z");
    expect(first("default_parameter")?.field("name")?.text()).toBe("y");
    const assign = root.find({ rule: { kind: "assignment" } });
    expect(assign?.field("left")?.text()).toBe("n");
    expect(assign?.field("type")?.text()).toBe("int");
    expect(assign?.field("right")?.text()).toBe("1");
    const call = root.find({ rule: { kind: "call" } });
    expect(call?.field("function")?.kind()).toBe("identifier");
    const member = root.find({ rule: { kind: "attribute" } });
    expect(member?.field("object")?.text()).toBe("self");
    expect(member?.field("attribute")?.text()).toBe("r");
    const imports = root.findAll({ rule: { kind: "import_from_statement" } });
    expect(imports.map((i) => i.field("module_name")?.kind())).toEqual([
      "relative_import",
      "relative_import",
      "dotted_name",
    ]);
    expect(imports[1]?.fieldChildren("name").map((n) => n.kind())).toEqual(["aliased_import", "dotted_name"]);
    expect(first("aliased_import")?.field("alias")?.text()).toBe("c");
    expect(first("generic_type")?.find({ rule: { kind: "type_parameter" } })).not.toBe(null);
    expect(first("for_statement")?.field("left")?.text()).toBe("v");
  });
});
