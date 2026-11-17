// Spike helpers: Go symbols and syntax-only call resolution with tree-sitter Go through @ast-grep/napi.
// No Go toolchain is used here; the ground truth comes from truth/main.go.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import go from "@ast-grep/lang-go";
import { parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";

registerDynamicLanguage({ go });

export type SymbolKind = "function" | "method" | "class" | "interface" | "type" | "const" | "var";
export interface GoSymbol {
  file: string;
  name: string;
  receiver?: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
}

export const GENERATED_RE = /^\/\/ Code generated .* DO NOT EDIT\.$/m;

export function parseGo(source: string): SgNode {
  return parse("go" as never, source).root();
}

export const hasError = (root: SgNode): boolean => root.find({ rule: { kind: "ERROR" } }) !== null;

const isExported = (name: string): boolean => {
  const c = name.charAt(0);
  return c !== c.toLowerCase() && c === c.toUpperCase();
};

/** Base type name of a receiver or type expression: `*S[T]` -> `S`. */
export function baseTypeName(n: SgNode | null): string {
  let cur = n;
  while (cur) {
    const k = cur.kind();
    if (k === "type_identifier" || k === "identifier") return cur.text();
    if (k === "pointer_type" || k === "parenthesized_type") cur = cur.namedChildren()[0] ?? null;
    else if (k === "generic_type") cur = cur.field("type" as never);
    else return "?";
  }
  return "?";
}

/** Repo source files (posix, relative): `git ls-files '*.go'`. */
export function listGoFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "*.go"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n")
    .filter((f) => f !== "");
}

export interface FileClass {
  sources: string[];
  tests: string[];
  vendor: string[];
  testdata: string[];
}

export function classify(files: string[]): FileClass {
  const out: FileClass = { sources: [], tests: [], vendor: [], testdata: [] };
  for (const f of files) {
    const parts = f.split("/");
    if (parts.includes("vendor")) out.vendor.push(f);
    else if (parts.includes("testdata") || parts.some((p) => p.startsWith("."))) out.testdata.push(f);
    else if (f.endsWith("_test.go")) out.tests.push(f);
    else out.sources.push(f);
  }
  return out;
}

/** Top-level symbols as the V2 plan maps them. */
export function extractSymbols(file: string, root: SgNode): GoSymbol[] {
  const out: GoSymbol[] = [];
  const line = (n: SgNode): number => n.range().start.line + 1;
  const push = (name: string, kind: SymbolKind, at: SgNode, receiver?: string): void => {
    out.push({
      file,
      name,
      kind,
      line: line(at),
      exported: isExported(name),
      ...(receiver ? { receiver } : {}),
    });
  };
  const specs = (n: SgNode, kinds: Set<string>, into: SgNode[] = []): SgNode[] => {
    for (const c of n.namedChildren()) {
      if (kinds.has(c.kind())) into.push(c);
      else if (c.kind().endsWith("_list")) specs(c, kinds, into);
    }
    return into;
  };
  for (const d of root.namedChildren()) {
    switch (d.kind()) {
      case "function_declaration": {
        const n = d.field("name" as never);
        if (n) push(n.text(), "function", d);
        break;
      }
      case "method_declaration": {
        const n = d.field("name" as never);
        const recv = d.field("receiver" as never);
        const p = recv?.namedChildren().find((c) => c.kind() === "parameter_declaration");
        if (n) push(n.text(), "method", d, baseTypeName(p?.field("type" as never) ?? null));
        break;
      }
      case "type_declaration":
        for (const s of specs(d, new Set(["type_spec", "type_alias"]))) {
          const n = s.field("name" as never);
          const t = s.field("type" as never);
          if (!n) continue;
          const k =
            s.kind() === "type_alias"
              ? "type"
              : t?.kind() === "struct_type"
                ? "class"
                : t?.kind() === "interface_type"
                  ? "interface"
                  : "type";
          push(n.text(), k, s);
        }
        break;
      case "const_declaration":
      case "var_declaration": {
        const kind = d.kind() === "const_declaration" ? "const" : "var";
        for (const s of specs(d, new Set(["const_spec", "var_spec"]))) {
          for (const n of s.fieldChildren("name" as never))
            if (n.kind() === "identifier") push(n.text(), kind, n);
        }
        break;
      }
    }
  }
  return out;
}

export function readModule(root: string): string {
  const m = /^module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"));
  if (!m?.[1]) throw new Error("no module line in go.mod");
  return m[1];
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}
