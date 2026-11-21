import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLabels, holdsTable, sameTable } from "../../scripts/eval-label-check.js";
import { dataHits, sample, staleListed, unlabelled } from "../../scripts/eval-label-scan.js";
import { labelsSchema, type Repo } from "../../scripts/eval-lib.js";

// Data-access cases (#269): table, read and write labels covered by the same scan as the framework cases.

const SHA = "c".repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clone(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-checklabels-data-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const labelsOf = (over: Record<string, unknown>) =>
  labelsSchema.parse({
    repo: "app",
    sha: SHA,
    labelledBy: "test",
    kinds: ["table", "read", "write"],
    ...over,
  });

const repoOf = (stack: string[]) => ({ name: "app", stack }) as Repo;
/** The scan's unlabelled data-access candidates as `file:line text`. */
const missing = (labels: ReturnType<typeof labelsOf>, dir: string, stack: string[], readme = "") =>
  unlabelled(dir, repoOf(stack), labels, readme).map((c) => `${c.file}:${c.line} ${c.text}`);

const prisma = {
  "prisma/schema.prisma":
    'model User {\n  id String @id\n  @@map(name: "users")\n}\nmodel Post {\n  id String @id\n}\n',
  "lib/posts.ts":
    "export const all = () => db.post.findMany({});\nexport const add = () => db.post.create({});\n",
  "lib/users.ts": "export const one = () => db.user.findFirst({});\n",
  "lib/posts.test.ts": "db.post.delete({});\n",
};

describe("table name matching", () => {
  it("treats plurals, underscores, role suffixes and prefixes as the same table", () => {
    expect(sameTable("movies", "Movie")).toBe(true);
    expect(sameTable("verification_tokens", "verificationToken")).toBe(true);
    expect(sameTable("_private_job_queues", "job_queues")).toBe(true);
    expect(sameTable("follows", "FollowsEntity")).toBe(true);
    expect(sameTable("users", "teams")).toBe(false);
    expect(holdsTable("db.verificationToken.create()", "verification_tokens")).toBe(true);
    expect(holdsTable("db.post.create()", "users")).toBe(false);
  });
});

describe("data-access candidates", () => {
  const stack = ["nextjs", "prisma"];
  const full = {
    table: [{ name: "users" }, { name: "Post" }],
    read: [
      { file: "lib/posts.ts", table: "Post" },
      { file: "lib/users.ts", table: "users" },
    ],
    write: [{ file: "lib/posts.ts", table: "Post" }],
  };

  it("reports nothing when every definition and access is labelled", () => {
    expect(missing(labelsOf(full), clone(prisma), stack)).toEqual([]);
  });

  it("reports an unlabelled table, read and write, and leaves tests out", () => {
    const dir = clone(prisma);
    const noTable = labelsOf({
      table: [{ name: "users" }],
      read: [{ file: "lib/users.ts", table: "users" }],
    });
    expect(missing(noTable, dir, stack)).toEqual(["prisma/schema.prisma:5 table Post has no table label"]);
    const labels = labelsOf({ ...full, read: [{ file: "lib/users.ts", table: "users" }], write: [] });
    expect(missing(labels, dir, stack)).toEqual([
      expect.stringContaining("lib/posts.ts:1 read Post"),
      expect.stringContaining("lib/posts.ts:2 write Post"),
    ]);
  });

  it("takes a README entry for a call that names no table, flags a stale one, and scans only known stacks", () => {
    const dir = clone({ ...prisma, "lib/raw.ts": "await db.$queryRaw`select 1`;\n" });
    const labels = labelsOf(full);
    expect(missing(labels, dir, stack)).toEqual([expect.stringContaining("lib/raw.ts:1")]);
    const readme = "- `app` `lib/raw.ts:1`: raw query\n";
    expect(missing(labels, dir, stack, readme)).toEqual([]);
    expect(staleListed(dir, repoOf(stack), readme)).toEqual([]);
    expect(staleListed(dir, repoOf(stack), `${readme}- \`app\` \`lib/gone.ts:9\`: gone\n`)).toEqual([
      "lib/gone.ts:9",
    ]);
    expect(missing(labels, dir, ["sqlc"])).toEqual([]);
  });

  it("finds Kysely, repository and raw SQL sites", () => {
    const dir = clone({
      "db.ts": "export interface Database {\n  users: UserTable;\n  teams: TeamTable;\n}\n",
      "a.ts": "await db.selectFrom('users').execute();\nawait db.deleteFrom('teams').execute();\n",
      "b.ts": "await this.userRepository.save(x);\nawait client.query(`update app.users set a = 1`);\n",
    });
    const labels = labelsOf({ table: [{ name: "users" }, { name: "teams" }] });
    expect(missing(labels, dir, ["kysely"])).toEqual([
      expect.stringContaining("a.ts:1 read users"),
      expect.stringContaining("a.ts:2 write teams"),
    ]);
    expect(missing(labels, dir, ["typeorm"])).toEqual([expect.stringContaining("b.ts:1 write users")]);
    expect(missing(labels, dir, ["pg"])).toEqual([expect.stringContaining("b.ts:2 write users")]);
    expect(dataHits(dir, ["kysely"], null).map((h) => `${h.file}:${h.line}`)).toEqual([
      "a.ts:1",
      "a.ts:2",
      "db.ts:2",
      "db.ts:3",
    ]);
  });

  it("finds a Drizzle table whose name is on the line after pgTable(", () => {
    const dir = clone({
      "schema.ts": 'export const a = pgTable("one", {});\nexport const b = pgTable(\n  "two",\n  {},\n);\n',
    });
    expect(dataHits(dir, ["drizzle"], null).map((h) => `${h.line} ${h.text}`)).toEqual([
      "1 table one has no table label",
      "2 table two has no table label",
    ]);
  });
});

describe("check-labels on table names", () => {
  it("accepts a read whose file names the model instead of the mapped table", () => {
    const labels = labelsOf({ read: [{ file: "lib/users.ts", table: "users" }] });
    expect(checkLabels(labels, clone(prisma))).toEqual([]);
  });
});

describe("sample of table, read and write labels", () => {
  it("shows a table at its definition and a read at its call", () => {
    const dir = clone(prisma);
    const labels = labelsOf(full());
    const lines = sample(labels, dir, 1, ["prisma"]).map((s) => `${s.id} -> ${s.file}:${s.line}`);
    expect(lines).toEqual([
      "read lib/posts.ts|Post -> lib/posts.ts:1",
      "read lib/users.ts|users -> lib/users.ts:1",
      "table Post -> prisma/schema.prisma:5",
      "table users -> prisma/schema.prisma:1",
      "write lib/posts.ts|Post -> lib/posts.ts:2",
    ]);
    expect(sample(labels, dir, 2, ["prisma"]).map((s) => s.id)).toEqual([
      "read lib/posts.ts|Post",
      "table Post",
      "write lib/posts.ts|Post",
    ]);
  });
});

function full() {
  return {
    table: [{ name: "users" }, { name: "Post" }],
    read: [
      { file: "lib/posts.ts", table: "Post" },
      { file: "lib/users.ts", table: "users" },
    ],
    write: [{ file: "lib/posts.ts", table: "Post" }],
  };
}
