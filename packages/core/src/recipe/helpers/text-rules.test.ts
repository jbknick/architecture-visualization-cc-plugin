import { afterAll, describe, expect, it } from "vitest";
import { RegexRunner } from "./bounded-regex.js";
import { groupValue, matchText, runTextExamples, textRuleMatches } from "./text-rules.js";

const runner = new RegexRunner();
afterAll(() => runner.close());

const schema = `datasource db {
  provider = "postgresql"
}

model User {
  id Int @id
  @@map("users")
}

model Post {
  id Int @id
}
`;

const rule = (regex: string, flags?: string) => ({ files: ["*"], rule: { regex, flags } });
const ok = (r: ReturnType<typeof matchText>) => {
  if (!r.ok) throw new Error(`regex run failed: ${r.reason}`);
  return r.matches;
};

describe("text-rules", () => {
  it("matches a file against the rule's globs", () => {
    const r = { files: ["**/*.prisma", "db/*.sql"], rule: { regex: "x" } };
    expect(textRuleMatches(r, "prisma/schema.prisma")).toBe(true);
    expect(textRuleMatches(r, "db/001.sql")).toBe(true);
    expect(textRuleMatches(r, "src/app.ts")).toBe(false);
  });

  it("emits a match per model block of a schema file, with groups and lines", () => {
    const ms = ok(matchText(runner, rule("^model\\s+(\\w+)\\s*\\{"), schema));
    expect(ms.map((m) => [m.groups[1], m.line])).toEqual([
      ["User", 5],
      ["Post", 10],
    ]);
  });

  it("reads a table out of SQL migrations by a line rule", () => {
    const ms = ok(
      matchText(
        runner,
        rule("^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?(\\w+)", "gmi"),
        "create table if not exists accounts (id int);\nCREATE TABLE audit (id int);",
      ),
    );
    expect(ms.map((m) => m.groups[1])).toEqual(["accounts", "audit"]);
  });

  it("reports a regex that does not compile", () => {
    const r = matchText(runner, rule("("), "x");
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reads groups and literals", () => {
    const m = { groups: ["all", "User", "users"], line: 1, groupLines: [1, 1, 1] };
    expect(groupValue("$1", m)).toBe("User");
    expect(groupValue("$2", m)).toBe("users");
    expect(groupValue("$9", m)).toBe("");
    expect(groupValue("=fixed", m)).toBe("fixed");
  });

  it("checks examples", () => {
    const good = runTextExamples(runner, {
      ...rule("^model\\s+(\\w+)"),
      examples: { match: ["model A {"], noMatch: ["enum B {"] },
    });
    expect(good).toEqual({ passed: 2, failed: [] });
    const bad = runTextExamples(runner, {
      ...rule("^model\\s+(\\w+)"),
      examples: { match: ["enum B {"], noMatch: ["model A {"] },
    });
    expect(bad.failed).toHaveLength(2);
  });
});
