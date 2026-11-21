import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  holdsTable,
  sameTable,
  sampleLabels,
  unlabelledCandidates,
} from "../../scripts/eval-label-candidates.js";
import { checkLabels } from "../../scripts/eval-label-check.js";
import { labelsSchema } from "../../scripts/eval-lib.js";

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

describe("unlabelledCandidates", () => {
  const stack = ["nextjs", "prisma"];

  it("reports nothing when every definition and access is labelled", () => {
    const labels = labelsOf({
      table: [{ name: "users" }, { name: "Post" }],
      read: [
        { file: "lib/posts.ts", table: "Post" },
        { file: "lib/users.ts", table: "users" },
      ],
      write: [{ file: "lib/posts.ts", table: "Post" }],
    });
    expect(unlabelledCandidates(labels, clone(prisma), stack)).toEqual([]);
  });

  it("reports an unlabelled table, read and write, and leaves tests out", () => {
    const dir = clone(prisma);
    const noTable = labelsOf({
      table: [{ name: "users" }],
      read: [{ file: "lib/users.ts", table: "users" }],
    });
    expect(unlabelledCandidates(noTable, dir, stack)).toEqual([
      "table Post defined at prisma/schema.prisma:5 has no table label",
    ]);
    const labels = labelsOf({
      table: [{ name: "users" }, { name: "Post" }],
      read: [{ file: "lib/users.ts", table: "users" }],
    });
    expect(unlabelledCandidates(labels, dir, stack)).toEqual([
      expect.stringContaining("read lib/posts.ts:1 Post"),
      expect.stringContaining("write lib/posts.ts:2 Post"),
    ]);
  });

  it("accepts an unresolved entry for a call that names no table, and scans only known stacks", () => {
    const files = { ...prisma, "lib/raw.ts": "await db.$queryRaw`select 1`;\n" };
    const base = {
      table: [{ name: "users" }, { name: "Post" }],
      read: [
        { file: "lib/posts.ts", table: "Post" },
        { file: "lib/users.ts", table: "users" },
      ],
      write: [{ file: "lib/posts.ts", table: "Post" }],
    };
    const dir = clone(files);
    expect(unlabelledCandidates(labelsOf(base), dir, stack)).toEqual([
      expect.stringContaining("lib/raw.ts:1"),
    ]);
    const withReason = labelsOf({
      ...base,
      unresolved: [{ file: "lib/raw.ts", line: 1, reason: "raw query" }],
    });
    expect(unlabelledCandidates(withReason, dir, stack)).toEqual([]);
    expect(unlabelledCandidates(labelsOf(base), dir, ["sqlc"])).toEqual([]);
  });

  it("finds Kysely, repository and raw SQL sites", () => {
    const files = {
      "db.ts": "export interface Database {\n  users: UserTable;\n  teams: TeamTable;\n}\n",
      "a.ts": "await db.selectFrom('users').execute();\nawait db.deleteFrom('teams').execute();\n",
      "b.ts": "await this.userRepository.save(x);\nawait client.query(`update app.users set a = 1`);\n",
    };
    const dir = clone(files);
    const labels = labelsOf({ table: [{ name: "users" }, { name: "teams" }] });
    expect(unlabelledCandidates(labels, dir, ["kysely"])).toEqual([
      expect.stringContaining("read a.ts:1 users"),
      expect.stringContaining("write a.ts:2 teams"),
    ]);
    expect(unlabelledCandidates(labels, dir, ["typeorm"])).toEqual([
      expect.stringContaining("write b.ts:1 users"),
    ]);
    expect(unlabelledCandidates(labels, dir, ["pg"])).toEqual([
      expect.stringContaining("write b.ts:2 users"),
    ]);
  });
});

describe("check-labels on table names", () => {
  it("accepts a read whose file names the model instead of the mapped table", () => {
    const labels = labelsOf({ read: [{ file: "lib/users.ts", table: "users" }] });
    expect(checkLabels(labels, clone(prisma))).toEqual([]);
  });
});

describe("sampleLabels", () => {
  it("takes every n-th label in sorted order", () => {
    const labels = labelsOf({
      table: [{ name: "b" }, { name: "a" }, { name: "c" }],
      read: [{ file: "x.ts", table: "a" }],
    });
    expect(sampleLabels(labels, 2)).toEqual(["table a", "table c"]);
    expect(sampleLabels(labels, 1)).toEqual(["read x.ts|a", "table a", "table b", "table c"]);
    expect(sampleLabels(labels, 10)).toEqual([]);
  });
});
