import { describe, expect, it } from "vitest";
import { compileTextRule, groupValue, matchText, runTextExamples, textRuleMatches } from "./text-rules.js";

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

describe("text-rules", () => {
  it("matches a file against the rule's globs", () => {
    const rule = { files: ["**/*.prisma", "db/*.sql"], rule: { regex: "x" } };
    expect(textRuleMatches(rule, "prisma/schema.prisma")).toBe(true);
    expect(textRuleMatches(rule, "db/001.sql")).toBe(true);
    expect(textRuleMatches(rule, "src/app.ts")).toBe(false);
  });

  it("emits a match per model block of a schema file, with groups and lines", () => {
    const rx = compileTextRule({ files: ["*"], rule: { regex: "^model\\s+(\\w+)\\s*\\{" } });
    const ms = matchText(rx as RegExp, schema);
    expect(ms.map((m) => [m.groups[1], m.line])).toEqual([
      ["User", 5],
      ["Post", 10],
    ]);
  });

  it("reads a table out of SQL migrations by a line rule", () => {
    const rx = compileTextRule({
      files: ["*"],
      rule: { regex: "^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?(\\w+)", flags: "gmi" },
    });
    const ms = matchText(
      rx as RegExp,
      "create table if not exists accounts (id int);\nCREATE TABLE audit (id int);",
    );
    expect(ms.map((m) => m.groups[1])).toEqual(["accounts", "audit"]);
  });

  it("rejects a regex that does not compile", () => {
    expect(compileTextRule({ files: ["*"], rule: { regex: "(" } })).toBeNull();
  });

  it("reads groups and literals", () => {
    const m = { groups: ["all", "User", "users"], line: 1 };
    expect(groupValue("$1", m)).toBe("User");
    expect(groupValue("$2", m)).toBe("users");
    expect(groupValue("$9", m)).toBe("");
    expect(groupValue("=fixed", m)).toBe("fixed");
  });

  it("checks examples", () => {
    const ok = runTextExamples({
      files: ["*"],
      rule: { regex: "^model\\s+(\\w+)" },
      examples: { match: ["model A {"], noMatch: ["enum B {"] },
    });
    expect(ok).toEqual({ passed: 2, failed: [] });
    const bad = runTextExamples({
      files: ["*"],
      rule: { regex: "^model\\s+(\\w+)" },
      examples: { match: ["enum B {"], noMatch: ["model A {"] },
    });
    expect(bad.failed).toHaveLength(2);
  });
});
