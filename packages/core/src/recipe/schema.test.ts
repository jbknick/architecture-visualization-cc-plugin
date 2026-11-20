import { describe, expect, it } from "vitest";
import { parseRecipe } from "./load.js";
import { RecipeSchema, RuleSchema } from "./schema.js";

const rule = {
  id: "hono-route",
  language: "typescript",
  when: { dependency: ["hono"] },
  rule: { pattern: "$APP.get($P, $$$H)" },
  constraints: { P: { kind: "string" } },
  emit: {
    kind: "endpoint",
    receiver: "$APP",
    method: "=GET",
    path: "$P",
    handler: "$$$H",
    data: { adapter: "hono" },
  },
  examples: { match: ["app.get('/a', h)"], noMatch: ["app.use('/a', h)"] },
};
const recipe = (over: Record<string, unknown> = {}) => ({
  version: 1,
  dependencies: [{ name: "hono", role: "framework", note: "HTTP framework" }],
  helpers: ["resolve-names", "mount-graph"],
  rules: [rule],
  ...over,
});

describe("RecipeSchema", () => {
  it("accepts a complete recipe", () => {
    expect(RecipeSchema.safeParse(recipe()).success).toBe(true);
  });

  it("accepts every emit kind", () => {
    const emits = [
      { kind: "router", base: "$B" },
      { kind: "mount", parent: "$P", prefix: "$X", child: "$$$C", childIsScope: true },
      { kind: "endpoint", receiver: "$R", method: "$M", handler: "$H", pathFromChain: true },
      { kind: "middleware", receiver: "$R", path: "$P", handler: "$$$H" },
      { kind: "route", id: "$ID", options: "$O", root: false },
      { kind: "fileRoute", convention: "tanstack-router", id: "$ID", options: "$O" },
    ];
    for (const emit of emits) expect(RuleSchema.safeParse({ ...rule, emit }).success).toBe(true);
  });

  it("accepts the data-access emits, the helpers' recipe fields and a text rule", () => {
    const emits = [
      {
        kind: "table",
        name: "$N",
        model: "@class",
        binding: true,
        data: { adapter: "x", columns: { keysOf: "$$$A" } },
      },
      { kind: "table", name: ["$N", "@class"] },
      { kind: "read", table: "$T" },
      { kind: "write", model: "$$$M", method: "$M" },
      { kind: "read", receiver: "$R", receiverDecl: ["\\bx\\s*:\\s*Repo<(\\w+)>"], method: "$M" },
    ];
    for (const emit of emits) expect(RuleSchema.safeParse({ ...rule, emit }).success).toBe(true);
    expect(
      RecipeSchema.safeParse(
        recipe({
          helpers: ["sql-text", "text-rules", "model-naming", "method-classes"],
          models: { explicit: { User: "users" }, snakeCase: true, plural: true },
          methods: { read: ["find"], write: ["save"] },
          tablePassthrough: ["alias"],
          sql: { tags: ["sql"], files: ["src/**"], exclude: ["test/**"], sqlFiles: ["db/**/*.sql"] },
        }),
      ).success,
    ).toBe(true);
    const text = {
      id: "model",
      language: "text",
      files: ["**/*.schema"],
      rule: { regex: "^model\\s+(\\w+)", flags: "gm" },
      emit: { kind: "table", name: "$1", model: "$1" },
      examples: { match: ["model A"], noMatch: [] },
    };
    expect(RuleSchema.safeParse(text).success).toBe(true);
    expect(RuleSchema.safeParse({ ...text, files: [] }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...text, emit: { kind: "read", table: "$1" } }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...text, emit: { ...text.emit, name: "$N" } }).success).toBe(false);
  });

  it("rejects a read or write that names no table source, and a text rule with no files", () => {
    expect(RuleSchema.safeParse({ ...rule, emit: { kind: "read", method: "$M" } }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, emit: { kind: "write", receiver: "$R" } }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, emit: { kind: "table", name: "plain" } }).success).toBe(false);
  });

  it("rejects an unknown key at the top, in a rule, in an emit and in a dependency", () => {
    expect(RecipeSchema.safeParse(recipe({ extra: 1 })).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, extra: 1 }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, emit: { ...rule.emit, extra: 1 } }).success).toBe(false);
    expect(
      RecipeSchema.safeParse(recipe({ dependencies: [{ name: "x", role: "neither", note: "", extra: 1 }] }))
        .success,
    ).toBe(false);
  });

  it("rejects an unknown emit kind, helper, dependency role and convention", () => {
    expect(RuleSchema.safeParse({ ...rule, emit: { kind: "exec", run: "rm -rf /" } }).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ helpers: ["eval"] })).success).toBe(false);
    expect(
      RecipeSchema.safeParse(recipe({ dependencies: [{ name: "x", role: "admin", note: "" }] })).success,
    ).toBe(false);
    expect(
      RuleSchema.safeParse({ ...rule, emit: { kind: "fileRoute", convention: "next-app" } }).success,
    ).toBe(false);
  });

  it("checks an ast-grep rule's own shape: a non-string pattern and unknown keys fail", () => {
    expect(RuleSchema.safeParse({ ...rule, rule: { pattern: 42 } }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, rule: { script: "x" } }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, rule: {} }).success).toBe(false);
    expect(
      RuleSchema.safeParse({
        ...rule,
        rule: { pattern: "f($A)", inside: { kind: "function_declaration", stopBy: "end" } },
      }).success,
    ).toBe(true);
  });

  it("a rule with a code-like string is still only data", () => {
    const g = globalThis as { __ran?: boolean };
    const sneaky = {
      ...rule,
      id: "sneaky",
      rule: { pattern: "(() => { globalThis.__ran = true })()" },
      emit: { ...rule.emit, path: "$P" },
      examples: { match: ["require('child_process').execSync('touch /tmp/x')"], noMatch: [] },
    };
    const r = parseRecipe(JSON.stringify(recipe({ rules: [sneaky] })));
    expect(r.errors).toEqual([]);
    expect(r.recipe?.rules[0]?.rule).toEqual({ pattern: "(() => { globalThis.__ran = true })()" });
    expect(g.__ran).toBeUndefined();
  });

  it("requires examples, a language of typescript and a recognisable capture", () => {
    const { examples: _e, ...noExamples } = rule;
    expect(RuleSchema.safeParse(noExamples).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, language: "go" }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, emit: { ...rule.emit, receiver: "APP" } }).success).toBe(false);
  });
});
