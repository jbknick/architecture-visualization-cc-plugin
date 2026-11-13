import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type MaterializedFixture, materializeFixture } from "./helpers/fixture.js";

const open: MaterializedFixture[] = [];
async function mat(name: Parameters<typeof materializeFixture>[0]) {
  const f = await materializeFixture(name);
  open.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.cleanup()));
});

describe("materializeFixture", () => {
  for (const name of ["single-pkg", "pnpm-turbo", "nx"] as const) {
    test(`${name} becomes a git repo on main with one "fixture" commit`, async () => {
      const f = await mat(name);
      expect(f.git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
      expect(f.git(["log", "--format=%s"]).trim()).toBe("fixture");
      expect(f.git(["status", "--porcelain"]).trim()).toBe("");
      expect(f.git(["ls-files"]).split("\n").filter(Boolean).length).toBeGreaterThan(5);
      expect(f.git(["ls-files"])).not.toContain("node_modules");
    });
  }

  test("cleanup removes the directory", async () => {
    const f = await materializeFixture("nx");
    await f.cleanup();
    expect(existsSync(f.dir)).toBe(false);
  });
});

describe("fixture contents", () => {
  test("single-pkg has alias, sensitive and generated files", async () => {
    const f = await mat("single-pkg");
    expect(readFileSync(join(f.dir, "tsconfig.json"), "utf8")).toContain('"@/*": ["src/*"]');
    for (const p of [".env", "src/secrets.ts", "src/gen/api.gen.ts", "src/index.ts"]) {
      expect(existsSync(join(f.dir, p)), p).toBe(true);
    }
    expect(f.git(["ls-files"]).split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(14);
  });

  test("pnpm-turbo has every scenario", async () => {
    const f = await mat("pnpm-turbo");
    const read = (p: string) => readFileSync(join(f.dir, p), "utf8");
    const files = f.git(["ls-files"]);
    for (const p of [
      "pnpm-workspace.yaml",
      "turbo.json",
      "apps/web/src/routes/__root.tsx",
      "apps/web/src/routes/index.tsx",
      "apps/web/src/routes/posts.$postId.tsx",
      "apps/web/src/routes/settings/profile.tsx",
      "apps/web/src/routeTree.gen.ts",
      "apps/web/src/hooks/useDebounce.ts",
      ".claude/worktrees/feature-x/packages/utils/src/date.ts",
    ]) {
      expect(files, p).toContain(p);
    }
    expect(read("apps/web/src/routes/index.tsx")).toContain("createFileRoute");
    expect(read("apps/api/src/app.ts")).toContain('app.get("/posts/:id"');
    expect(read("apps/api/src/app.ts")).toContain('app.post("/posts"');
    expect(read("apps/api/src/router.ts")).toMatch(/list:[\s\S]*create:/);
    expect(read("packages/db/src/schema.ts")).toContain('sqliteTable("posts"');
    expect(read("packages/db/src/schema.ts")).toContain('sqliteTable("users"');
    expect(read("packages/db/src/queries.ts")).toContain("select().from(posts)");
    expect(read("packages/db/src/queries.ts")).toContain("insert(posts)");
    expect(JSON.parse(read("packages/ui/package.json")).exports).toEqual({
      ".": "./src/index.ts",
      "./button": "./src/button.tsx",
    });
    // undeclared import
    expect(read("apps/web/src/routes/posts.$postId.tsx")).toContain("@acme/db");
    expect(read("apps/web/package.json")).not.toContain("@acme/db");
    // exact slugify copy; internal one is not exported from the package
    const fn = (s: string) =>
      s.slice(s.indexOf("function slugify"), s.indexOf("\n}\n", s.indexOf("function slugify")));
    expect(fn(read("apps/web/src/lib/slug.ts"))).toBe(fn(read("packages/utils/src/slug.ts")));
    expect(read("packages/utils/src/index.ts")).not.toContain("slugify");
    // near-duplicate pair with >= 6 statements each
    const stmts = (s: string) => s.split("\n").filter((l) => /^\s+(const|if|return)\b/.test(l)).length;
    expect(stmts(read("packages/utils/src/date.ts"))).toBeGreaterThanOrEqual(6);
    expect(stmts(read("packages/utils/src/time.ts"))).toBeGreaterThanOrEqual(6);
  });

  test("nx has two projects and the alias", async () => {
    const f = await mat("nx");
    expect(existsSync(join(f.dir, "nx.json"))).toBe(true);
    expect(existsSync(join(f.dir, "apps/shop/project.json"))).toBe(true);
    expect(existsSync(join(f.dir, "libs/cart/project.json"))).toBe(true);
    expect(readFileSync(join(f.dir, "tsconfig.base.json"), "utf8")).toContain("@shop/cart");
  });
});
