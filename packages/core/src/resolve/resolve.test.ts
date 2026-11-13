import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
    const pf = parseSource(rel, readFileSync(join(root, rel), "utf8"));
    parsed.set(pf.fileId, pf);
  }
  for (const [rel, src] of Object.entries(extra)) {
    const pf = parseSource(rel, src);
    parsed.set(pf.fileId, pf);
  }
  return { root, workspaces, parsed };
}

function fixture(name: string, extra: Record<string, string> = {}) {
  const dir = mkTmp();
  cpSync(join(fixturesRoot, name), dir, { recursive: true });
  const workspaces = detectWorkspaces(dir, { workspaces: { overrides: {} } });
  return { dir, ...load(dir, workspaces, extra) };
}

/** Build a repo from text files; parse every indexable one. */
function repo(files: Record<string, string>) {
  const dir = mkTmp();
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  const workspaces = detectWorkspaces(dir, { workspaces: { overrides: {} } });
  return load(dir, workspaces);
}

describe("pnpm-turbo fixture", () => {
  test("a page importing Button through the @acme/ui barrel gets a renders edge to the original", () => {
    const rel = "apps/web/src/routes/barrel.tsx";
    const ctx = fixture("pnpm-turbo", {
      [rel]: `import { Button } from "@acme/ui";\nexport function Page() {\n  return <Button label="x" />;\n}\n`,
    });
    const r = createResolver(ctx);
    expect(r.resolveSpecifier(`file:${rel}`, "@acme/ui")).toEqual({
      kind: "file",
      fileId: "file:packages/ui/src/index.ts",
    });
    expect(r.resolveSymbol("file:packages/ui/src/index.ts", "Button")).toBe(
      "sym:packages/ui/src/button.tsx#Button",
    );
    const edges = r.edgesForFile(`file:${rel}`);
    expect(edges).toContainEqual({
      src: `sym:${rel}#Page`,
      dst: "sym:packages/ui/src/button.tsx#Button",
      kind: "renders",
      confidence: "high",
      count: 1,
      evidence: [`${rel}:3`],
      fileId: `file:${rel}`,
    });
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: `file:${rel}`,
        dst: "file:packages/ui/src/index.ts",
        kind: "imports",
        count: 1,
      }),
    );
  });

  test("subpath export and the real index route resolve", () => {
    const ctx = fixture("pnpm-turbo");
    const r = createResolver(ctx);
    const idx = "file:apps/web/src/routes/index.tsx";
    expect(r.resolveSpecifier(idx, "@acme/ui/button")).toEqual({
      kind: "file",
      fileId: "file:packages/ui/src/button.tsx",
    });
    // internal.ts is not in the exports map, so it is not reachable through the package name.
    expect(r.resolveSpecifier(idx, "@acme/ui/internal")).toEqual({ kind: "unresolved" });
    const edges = r.edgesForFile(idx);
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "sym:apps/web/src/routes/index.tsx#HomePage",
        dst: "sym:packages/ui/src/button.tsx#Button",
        kind: "renders",
        confidence: "high",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "sym:apps/web/src/routes/index.tsx#HomePage",
        dst: "sym:apps/web/src/components/PostList.tsx#PostList",
        kind: "renders",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ dst: "ext:@tanstack/react-router", kind: "imports" }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ src: "ws:@acme/web", dst: idx, kind: "contains" }),
    );
  });

  test("hooks and local calls resolve; edges are sorted and deterministic", () => {
    const ctx = fixture("pnpm-turbo");
    const r = createResolver(ctx);
    const list = "file:apps/web/src/components/PostList.tsx";
    const edges = r.edgesForFile(list);
    expect(edges).toContainEqual(
      expect.objectContaining({
        dst: "sym:apps/web/src/hooks/useDebounce.ts#useDebounce",
        kind: "uses_hook",
        confidence: "high",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ dst: "sym:apps/web/src/lib/slug.ts#slugify", kind: "calls" }),
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
    expect(dependsOnEdges(ctx.workspaces)).toEqual(edges);
  });

  test("contains and exports edges for a file", () => {
    const ctx = fixture("pnpm-turbo");
    const edges = createResolver(ctx).edgesForFile("file:packages/ui/src/button.tsx");
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "ws:@acme/ui",
        dst: "file:packages/ui/src/button.tsx",
        kind: "contains",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "file:packages/ui/src/button.tsx",
        dst: "sym:packages/ui/src/button.tsx#Button",
        kind: "contains",
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "file:packages/ui/src/button.tsx",
        dst: "sym:packages/ui/src/button.tsx#Button",
        kind: "exports",
      }),
    );
  });

  test("barrel exports edges point at the resolved originals", () => {
    const ctx = fixture("pnpm-turbo");
    const edges = createResolver(ctx).edgesForFile("file:packages/ui/src/index.ts");
    expect(edges.filter((e) => e.kind === "exports").map((e) => e.dst)).toEqual([
      "sym:packages/ui/src/button.tsx#Button",
      "sym:packages/ui/src/card.tsx#Card",
    ]);
    expect(edges.filter((e) => e.kind === "imports").map((e) => e.dst)).toEqual([
      "file:packages/ui/src/button.tsx",
      "file:packages/ui/src/card.tsx",
    ]);
  });
});

describe("single-pkg fixture", () => {
  test("path alias @/x resolves via the nearest tsconfig", () => {
    const ctx = fixture("single-pkg");
    const r = createResolver(ctx);
    const main = "file:src/main.ts";
    expect(r.resolveSpecifier(main, "@/greet")).toEqual({ kind: "file", fileId: "file:src/greet.ts" });
    expect(r.resolveSpecifier(main, "@/index")).toEqual({ kind: "file", fileId: "file:src/index.ts" });
    expect(r.resolveSymbol("file:src/index.ts", "Counter")).toBe("sym:src/counter.ts#Counter");
    expect(r.resolveSymbol("file:src/index.ts", "greet")).toMatch(/^sym:src\/greet\.ts#/);
  });

  test("alias target in a generated file is classified generated, not unresolved", () => {
    const ctx = fixture("single-pkg");
    const r = createResolver(ctx);
    expect(r.resolveSpecifier("file:src/main.ts", "@/gen/api.gen")).toEqual({ kind: "unresolved" });
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
    expect(r.resolveSymbol("file:b.ts", "foo")).toBe("sym:a.ts#foo");
    expect(r.resolveSymbol("file:b.ts", "bar")).toBe("sym:a.ts#foo");
    expect(r.resolveSymbol("file:b.ts", "dflt")).toBe("sym:a.ts#main");
    expect(r.resolveSymbol("file:b.ts", "nsA")).toBeNull();
    expect(r.resolveSymbol("file:c.ts", "again")).toBe("sym:a.ts#foo");
    expect(r.resolveSymbol("file:c.ts", "k")).toBe("sym:a.ts#k");
    expect(r.resolveSymbol("file:c.ts", "missing")).toBeNull();
    expect(r.resolveSymbol("file:nope.ts", "x")).toBeNull();
    const exportsOfB = r
      .edgesForFile("file:b.ts")
      .filter((e) => e.kind === "exports")
      .map((e) => e.dst);
    expect(exportsOfB).toEqual(["sym:a.ts#foo", "sym:a.ts#k", "sym:a.ts#main"]);
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
    expect(r.resolveSymbol("file:a.ts", "x")).toBeNull();
    expect(r.resolveSymbol("file:b.ts", "nothing")).toBeNull();
    expect(r.resolveSymbol("file:self.ts", "y")).toBeNull();
    expect(r.edgesForFile("file:a.ts").filter((e) => e.kind === "exports")).toEqual([]);
    expect(r.edgesForFile("file:self.ts").filter((e) => e.kind === "exports")).toEqual([]);
    // depth is capped at 10 hops
    expect(r.resolveSymbol("file:c14.ts", "z")).toBe("sym:c15.ts#z");
    expect(r.resolveSymbol("file:c0.ts", "z")).toBeNull();
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
    const edges = r.edgesForFile("file:main.ts");
    const find = (src: string, dst: string, kind: string) =>
      edges.find((e) => e.src === src && e.dst === dst && e.kind === kind);
    expect(find("sym:main.ts#local", "sym:lib.ts#helper", "calls")).toMatchObject({
      count: 2,
      confidence: "high",
      evidence: ["main.ts:3"],
    });
    expect(find("sym:main.ts#run", "sym:main.ts#local", "calls")).toMatchObject({
      count: 2,
      confidence: "high",
      evidence: ["main.ts:4"],
    });
    expect(find("sym:main.ts#run", "sym:lib.ts#helper", "calls")?.count).toBe(1);
    expect(find("sym:main.ts#Child", "sym:lib.ts#Base", "extends")).toBeDefined();
    expect(find("sym:main.ts#Child", "sym:lib.ts#Shape", "implements")).toBeDefined();
    expect(edges.some((e) => e.kind === "references_type" && e.dst === "sym:lib.ts#Shape")).toBe(true);
    // this.two() and thing.two(): exactly one method named `two` in the file => low
    expect(find("sym:main.ts#Child.one", "sym:main.ts#Child.two", "calls")).toMatchObject({
      confidence: "low",
    });
    expect(find("sym:main.ts#Child.three", "sym:main.ts#Child.two", "calls")).toMatchObject({
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
    expect(r.edgesForFile("file:m.ts").filter((e) => e.kind === "calls")).toEqual([]);
    expect(r.stats().counts.unresolved).toBe(0 + 1);
  });

  test("evidence is capped at 3 and count keeps counting", () => {
    const calls = Array.from({ length: 6 }, () => "helper();").join("\n");
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "ev" }),
        "lib.ts": "export function helper() {}",
        "m.ts": `import { helper } from "./lib";\nexport function f() {\n${calls}\n}`,
      }),
    );
    const e = r.edgesForFile("file:m.ts").find((x) => x.kind === "calls");
    expect(e?.count).toBe(6);
    expect(e?.evidence).toEqual(["m.ts:3", "m.ts:4", "m.ts:5"]);
  });

  test("imports edge counts bindings and merges side-effect and dynamic imports", () => {
    const r = createResolver(
      repo({
        "package.json": JSON.stringify({ name: "imp", dependencies: { hono: "1" } }),
        "lib.ts": "export const a = 1; export const b = 2;",
        "m.ts": `import { a, b } from "./lib";\nimport "./lib";\nconst l = () => import("./lib");\nimport { Hono } from "hono";\nimport fs from "node:fs";\nimport x from "cloudflare:workers";`,
      }),
    );
    const imports = r.edgesForFile("file:m.ts").filter((e) => e.kind === "imports");
    expect(imports.map((e) => [e.dst, e.count])).toEqual([
      ["ext:hono", 1],
      ["file:lib.ts", 4],
    ]);
    expect(r.stats().counts).toMatchObject({ builtin: 1, virtual: 1, external: 1, file: 1, unresolved: 0 });
  });
});

describe("classification", () => {
  test("unresolved specifiers are counted and listed, never thrown", () => {
    const r = createResolver(repo({ "package.json": JSON.stringify({ name: "u" }), "m.ts": "export {};" }));
    expect(r.resolveSpecifier("file:m.ts", "./nope")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:m.ts", "not-declared-pkg")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:m.ts", "../../outside")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:m.ts", "@/")).toEqual({ kind: "unresolved" });
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
    expect(r.resolveSpecifier("file:m.ts", "node:path")).toEqual({ kind: "external", pkg: "node:path" });
    expect(r.resolveSpecifier("file:m.ts", "fs")).toEqual({ kind: "external", pkg: "fs" });
    expect(r.resolveSpecifier("file:m.ts", "virtual:uno.css")).toEqual({
      kind: "external",
      pkg: "virtual:uno.css",
    });
    expect(r.resolveSpecifier("file:m.ts", "bun:test")).toEqual({ kind: "external", pkg: "bun:test" });
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
    expect(r.resolveSpecifier("file:m.ts", "./routeTree.gen")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:m.ts", "./plain")).toEqual({ kind: "unresolved" });
    // absent on disk but matching a built-in exclude (untracked codegen / build output)
    expect(r.resolveSpecifier("file:m.ts", "./client.gen")).toEqual({ kind: "unresolved" });
    expect(r.resolveSpecifier("file:m.ts", "./dist/out.js")).toEqual({ kind: "unresolved" });
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
    const ws = detectWorkspaces(dir, { workspaces: { overrides: {} } });
    const r = createResolver(load(dir, ws));
    expect(r.resolveSpecifier("file:m.ts", "hast")).toEqual({ kind: "external", pkg: "hast" });
    expect(r.resolveSpecifier("file:m.ts", "@scope/pkg/sub")).toEqual({
      kind: "external",
      pkg: "@scope/pkg",
    });
    expect(r.resolveSpecifier("file:m.ts", "mdast")).toEqual({ kind: "unresolved" });
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
    const ws = detectWorkspaces(dir, { workspaces: { overrides: {} } });
    const r = createResolver(load(dir, ws));
    expect(r.resolveSpecifier("file:m.ts", "@s/p")).toEqual({ kind: "external", pkg: "@s/p" });
    expect(r.resolveSpecifier("file:m.ts", "@s/p/sub")).toEqual({ kind: "external", pkg: "@s/p" });
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
    expect(r.resolveSpecifier("file:m.ts", "./x.js")).toEqual({ kind: "file", fileId: "file:x.ts" });
  });

  test("a symlinked repo root is realpath'd (files are not classified as outside the repo)", () => {
    const real = mkTmp();
    writeFileSync(join(real, "package.json"), "{}");
    writeFileSync(join(real, "tsconfig.json"), "{}");
    writeFileSync(join(real, "a.ts"), "export const a = 1;");
    writeFileSync(join(real, "m.ts"), `import { a } from "./a";`);
    const link = join(mkTmp(), "link");
    symlinkSync(real, link);
    const ws = detectWorkspaces(real, { workspaces: { overrides: {} } });
    const ctx = load(real, ws);
    const r = createResolver({ ...ctx, root: link });
    expect(r.resolveSpecifier("file:m.ts", "./a")).toEqual({ kind: "file", fileId: "file:a.ts" });
  });

  test("self-import is not an edge and unknown files yield no edges", () => {
    const r = createResolver(
      repo({ "package.json": "{}", "m.ts": `import { m } from "./m";\nexport const m = 1;` }),
    );
    expect(r.edgesForFile("file:m.ts").filter((e) => e.kind === "imports")).toEqual([]);
    expect(r.edgesForFile("file:unknown.ts")).toEqual([]);
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
    const from = "file:packages/b/src/m.ts";
    expect(r.resolveSpecifier(from, "@w/a")).toEqual({
      kind: "file",
      fileId: "file:packages/a/src/index.ts",
    });
    expect(r.resolveSpecifier(from, "@w/a/util")).toEqual({
      kind: "file",
      fileId: "file:packages/a/src/util.ts",
    });
    expect(r.workspaceEdges().map((e) => `${e.src}>${e.dst}`)).toEqual(["ws:@w/b>ws:@w/a"]);
  });
});
