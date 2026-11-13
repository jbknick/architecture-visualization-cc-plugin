import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  analyzeFile,
  classifyResolved,
  generaliseDir,
  isExcluded,
  median,
  ResolverFactory,
  redactSpecifier,
  routeFileShape,
  unresolvedReason,
} from "./analyze.js";
import { render, runOnce } from "./run.js";

test("section 5 excludes", () => {
  expect(isExcluded("src/a.ts")).toBe(false);
  expect(isExcluded("src/a.tsx")).toBe(false);
  expect(isExcluded("src/a.mts")).toBe(false);
  expect(isExcluded("src/a.js")).toBe(true);
  expect(isExcluded("src/a.d.ts")).toBe(true);
  expect(isExcluded("src/routeTree.gen.ts")).toBe(true);
  expect(isExcluded("node_modules/x/index.ts")).toBe(true);
  expect(isExcluded("apps/web/dist/a.ts")).toBe(true);
  expect(isExcluded(".claude/worktrees/x/src/a.ts")).toBe(true);
  expect(isExcluded("src/secrets.ts")).toBe(true);
  expect(isExcluded("src/credentials.ts")).toBe(true);
  expect(isExcluded("src/.env.ts")).toBe(true);
});

test("collects imports, exports and top-level functions", () => {
  const f = analyzeFile(
    "/x/a.ts",
    `import def, { a as b, type T } from "./m";
import * as ns from "pkg";
import type { U } from "./types";
export { z } from "./re";
export * from "./all";
export const arrow = () => 1;
export function decl() {}
export default function () {}
const local = function () {};
const lazy = () => import("./lazy");
`,
  );
  expect(f.imports.map((i) => [i.specifier, i.kind])).toEqual([
    ["./m", "static"],
    ["pkg", "static"],
    ["./types", "static"],
    ["./re", "reexport"],
    ["./all", "reexport"],
    ["./lazy", "dynamic"],
  ]);
  expect(f.imports[0]?.bindings).toEqual([
    { local: "def", imported: "default" },
    { local: "b", imported: "a" },
    { local: "T", imported: "T" },
  ]);
  expect(f.imports[2]?.typeOnly).toBe(true);
  expect(f.exports.map((e) => e.kind)).toEqual(["named", "all", "declaration", "declaration", "default"]);
  expect(f.functions.sort()).toEqual(["arrow", "decl", "default", "lazy", "local"].sort());
  expect(f.parseErrors).toBe(0);
});

test("maps call sites without type info", () => {
  const f = analyzeFile(
    "/x/a.ts",
    `import { imp } from "./m";
import * as ns from "pkg";
const helper = () => 1;
export function run(param: () => void) {
  imp();
  ns.deep.call();
  helper();
  param();
  const inner = () => 2;
  inner();
  fetch("x");
  imp().then(() => helper());
}
`,
  );
  const byRoot = (r: string) => f.calls.filter((c) => c.root === r).map((c) => c.classification);
  expect(byRoot("imp")).toEqual(["import", "import", "import"]); // imp(), imp().then(), inner imp()
  expect(byRoot("ns")).toEqual(["import"]);
  expect(byRoot("helper")).toEqual(["top-level", "top-level"]);
  expect(byRoot("param")).toEqual(["local-scope"]);
  expect(byRoot("inner")).toEqual(["local-scope"]);
  expect(byRoot("fetch")).toEqual(["global"]);
  expect(f.calls.find((c) => c.root === "ns")?.importIndex).toBe(1);
});

test("a local binding shadows an import of the same name", () => {
  const f = analyzeFile(
    "/x/a.ts",
    `import { x } from "./m";\nexport function f() { const x = () => 1; x(); }\n`,
  );
  expect(f.calls.map((c) => c.classification)).toEqual(["local-scope"]);
});

test("detects framework markers and route option keys", () => {
  const f = analyzeFile(
    "/x/routes/a.$id.tsx",
    `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/a/$id")({ component: C, loader: () => 1, head: () => ({}) });
const t = sqliteTable("t", {});
const app = new Hono();
`,
  );
  expect(f.markers).toEqual({ createFileRoute: 1, sqliteTable: 1, Hono: 1 });
  expect(f.routeKeys).toEqual({ component: 1, loader: 1, head: 1 });
  expect(f.routePaths).toEqual(["/a/$id"]);
});

test("path shapes never keep workspace-specific names", () => {
  expect(generaliseDir("apps/secretapp/src/routes/a/b.tsx")).toBe("apps/<name>/src/routes/...");
  expect(generaliseDir("packages/db/src/schema/x.ts")).toBe("packages/<name>/src/schema");
  expect(generaliseDir("tests/x.ts")).toBe("tests");
  expect(generaliseDir("packages/db/src/secret-feature/deeper/x.ts")).toBe("packages/<name>/src/<dir>");
  expect(generaliseDir("packages/db/src/routers/secret/x.ts")).toBe("packages/<name>/src/routers/<dir>");
  expect(routeFileShape("a/routes/__root.tsx")).toBe("__root");
  expect(routeFileShape("a/routes/_auth.tsx")).toBe("pathless layout (_prefix)");
  expect(routeFileShape("a/routes/users.$id.tsx")).toBe("flat dotted with $param");
  expect(routeFileShape("a/routes/-components.tsx")).toBe("ignored (-prefix)");
});

test("redaction hides private specifiers and keeps public ones", () => {
  const ctx = { workspaceNames: new Set(["@acme/secret"]) };
  expect(redactSpecifier("./deep/private", ctx)).toBe("<relative path>");
  expect(redactSpecifier("@acme/secret/sub", ctx)).toBe("<workspace package>");
  expect(redactSpecifier("@/lib/x", ctx)).toBe("@/<path>");
  expect(redactSpecifier("cloudflare:workers", ctx)).toBe("cloudflare:<module>");
  expect(redactSpecifier("zod", ctx)).toBe("zod");
  expect(unresolvedReason("cloudflare:workers", undefined, ctx)).toMatch(/virtual/);
  expect(unresolvedReason("@/lib/x", undefined, ctx)).toMatch(/alias/);
  expect(unresolvedReason("./routeTree.gen", undefined, ctx)).toMatch(/generated/);
  expect(unresolvedReason("./a.css", undefined, ctx)).toMatch(/asset/);
  expect(unresolvedReason("@acme/secret", undefined, ctx)).toMatch(/workspace/);
});

test("median", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 2, 3])).toBe(2.5);
});

test("end to end on a synthetic repo", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gantry-oxc-")));
  const write = (p: string, c: string) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  };
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }));
  write("src/util.ts", "export const util = () => 1;\n");
  write(
    "src/main.ts",
    `import { util } from "~/util";\nimport { readFileSync } from "node:fs";\nimport "./missing";\nexport function f() { util(); readFileSync("x"); }\n`,
  );
  const resolver = new ResolverFactory({
    conditionNames: ["import", "types", "default"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js"],
    tsconfig: "auto",
    builtinModules: true,
  });
  const main = join(root, "src/main.ts");
  expect(classifyResolved(root, resolver.resolveFileSync(main, "~/util"))).toBe("repo");
  expect(classifyResolved(root, resolver.resolveFileSync(main, "node:fs"))).toBe("builtin");
  expect(classifyResolved(root, resolver.resolveFileSync(main, "./missing"))).toBe("unresolved");

  const { summary } = runOnce(root, ["src/main.ts", "src/util.ts"], new Set());
  expect(summary.files).toBe(2);
  expect(summary.functions).toBe(2);
  expect(summary.imports).toBe(3);
  expect(summary.resolution).toEqual({ repo: 1, node_modules: 0, builtin: 1, unresolved: 1 });
  expect(summary.internalTotal).toBe(2);
  expect(summary.internalResolved).toBe(1);
  expect(summary.calls.import).toBe(2);
  expect(summary.callsByImportTarget).toEqual({ repo: 1, node_modules: 0, builtin: 1, unresolved: 0 });
  const text = render(summary, summary.timings, 1);
  expect(text).toContain("% of repo-internal imports resolved");
  expect(text).not.toContain(root);
});
