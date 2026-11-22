import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { GantryConfig } from "../config/index.js";
import { isIndexable } from "../discover/index.js";
import { type ParsedFile, parseSource } from "../parse/index.js";
import type { WorkspaceRecord } from "../types.js";
import { detectWorkspaces } from "../workspace/index.js";
import { createResolver, dependsOnEdges } from "./index.js";
import { readTsconfigChain } from "./tsconfigChain.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");
const config = { exclude: [] } as unknown as GantryConfig; // isIndexable only reads `exclude`
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gantry-resolve-"));
  tmp.push(d);
  return d;
}

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

function load(root: string, workspaces: WorkspaceRecord[], extra: Record<string, string> = {}) {
  const parsed = new Map<string, ParsedFile>();
  for (const rel of walk(root)) {
    if (!isIndexable(rel, config)) continue;
    const pf = parseSource("repo", rel, readFileSync(join(root, rel), "utf8"));
    parsed.set(pf.fileId, pf);
  }
  for (const [rel, src] of Object.entries(extra)) {
    const pf = parseSource("repo", rel, src);
    parsed.set(pf.fileId, pf);
  }
  return { root, repo: "repo", workspaces, parsed };
}

function fixture(name: string, extra: Record<string, string> = {}) {
  const dir = mkTmp();
  cpSync(join(fixturesRoot, name), dir, { recursive: true });
  const workspaces = detectWorkspaces(dir, { workspaces: { overrides: {} } }, "repo");
  return { dir, ...load(dir, workspaces, extra) };
}

/** Build a repo from text files; parse every indexable one. */
function repo(files: Record<string, string>) {
  const dir = mkTmp();
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  const workspaces = detectWorkspaces(dir, { workspaces: { overrides: {} } }, "repo");
  return load(dir, workspaces);
}

describe("pnpm-turbo fixture", () => {
  test("a page importing Button through the @acme/ui barrel gets a renders edge to the original", () => {
    const rel = "apps/web/src/routes/barrel.tsx";
    const ctx = fixture("pnpm-turbo", {
      [rel]: `import { Button } from "@acme/ui";\nexport function Page() {\n  return <Button label="x" />;\n}\n`,
    });
    const r = createResolver(ctx);
    expect(r.resolveSpecifier(`file:repo:${rel}`, "@acme/ui")).toEqual({
      kind: "file",
      fileId: "file:repo:packages/ui/src/index.ts",
    });
    expect(r.resolveSymbol("file:repo:packages/ui/src/index.ts", "Button")).toBe(
      "sym:repo:packages/ui/src/button.tsx#Button",
    );
    const edges = r.edgesForFile(`file:repo:${rel}`);
    expect(edges).toContainEqual({
      src: `sym:repo:${rel}#Page`,
      dst: "sym:repo:packages/ui/src/button.tsx#Button",
      kind: "renders",
      confidence: "high",
      count: 1,
      evidence: [`${rel}:3`],
      fileId: `file:repo:${rel}`,
    });
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: `file:repo:${rel}`,
        dst: "file:repo:packages/ui/src/index.ts",
        kind: "imports",
        count: 1,
      }),
    );
  });

  test("subpath export and the real index route resolve", () => {
    const ctx = fixture("pnpm-turbo");
    const r = createResolver(ctx);
    const idx = "file:repo:apps/web/src/routes/index.tsx";
    expect(r.resolveSpecifier(idx, "@acme/ui/button")).toEqual({
      kind: "file",
      fileId: "file:repo:packages/ui/src/button.tsx",
    });
    // internal.ts is not in the exports map, so it is not reachable through the package name.
    expect(r.resolveSpecifier(idx, "@acme/ui/internal")).toEqual({ kind: "unresolved" });
    const edges = r.edgesForFile(idx);
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "sym:repo:apps/web/src/routes/index.tsx#HomePage",
        dst: "sym:repo:packages/ui/src/button.tsx#Button",
        kind: "renders",
        confidence: "high",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "sym:repo:apps/web/src/routes/index.tsx#HomePage",
        dst: "sym:repo:apps/web/src/components/PostList.tsx#PostList",
        kind: "renders",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ dst: "ext:@tanstack/react-router", kind: "imports" }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ src: "ws:repo:@acme/web", dst: idx, kind: "contains" }),
    );
  });

  test("hooks and local calls resolve; edges are sorted and deterministic", () => {
    const ctx = fixture("pnpm-turbo");
    const r = createResolver(ctx);
    const list = "file:repo:apps/web/src/components/PostList.tsx";
    const edges = r.edgesForFile(list);
    expect(edges).toContainEqual(
      expect.objectContaining({
        dst: "sym:repo:apps/web/src/hooks/useDebounce.ts#useDebounce",
        kind: "uses_hook",
        confidence: "high",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ dst: "sym:repo:apps/web/src/lib/slug.ts#slugify", kind: "calls" }),
    );
    const keys = edges.map((e) => `${e.src}\0${e.dst}\0${e.kind}`);
    expect(keys).toEqual([...keys].sort());
    expect(createResolver(ctx).edgesForFile(list)).toEqual(edges);
  });

  test("depends_on edges match package.json for every workspace", () => {
    const ctx = fixture("pnpm-turbo");
    const edges = createResolver(ctx).workspaceEdges();
    const expected: string[] = [];
    for (const w of ctx.workspaces) {
      const pkgPath = join(ctx.dir, w.dir === "." ? "" : w.dir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      const deps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]);
      for (const other of ctx.workspaces) {
        if (other.dir !== "." && deps.has(other.name)) expected.push(`${w.id}>${other.id}`);
      }
    }
    expect(edges.map((e) => `${e.src}>${e.dst}`).sort()).toEqual(expected.sort());
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.kind === "depends_on")).toBe(true);
    const keys = edges.map((e) => e.src + e.dst);
    expect(keys).toEqual([...keys].sort());
    expect(dependsOnEdges("repo", ctx.workspaces)).toEqual(edges);
  });

  test("contains and exports edges for a file", () => {
    const ctx = fixture("pnpm-turbo");
    const edges = createResolver(ctx).edgesForFile("file:repo:packages/ui/src/button.tsx");
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "ws:repo:@acme/ui",
        dst: "file:repo:packages/ui/src/button.tsx",
        kind: "contains",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "file:repo:packages/ui/src/button.tsx",
        dst: "sym:repo:packages/ui/src/button.tsx#Button",
        kind: "contains",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "file:repo:packages/ui/src/button.tsx",
        dst: "sym:repo:packages/ui/src/button.tsx#Button",
        kind: "exports",
      }),
    );
  });

  test("barrel exports edges point at the resolved originals", () => {
    const ctx = fixture("pnpm-turbo");
    const edges = createResolver(ctx).edgesForFile("file:repo:packages/ui/src/index.ts");
    expect(edges.filter((e) => e.kind === "exports").map((e) => e.dst)).toEqual([
      "sym:repo:packages/ui/src/button.tsx#Button",
      "sym:repo:packages/ui/src/card.tsx#Card",
    ]);
    expect(edges.filter((e) => e.kind === "imports").map((e) => e.dst)).toEqual([
      "file:repo:packages/ui/src/button.tsx",
      "file:repo:packages/ui/src/card.tsx",
    ]);
  });
});

describe("single-pkg fixture", () => {
  test("path alias @/x resolves via the nearest tsconfig", () => {
    const ctx = fixture("single-pkg");
    const r = createResolver(ctx);
    const main = "file:repo:src/main.ts";
    expect(r.resolveSpecifier(main, "@/greet")).toEqual({ kind: "file", fileId: "file:repo:src/greet.ts" });
    expect(r.resolveSpecifier(main, "@/index")).toEqual({ kind: "file", fileId: "file:repo:src/index.ts" });
    expect(r.resolveSymbol("file:repo:src/index.ts", "Counter")).toBe("sym:repo:src/counter.ts#Counter");
    expect(r.resolveSymbol("file:repo:src/index.ts", "greet")).toMatch(/^sym:repo:src\/greet\.ts#/);
  });

  test("alias target in a generated file is classified generated, not unresolved", () => {
    const ctx = fixture("single-pkg");
    const r = createResolver(ctx);
    expect(r.resolveSpecifier("file:repo:src/main.ts", "@/gen/api.gen")).toEqual({ kind: "unresolved" });
    const st = r.stats();
    expect(st.counts.generated).toBe(1);
    expect(st.counts.unresolved).toBe(0);
  });
});

describe("symbol resolution", () => {
  test("export *, export { x as y } from, default, namespace and imported-then-exported", () => {
    const ctx = repo({
      "package.json": JSON.stringify({ name: "r" }),
      "tsconfig.json": "{}",
      "a.ts": `export function foo() {}\nexport default function main() {}\nexport const k = 1;`,
      "b.ts": `export * from "./a";\nexport { foo as bar } from "./a";\nexport { default as dflt } from "./a";\nexport * as nsA from "./a";`,
      "c.ts": `import { foo } from "./a";\nimport * as ns from "./a";\nexport { foo as again };\nexport { ns };\nexport * from "./b";`,
    });
    const r = createResolver(ctx);
    expect(r.resolveSymbol("file:repo:b.ts", "foo")).toBe("sym:repo:a.ts#foo");
    expect(r.resolveSymbol("file:repo:b.ts", "bar")).toBe("sym:repo:a.ts#foo");
    expect(r.resolveSymbol("file:repo:b.ts", "dflt")).toBe("sym:repo:a.ts#main");
    expect(r.resolveSymbol("file:repo:b.ts", "nsA")).toBeNull();
    expect(r.resolveSymbol("file:repo:c.ts", "again")).toBe("sym:repo:a.ts#foo");
    expect(r.resolveSymbol("file:repo:c.ts", "k")).toBe("sym:repo:a.ts#k");
    expect(r.resolveSymbol("file:repo:c.ts", "missing")).toBeNull();
    expect(r.resolveSymbol("file:repo:nope.ts", "x")).toBeNull();
    const exportsOfB = r
      .edgesForFile("file:repo:b.ts")
      .filter((e) => e.kind === "exports")
      .map((e) => e.dst);
    expect(exportsOfB).toEqual(["sym:repo:a.ts#foo", "sym:repo:a.ts#k", "sym:repo:a.ts#main"]);
  });

  test("re-export cycles terminate (star cycles, self re-export, long chains)", () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "cyc" }),
      "a.ts": `export * from "./b";\nexport { x } from "./b";`,
      "b.ts": `export * from "./a";\nexport { x } from "./a";`,
      "self.ts": `export { y } from "./self";\nexport * from "./self";`,
    };
    for (let i = 0; i < 15; i++) files[`c${i}.ts`] = `export { z } from "./c${i + 1}";`;
    files["c15.ts"] = "export const z = 1;";
    const r = createResolver(repo(files));
    expect(r.resolveSymbol("file:repo:a.ts", "x")).toBeNull();
    expect(r.resolveSymbol("file:repo:b.ts", "nothing")).toBeNull();
    expect(r.resolveSymbol("file:repo:self.ts", "y")).toBeNull();
    expect(r.edgesForFile("file:repo:a.ts").filter((e) => e.kind === "exports")).toEqual([]);
    expect(r.edgesForFile("file:repo:self.ts").filter((e) => e.kind === "exports")).toEqual([]);
    // depth is capped at 10 hops
    expect(r.resolveSymbol("file:repo:c14.ts", "z")).toBe("sym:repo:c15.ts#z");
    expect(r.resolveSymbol("file:repo:c0.ts", "z")).toBeNull();
  });
});

describe("site edges", () => {
  const files = {
    "package.json": JSON.stringify({ name: "sites" }),
    "tsconfig.json": "{}",
    "lib.ts": "export function helper() {}\nexport class Base {}\nexport interface Shape {}",
    "main.ts": `import { helper, Base, type Shape } from "./lib";
import * as lib from "./lib";
function local() { helper(); lib.helper(); }
export function run() { local(); local(); helper(); }
export class Child extends Base implements Shape {
  one() { this.two(); }
  two() { this.one(); }
  three() { thing.two(); thing.nope(); }
}
export const x: Shape = null as never;
`,
  };

  test("imported, namespace, local, extends/implements and low-confidence methods", () => {
    const r = createResolver(repo(files));
    const edges = r.edgesForFile("file:repo:main.ts");
    const find = (src: string, dst: string, kind: string) =>
      edges.find((e) => e.src === src && e.dst === dst && e.kind === kind);
    expect(find("sym:repo:main.ts#local", "sym:repo:lib.ts#helper", "calls")).toMatchObject({
      count: 2,
      confidence: "high",
      evidence: ["main.ts:3"],
    });
    expect(find("sym:repo:main.ts#run", "sym:repo:main.ts#local", "calls")).toMatchObject({
      count: 2,
      confidence: "high",
      evidence: ["main.ts:4"],
    });
    expect(find("sym:repo:main.ts#run", "sym:repo:lib.ts#helper", "calls")?.count).toBe(1);
    expect(find("sym:repo:main.ts#Child", "sym:repo:lib.ts#Base", "extends")).toBeDefined();
    expect(find("sym:repo:main.ts#Child", "sym:repo:lib.ts#Shape", "implements")).toBeDefined();
    expect(edges.some((e) => e.kind === "references_type" && e.dst === "sym:repo:lib.ts#Shape")).toBe(true);
    // this.two() and thing.two(): exactly one method named `two` in the file => low
    expect(find("sym:repo:main.ts#Child.one", "sym:repo:main.ts#Child.two", "calls")).toMatchObject({
      confidence: "low",
    });
    expect(find("sym:repo:main.ts#Child.three", "sym:repo:main.ts#Child.two", "calls")).toMatchObject({
      confidence: "low",
    });
    // no method called `nope` => skipped
    expect(edges.some((e) => e.dst.endsWith("nope"))).toBe(false);
  });

  test("ambiguous method names produce no edge; unresolvable imports produce none", () => {
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "amb" }),
        "m.ts": `import { missing } from "./gone";\nclass A { go() {} }\nclass B { go() {} }\nexport function f(o: A) { o.go(); missing(); }`,
      }),
    );
    expect(r.edgesForFile("file:repo:m.ts").filter((e) => e.kind === "calls")).toEqual([]);
    expect(r.stats().counts.unresolved).toBe(0 + 1);
  });

  test("evidence is capped at 20 and count keeps counting", () => {
    const calls = Array.from({ length: 25 }, () => "helper();").join("\n");
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "ev" }),
        "lib.ts": "export function helper() {}",
        "m.ts": `import { helper } from "./lib";\nexport function f() {\n${calls}\n}`,
      }),
    );
    const e = r.edgesForFile("file:repo:m.ts").find((x) => x.kind === "calls");
    expect(e?.count).toBe(25);
    expect(e?.evidence).toEqual(Array.from({ length: 20 }, (_, i) => `m.ts:${i + 3}`));
  });

  test("imports edge counts bindings and merges side-effect and dynamic imports", () => {
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "imp", dependencies: { hono: "1" } }),
        "lib.ts": "export const a = 1; export const b = 2;",
        "m.ts": `import { a, b } from "./lib";\nimport "./lib";\nconst l = () => import("./lib");\nimport { Hono } from "hono";\nimport fs from "node:fs";\nimport x from "cloudflare:workers";`,
      }),
    );
    const imports = r.edgesForFile("file:repo:m.ts").filter((e) => e.kind === "imports");
    expect(imports.map((e) => [e.dst, e.count])).toEqual([
      ["ext:hono", 1],
      ["file:repo:lib.ts", 4],
    ]);
    expect(r.stats().counts).toMatchObject({ builtin: 1, virtual: 1, external: 1, file: 1, unresolved: 0 });
  });
});

describe("classification", () => {
  test("unresolved specifiers are counted and listed, never thrown", () => {
    const r = createResolver(repo({ "package.json": JSON.stringify({ name: "u" }), "m.ts": "export {};" }));
    expect(r.resolveSpecifier("file:repo:m.ts", "./nope")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:repo:m.ts", "not-declared-pkg")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:repo:m.ts", "../../outside")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:repo:m.ts", "@/")).toEqual({ kind: "unresolved" });
    const st = r.stats();
    expect(st.counts.unresolved).toBe(4);
    expect(st.unresolved.map((u) => u.specifier).sort()).toEqual([
      "../../outside",
      "./nope",
      "@/",
      "not-declared-pkg",
    ]);
  });

  test("node builtins, bare builtins and scheme specifiers are not failures", () => {
    const r = createResolver(repo({ "package.json": "{}", "m.ts": "export {};" }));
    expect(r.resolveSpecifier("file:repo:m.ts", "node:path")).toEqual({ kind: "external", pkg: "node:path" });
    expect(r.resolveSpecifier("file:repo:m.ts", "fs")).toEqual({ kind: "external", pkg: "fs" });
    expect(r.resolveSpecifier("file:repo:m.ts", "virtual:uno.css")).toEqual({
      kind: "external",
      pkg: "virtual:uno.css",
    });
    expect(r.resolveSpecifier("file:repo:m.ts", "bun:test")).toEqual({ kind: "external", pkg: "bun:test" });
    const st = r.stats();
    expect(st.counts).toMatchObject({ builtin: 2, virtual: 2, unresolved: 0 });
    expect(st.unresolved).toEqual([]);
  });

  test("generated and excluded targets are counted separately", () => {
    const r = createResolver(
      repo({
        "package.json": "{}",
        "tsconfig.json": "{}",
        "m.ts": "export {};",
        "routeTree.gen.ts": "export const t = 1;",
        "plain.js": "export const j = 1;",
      }),
    );
    // present on disk but not in the parsed set (excluded by discovery)
    expect(r.resolveSpecifier("file:repo:m.ts", "./routeTree.gen")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:repo:m.ts", "./plain")).toEqual({ kind: "unresolved" });
    // absent on disk but matching a built-in exclude (untracked codegen / build output)
    expect(r.resolveSpecifier("file:repo:m.ts", "./client.gen")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:repo:m.ts", "./dist/out.js")).toEqual({ kind: "unresolved" });
    const st = r.stats();
    expect(st.counts.generated).toBe(3);
    expect(st.counts.excluded).toBe(1);
    expect(st.counts.unresolved).toBe(0);
    expect(st.unresolved.filter((u) => u.class === "generated")).toHaveLength(3);
  });

  test("types-only package: @types/<name> without a declared dep is external", () => {
    const dir = mkTmp();
    mkdirSync(join(dir, "node_modules/@types/hast"), { recursive: true });
    mkdirSync(join(dir, "node_modules/@types/scope__pkg"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "m.ts"), "export {};");
    const ws = detectWorkspaces(dir, { workspaces: { overrides: {} } }, "repo");
    const r = createResolver(load(dir, ws));
    expect(r.resolveSpecifier("file:repo:m.ts", "hast")).toEqual({ kind: "external", pkg: "hast" });
    expect(r.resolveSpecifier("file:repo:m.ts", "@scope/pkg/sub")).toEqual({
      kind: "external",
      pkg: "@scope/pkg",
    });
    expect(r.resolveSpecifier("file:repo:m.ts", "mdast")).toEqual({ kind: "unresolved" });
  });

  test("installed npm packages classify external with the package name (scoped and subpath)", () => {
    const dir = mkTmp();
    mkdirSync(join(dir, "node_modules/@s/p/sub"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/@s/p/package.json"),
      JSON.stringify({ name: "@s/p", version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(join(dir, "node_modules/@s/p/index.js"), "");
    writeFileSync(join(dir, "node_modules/@s/p/sub/index.js"), "");
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "m.ts"), "export {};");
    const ws = detectWorkspaces(dir, { workspaces: { overrides: {} } }, "repo");
    const r = createResolver(load(dir, ws));
    expect(r.resolveSpecifier("file:repo:m.ts", "@s/p")).toEqual({ kind: "external", pkg: "@s/p" });
    expect(r.resolveSpecifier("file:repo:m.ts", "@s/p/sub")).toEqual({ kind: "external", pkg: "@s/p" });
  });

  test("extensionAlias: ./x.js resolves to x.ts", () => {
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "esm", type: "module" }),
        "tsconfig.json": "{}",
        "x.ts": "export const x = 1;",
        "m.ts": `import { x } from "./x.js";`,
      }),
    );
    expect(r.resolveSpecifier("file:repo:m.ts", "./x.js")).toEqual({
      kind: "file",
      fileId: "file:repo:x.ts",
    });
  });

  test("a symlinked repo root is realpath'd (files are not classified as outside the repo)", () => {
    const real = mkTmp();
    writeFileSync(join(real, "package.json"), "{}");
    writeFileSync(join(real, "tsconfig.json"), "{}");
    writeFileSync(join(real, "a.ts"), "export const a = 1;");
    writeFileSync(join(real, "m.ts"), `import { a } from "./a";`);
    const link = join(mkTmp(), "link");
    symlinkSync(real, link);
    const ws = detectWorkspaces(real, { workspaces: { overrides: {} } }, "repo");
    const ctx = load(real, ws);
    const r = createResolver({ ...ctx, root: link });
    expect(r.resolveSpecifier("file:repo:m.ts", "./a")).toEqual({ kind: "file", fileId: "file:repo:a.ts" });
  });

  test("self-import is not an edge and unknown files yield no edges", () => {
    const r = createResolver(
      repo({ "package.json": "{}", "m.ts": `import { m } from "./m";\nexport const m = 1;` }),
    );
    expect(r.edgesForFile("file:repo:m.ts").filter((e) => e.kind === "imports")).toEqual([]);
    expect(r.edgesForFile("file:repo:unknown.ts")).toEqual([]);
  });

  test("workspace fallback without an exports map uses main/types and subpaths", () => {
    const ctx = repo({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/a/package.json": JSON.stringify({ name: "@w/a", main: "./dist/index.js" }),
      "packages/a/src/index.ts": "export const A = 1;",
      "packages/a/src/util.ts": "export const U = 1;",
      "packages/b/package.json": JSON.stringify({ name: "@w/b", dependencies: { "@w/a": "workspace:*" } }),
      "packages/b/src/m.ts": "export {};",
    });
    const r = createResolver(ctx);
    const from = "file:repo:packages/b/src/m.ts";
    expect(r.resolveSpecifier(from, "@w/a")).toEqual({
      kind: "file",
      fileId: "file:repo:packages/a/src/index.ts",
    });
    expect(r.resolveSpecifier(from, "@w/a/util")).toEqual({
      kind: "file",
      fileId: "file:repo:packages/a/src/util.ts",
    });
    expect(r.workspaceEdges().map((e) => `${e.src}>${e.dst}`)).toEqual(["ws:repo:@w/b>ws:repo:@w/a"]);
  });
});

describe("bundler aliases", () => {
  const file = (rel: string) => `file:repo:${rel}`;

  test("every alias form of the bundler-aliases fixture resolves to its source file", () => {
    const r = createResolver(fixture("bundler-aliases"));
    const cases: [string, string, string][] = [
      ["apps/vite-app/src/main.ts", "@/components/Button", "apps/vite-app/src/components/Button.tsx"],
      ["apps/vite-app/src/main.ts", "@/lib/format", "apps/vite-app/src/lib/format.ts"],
      ["apps/vite-app/src/main.ts", "~ui", "packages/ui/src/index.ts"],
      ["apps/vite-app/src/main.ts", "~ui/card", "packages/ui/src/card.ts"],
      ["apps/vite-array/src/main.ts", "#lib/math", "apps/vite-array/src/lib/math.ts"],
      ["apps/vite-array/src/main.ts", "#lib/range", "apps/vite-array/src/lib/range.ts"],
      ["apps/webpack-app/src/index.ts", "@app/util/text", "apps/webpack-app/src/util/text.ts"],
      ["apps/webpack-app/src/index.ts", "components", "apps/webpack-app/src/components/index.ts"],
    ];
    for (const [from, spec, to] of cases) {
      expect(r.resolveSpecifier(file(from), spec)).toEqual({ kind: "file", fileId: file(to) });
    }
    expect(r.stats().unresolved.filter((u) => !u.fromFileId.includes("apps/dynamic/"))).toEqual([]);
  });

  test("a webpack key ending in $ matches the exact specifier only", () => {
    const r = createResolver(fixture("bundler-aliases"));
    expect(r.resolveSpecifier(file("apps/webpack-app/src/index.ts"), "components/other")).toEqual({
      kind: "unresolved",
    });
  });

  test("a computed alias value is unresolved with reason alias_not_static", () => {
    const r = createResolver(fixture("bundler-aliases"));
    const from = file("apps/dynamic/src/main.ts");
    expect(r.resolveSpecifier(from, "@dyn/one")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier(from, "@dyn/two")).toEqual({ kind: "unresolved" });
    expect(r.stats().unresolved).toEqual([
      {
        fromFileId: from,
        specifier: "@dyn/one",
        class: "unresolved",
        reason: "alias_not_static",
        alias: "*",
      },
      {
        fromFileId: from,
        specifier: "@dyn/two",
        class: "unresolved",
        reason: "alias_not_static",
        alias: "*",
      },
    ]);
  });

  test("one unreadable key only marks specifiers that start with it", () => {
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "root", devDependencies: { vite: "1" } }),
        "vite.config.ts": `export default { resolve: { alias: { "@ok": "/src/ok", "@dyn": compute() } } };`,
        "src/ok.ts": "export const ok = 1;",
        "src/m.ts": `import { ok } from "@ok";\nimport { x } from "@dyn/x";\nimport { y } from "@other/y";\n`,
      }),
    );
    const from = file("src/m.ts");
    expect(r.resolveSpecifier(from, "@ok")).toEqual({ kind: "file", fileId: file("src/ok.ts") });
    r.resolveSpecifier(from, "@dyn/x");
    r.resolveSpecifier(from, "@other/y");
    expect(r.stats().unresolved).toEqual([
      {
        fromFileId: from,
        specifier: "@dyn/x",
        class: "unresolved",
        reason: "alias_not_static",
        alias: "@dyn",
      },
      { fromFileId: from, specifier: "@other/y", class: "unresolved" },
    ]);
  });

  test("other config shapes and path forms are read", () => {
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "root" }),
        "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
        "apps/a/package.json": JSON.stringify({ name: "a" }),
        "apps/a/vite.config.js": `import path from "node:path";
export default ({ mode }) => {
  const base = 1;
  return { resolve: { alias: { "@t": \`\${__dirname}/tpl\`, "@m": path.join(import.meta.dirname, "meta"), "@c": path.resolve(process.cwd(), "cwd") } } };
};`,
        "apps/a/tpl/x.ts": "export const x = 1;",
        "apps/a/meta/x.ts": "export const x = 1;",
        "apps/a/cwd/x.ts": "export const x = 1;",
        "apps/a/src/m.ts": "export {};",
        "apps/b/package.json": JSON.stringify({ name: "b" }),
        "apps/b/webpack.config.cjs": `module.exports = { resolve: { alias: { w: require("path").resolve(__dirname, "w") } } };`,
        "apps/b/w/x.ts": "export const x = 1;",
        "apps/b/src/m.ts": "export {};",
      }),
    );
    const a = file("apps/a/src/m.ts");
    expect(r.resolveSpecifier(a, "@t/x")).toEqual({ kind: "file", fileId: file("apps/a/tpl/x.ts") });
    expect(r.resolveSpecifier(a, "@m/x")).toEqual({ kind: "file", fileId: file("apps/a/meta/x.ts") });
    expect(r.resolveSpecifier(a, "@c/x")).toEqual({ kind: "file", fileId: file("apps/a/cwd/x.ts") });
    // `require("path").resolve(...)` is not one of the accepted forms.
    expect(r.resolveSpecifier(file("apps/b/src/m.ts"), "w/x")).toEqual({ kind: "unresolved" });
  });

  test("an alias wins over tsconfig paths", () => {
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "root" }),
        "tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["other/*"] } },
        }),
        "vite.config.ts": `export default { resolve: { alias: { "@": "/src" } } };`,
        "src/a/x.ts": "export const x = 1;",
        "other/a/x.ts": "export const x = 2;",
        "src/m.ts": "export {};",
      }),
    );
    expect(r.resolveSpecifier(file("src/m.ts"), "@/a/x")).toEqual({
      kind: "file",
      fileId: file("src/a/x.ts"),
    });
  });

  test("an unreadable key marks its own specifier and subpaths, and a $ key only the exact one", () => {
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "root" }),
        "vite.config.ts": `export default { resolve: { alias: { "@dyn": compute(), exact$: compute() } } };`,
        "src/m.ts": "export {};",
      }),
    );
    const from = file("src/m.ts");
    for (const spec of ["@dyn", "@dyn/x", "@dynamo/x", "exact", "exact/x"]) r.resolveSpecifier(from, spec);
    expect(r.stats().unresolved.map((u) => [u.specifier, u.reason, u.alias])).toEqual([
      ["@dyn", "alias_not_static", "@dyn"],
      ["@dyn/x", "alias_not_static", "@dyn"],
      ["@dynamo/x", undefined, undefined],
      ["exact", "alias_not_static", "exact$"],
      ["exact/x", undefined, undefined],
    ]);
  });

  test("a config with a top-level side effect is never run", () => {
    const dir = mkTmp();
    const marker = join(dir, "ran.txt");
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "root" }),
        "vite.config.ts": `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker)}, "ran");
export default { resolve: { alias: { "@": "/src" } } };`,
        "webpack.config.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");
module.exports = { resolve: { alias: { "~": __dirname + "/src" } } };`,
        "src/a.ts": "export const a = 1;",
        "src/m.ts": "export {};",
      }),
    );
    expect(r.resolveSpecifier(file("src/m.ts"), "@/a")).toEqual({ kind: "file", fileId: file("src/a.ts") });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("workspace package output mapped to source", () => {
  const files = (pkg: Record<string, unknown>, tsconfig: Record<string, unknown>, src: string) => ({
    "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "packages/lib/package.json": JSON.stringify({ name: "@t/lib", ...pkg }),
    "packages/lib/tsconfig.json": JSON.stringify({ compilerOptions: tsconfig.compilerOptions, ...tsconfig }),
    [`packages/lib/${src}`]: "export const x = 1;",
    "app.ts": "import { x } from '@t/lib';",
  });
  const hit = (f: Record<string, string>) =>
    createResolver(repo(f)).resolveSpecifier("file:repo:app.ts", "@t/lib");

  test("outDir dist with rootDir lib maps dist/index.js to lib/index.ts", () => {
    const f = files(
      { main: "dist/index.js" },
      { compilerOptions: { outDir: "dist", rootDir: "lib" } },
      "lib/index.ts",
    );
    expect(hit(f)).toEqual({ kind: "file", fileId: "file:repo:packages/lib/lib/index.ts" });
  });

  test("rootDir . with include src maps dist/src/index.js to src/index.ts", () => {
    const f = files(
      { main: "dist/src/index.js" },
      { compilerOptions: { outDir: "dist", rootDir: "." }, include: ["src"] },
      "src/index.ts",
    );
    expect(hit(f)).toEqual({ kind: "file", fileId: "file:repo:packages/lib/src/index.ts" });
  });

  test("without rootDir the root is the common directory of include", () => {
    const f = files(
      { main: "dist/index.js" },
      { compilerOptions: { outDir: "dist" }, include: ["src/**/*"] },
      "src/index.ts",
    );
    expect(hit(f)).toEqual({ kind: "file", fileId: "file:repo:packages/lib/src/index.ts" });
  });

  test("a custom outDir such as types maps a .d.ts target to source", () => {
    const f = files(
      { types: "types/index.d.ts" },
      { compilerOptions: { outDir: "types", rootDir: "src" } },
      "src/index.ts",
    );
    expect(hit(f)).toEqual({ kind: "file", fileId: "file:repo:packages/lib/src/index.ts" });
  });

  test("names dist, build, out and lib map to src only without an outDir", () => {
    const withOut = files(
      { main: "build/x.js" },
      { compilerOptions: { outDir: "elsewhere", rootDir: "src" } },
      "src/x.ts",
    );
    expect(hit(withOut)).toEqual({ kind: "unresolved" });
    const without = files({ main: "build/x.js" }, { compilerOptions: {} }, "src/x.ts");
    expect(hit(without)).toEqual({ kind: "file", fileId: "file:repo:packages/lib/src/x.ts" });
  });
});

describe("tsconfig extends through a workspace package", () => {
  const page = "file:repo:apps/web/src/app/page.ts";
  const admin = "file:repo:apps/admin/src/main.ts";
  const format = { kind: "file", fileId: "file:repo:apps/web/src/lib/format.ts" };
  const date = { kind: "file", fileId: "file:repo:packages/shared/src/date.ts" };
  const unresolved = { kind: "unresolved" };
  const setWebConfig = (ctx: { dir: string }, config: object) =>
    writeFileSync(join(ctx.dir, "apps/web/tsconfig.json"), JSON.stringify(config));
  const webResolver = (ctx: ReturnType<typeof fixture>) => {
    const r = createResolver(ctx);
    return (spec: string) => r.resolveSpecifier(page, spec);
  };

  test("an app's own paths and an app that inherits the base's paths both resolve with no node_modules", () => {
    const r = createResolver(fixture("tsconfig-extends-workspace"));
    expect(r.resolveSpecifier(page, "@/lib/format")).toEqual(format);
    expect(r.resolveSpecifier(admin, "~shared/date")).toEqual(date);
    // The app's `paths` replace the base's.
    expect(r.resolveSpecifier(page, "~shared/date")).toEqual(unresolved);
  });

  test("with the config package linked into node_modules oxc-resolver reads the chain and the results are identical", () => {
    const unlinked = fixture("tsconfig-extends-workspace");
    const linked = fixture("tsconfig-extends-workspace");
    mkdirSync(join(linked.dir, "node_modules/@acme"), { recursive: true });
    symlinkSync(
      join(linked.dir, "packages/config-typescript"),
      join(linked.dir, "node_modules/@acme/config-typescript"),
    );
    const chain = (c: typeof linked) =>
      readTsconfigChain(join(c.dir, "apps/admin/tsconfig.json"), c.workspaces, realpathSync(c.dir));
    expect(chain(unlinked).needsAlias).toBe(true);
    expect(chain(linked).needsAlias).toBe(false);
    const both = (c: typeof linked) => {
      const r = createResolver(c);
      return [r.resolveSpecifier(page, "@/lib/format"), r.resolveSpecifier(admin, "~shared/date")];
    };
    expect(both(linked)).toEqual([format, date]);
    expect(both(linked)).toEqual(both(unlinked));
  });

  test("a paths in the leaf replaces the base's and resolves against the inherited baseUrl", () => {
    const ctx = fixture("tsconfig-extends-workspace");
    // The base's `baseUrl` is its own directory, so the leaf's target is relative to `packages/config-typescript`.
    setWebConfig(ctx, {
      extends: "@acme/config-typescript/nextjs.json",
      compilerOptions: { paths: { "~shared/*": ["../shared/src/*"] } },
    });
    const at = webResolver(ctx);
    expect(at("~shared/date")).toEqual(date);
    expect(at("@/lib/format")).toEqual(unresolved);
    setWebConfig(ctx, {
      extends: "@acme/config-typescript/nextjs.json",
      compilerOptions: { paths: { "~x/*": ["./src/lib/*"] } },
    });
    expect(webResolver(ctx)("~x/format")).toEqual(unresolved);
    setWebConfig(ctx, {
      extends: "@acme/config-typescript/nextjs.json",
      compilerOptions: { baseUrl: ".", paths: { "~x/*": ["./src/lib/*"] } },
    });
    expect(webResolver(ctx)("~x/format")).toEqual(format);
  });

  test("an extends of an unknown package keeps the leaf's paths", () => {
    const ctx = fixture("tsconfig-extends-workspace");
    setWebConfig(ctx, {
      extends: ["@nowhere/config/base.json"],
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
    });
    expect(webResolver(ctx)("@/lib/format")).toEqual(format);
  });

  test("${configDir} in paths is the directory of the leaf config", () => {
    const ctx = fixture("tsconfig-extends-workspace");
    setWebConfig(ctx, {
      extends: "@acme/config-typescript/nextjs.json",
      compilerOptions: { paths: { "@/*": ["${configDir}/src/*"] } },
    });
    expect(webResolver(ctx)("@/lib/format")).toEqual(format);
  });

  test("a leaf baseUrl still resolves bare imports when the chain goes through a workspace package", () => {
    const ctx = fixture("tsconfig-extends-workspace");
    setWebConfig(ctx, {
      extends: "@acme/config-typescript/nextjs.json",
      compilerOptions: { baseUrl: "src" },
    });
    expect(webResolver(ctx)("lib/format")).toEqual(format);
  });

  test("a base that two extends entries share is read for each", () => {
    const ctx = fixture("tsconfig-extends-workspace", {
      "apps/web/src/a/x.ts": "export const a = 1;\n",
      "apps/web/src/b/x.ts": "export const b = 1;\n",
    });
    for (const d of ["a", "b"]) {
      mkdirSync(join(ctx.dir, "apps/web/src", d), { recursive: true });
      writeFileSync(join(ctx.dir, "apps/web/src", d, "x.ts"), "export const x = 1;\n");
    }
    const web = (name: string, config: object) =>
      writeFileSync(join(ctx.dir, "apps/web", name), JSON.stringify(config));
    web("base.json", { compilerOptions: { baseUrl: ".", paths: { "@b/*": ["./src/b/*"] } } });
    web("a.json", { extends: "./base.json", compilerOptions: { paths: { "@a/*": ["./src/a/*"] } } });
    web("b.json", { extends: "./base.json" });
    setWebConfig(ctx, { extends: ["@nowhere/config", "./a.json", "./b.json"] });
    const at = webResolver(ctx);
    // The later entry wins: `b.json` brings the base's `paths` back.
    expect(at("@b/x")).toEqual({ kind: "file", fileId: "file:repo:apps/web/src/b/x.ts" });
    expect(at("@a/x")).toEqual(unresolved);
  });
});
