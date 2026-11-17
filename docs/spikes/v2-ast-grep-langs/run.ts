// Spike: do the ast-grep Go and Java grammar packages load on the pinned @ast-grep/napi, and parse real files?
// Usage: pnpm tsx docs/spikes/v2-ast-grep-langs/run.ts [--go <dir>] [--java <dir>]
// Deps are local to this folder (package.json here, `npm install` here); not part of the pnpm workspace.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import go from "@ast-grep/lang-go";
import java from "@ast-grep/lang-java";
import { type DynamicLangRegistrations, parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";

const require = createRequire(import.meta.url);
const version = (pkg: string): string => (require(`${pkg}/package.json`) as { version: string }).version;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    if (e === ".git" || e === "node_modules" || e === "vendor" || e === "target") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

function countErrors(n: SgNode): number {
  return n.findAll({ rule: { kind: "ERROR" } }).length;
}

const registrations = { go, java } as unknown as DynamicLangRegistrations;
registerDynamicLanguage(registrations);

// A second call: the type docs say "call exactly once". Record what happens.
let secondRegister = "ok";
try {
  registerDynamicLanguage(registrations);
} catch (e) {
  secondRegister = `throws: ${(e as Error).message}`;
}

console.log("## Versions");
for (const p of ["@ast-grep/napi", "@ast-grep/lang-go", "@ast-grep/lang-java", "@ast-grep/setup-lang"]) {
  console.log(`${p} ${version(p)}`);
}
console.log(`go libraryPath: ${(go as { libraryPath: string }).libraryPath}`);
console.log(`java libraryPath: ${(java as { libraryPath: string }).libraryPath}`);
console.log(`second registerDynamicLanguage call: ${secondRegister}`);

console.log("\n## Inline samples");
const goSrc = `package shop

import "fmt"

type Cart struct{ Items []Item }
type Store interface{ Get(id string) (Item, error) }

func (c *Cart) Total() int { return len(c.Items) }
func New() *Cart { fmt.Println("x"); return &Cart{} }
`;
const g = parse("go", goSrc).root();
console.log(
  "go",
  JSON.stringify({
    root: g.kind(),
    funcs: g.findAll({ rule: { kind: "function_declaration" } }).map((n) => n.field("name")?.text()),
    methods: g.findAll({ rule: { kind: "method_declaration" } }).map((n) => n.field("name")?.text()),
    types: g.findAll({ rule: { kind: "type_spec" } }).map((n) => n.field("name")?.text()),
    patternCalls: g.findAll("fmt.Println($$$A)").length,
    errors: countErrors(g),
  }),
);
const javaSrc = `package shop;
import java.util.List;
@RestController
@RequestMapping("/owners")
public class OwnerController {
  private final OwnerRepository owners;
  @GetMapping("/{id}") public Owner show(@PathVariable int id) { return owners.findById(id); }
  record Pair(int a, int b) {}
}
`;
const j = parse("java", javaSrc).root();
console.log(
  "java",
  JSON.stringify({
    root: j.kind(),
    classes: j.findAll({ rule: { kind: "class_declaration" } }).map((n) => n.field("name")?.text()),
    records: j.findAll({ rule: { kind: "record_declaration" } }).map((n) => n.field("name")?.text()),
    methods: j.findAll({ rule: { kind: "method_declaration" } }).map((n) => n.field("name")?.text()),
    getMappings: j.findAll('@GetMapping("$P")').map((n) => n.getMatch("P")?.text()),
    errors: countErrors(j),
  }),
);

function bulk(lang: "go" | "java", dir: string, ext: string, symbolKinds: string[]): void {
  const files = walk(dir, ext);
  const sources = files.map((f) => readFileSync(f, "utf8"));
  const bytes = sources.reduce((s, x) => s + Buffer.byteLength(x), 0);
  const runs: number[] = [];
  let errorFiles = 0;
  let symbols = 0;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    for (const s of sources) parse(lang, s);
    runs.push(performance.now() - t0);
  }
  for (const s of sources) {
    const root = parse(lang, s).root();
    if (countErrors(root) > 0) errorFiles++;
    symbols += root.findAll({ rule: { any: symbolKinds.map((kind) => ({ kind })) } }).length;
  }
  runs.sort((a, b) => a - b);
  console.log(
    `${lang}: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB, parse median ${runs[1]?.toFixed(0)} ms ` +
      `(runs ${runs.map((x) => x.toFixed(0)).join("/")}), files with ERROR nodes: ${errorFiles}, ` +
      `declarations found: ${symbols}`,
  );
}

console.log("\n## Real repositories (parse only, no symbol extraction timing)");
const goDir = arg("--go");
const javaDir = arg("--java");
if (goDir) bulk("go", goDir, ".go", ["function_declaration", "method_declaration", "type_spec"]);
if (javaDir) {
  bulk("java", javaDir, ".java", [
    "class_declaration",
    "interface_declaration",
    "record_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
  ]);
}
