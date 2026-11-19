import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// The hand-label schema for evaluation repos (route, endpoint, table, read, write, link),
// used here for a committed fixture. `sha` is only for pinned third-party repos.
const file = z.string().regex(/^[^\\]+$/);
const labelSchema = z.object({
  repo: z.string().regex(/^[a-z0-9._-]+$/),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  labelledBy: z.string(),
  kinds: z.array(z.enum(["route", "endpoint", "table", "read", "write", "link"])),
  route: z.array(z.object({ path: z.string().startsWith("/"), file }).strict()).default([]),
  endpoint: z
    .array(
      z
        .object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
          path: z.string().startsWith("/"),
          file,
        })
        .strict(),
    )
    .default([]),
  table: z.array(z.object({ name: z.string() }).strict()).default([]),
  read: z.array(z.object({ file, table: z.string() }).strict()).default([]),
  write: z.array(z.object({ file, table: z.string() }).strict()).default([]),
  link: z.array(z.object({ file, endpoint: z.string() }).strict()).default([]),
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = join(root, "fixtures/react-router-fastify");
const labels = labelSchema.parse(
  JSON.parse(readFileSync(join(root, "evals/fixtures/labels/react-router-fastify.json"), "utf8")),
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("react-router-fastify labels", () => {
  it("parses with the label schema and names the fixture", () => {
    expect(labels.repo).toBe("react-router-fastify");
    expect(labels.kinds).toEqual(["route", "endpoint", "table", "read", "write", "link"]);
  });

  it("meets the minimum counts", () => {
    expect(labels.route.length).toBeGreaterThanOrEqual(24);
    expect(labels.endpoint.length).toBeGreaterThanOrEqual(12);
    expect(labels.table.length).toBeGreaterThanOrEqual(3);
  });

  it("has no duplicate keys in a kind", () => {
    const dup = (keys: string[]) => keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dup(labels.route.map((r) => r.path))).toEqual([]);
    expect(dup(labels.endpoint.map((e) => `${e.method} ${e.path}`))).toEqual([]);
    expect(dup(labels.table.map((t) => t.name))).toEqual([]);
    expect(dup(labels.read.map((r) => `${r.file}|${r.table}`))).toEqual([]);
    expect(dup(labels.write.map((r) => `${r.file}|${r.table}`))).toEqual([]);
    expect(dup(labels.link.map((l) => `${l.file}|${l.endpoint}`))).toEqual([]);
  });

  it("labels only files that exist in the fixture", () => {
    const files = [
      ...labels.route.map((r) => r.file),
      ...labels.endpoint.map((e) => e.file),
      ...labels.read.map((r) => r.file),
      ...labels.write.map((r) => r.file),
      ...labels.link.map((l) => l.file),
    ];
    expect(files.filter((f) => !existsSync(join(fixtureDir, f)))).toEqual([]);
  });

  it("labels only tables that occur in packages/db", () => {
    const dbText = walk(join(fixtureDir, "packages/db/src"))
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    const names = [
      ...labels.table.map((t) => t.name),
      ...labels.read.map((r) => r.table),
      ...labels.write.map((r) => r.table),
    ];
    const missing = names.filter((n) => !dbText.includes(`pgTable("${n}"`));
    expect(missing).toEqual([]);
  });

  it("links point at labelled endpoints and traces from a page through a handler to a table", () => {
    const endpoints = new Set(labels.endpoint.map((e) => `${e.method} ${e.path}`));
    expect(labels.link.filter((l) => !endpoints.has(l.endpoint))).toEqual([]);
    // Every web app has a page that calls an endpoint.
    for (const app of ["web-data", "web-declarative", "web-framework"]) {
      expect(labels.link.some((l) => l.file.startsWith(`apps/${app}/`))).toBe(true);
    }
    // The call to GET /api/posts reaches the posts table through listPosts.
    const controller = readFileSync(join(fixtureDir, "apps/api/src/controllers/posts.ts"), "utf8");
    expect(controller).toContain("db.listPosts()");
    expect(labels.read).toContainEqual({ file: "packages/db/src/queries/posts.ts", table: "posts" });
  });
});
