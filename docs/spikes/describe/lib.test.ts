import { describe, expect, it } from "vitest";
import {
  factSheetTokens,
  gradeStats,
  isIdentifierLike,
  type LabelledRow,
  lengthOk,
  nameFitsMetrics,
  nameOf,
  renderFactSheet,
  schemaProblems,
  scoreItem,
  summarize,
  unknownIdentifiers,
  worstKeys,
} from "./lib.js";

// Synthetic fact sheets only: nothing here comes from the private labelled set.
function row(name: string, body: string, nameFits = true, key = `k-${name}`): LabelledRow {
  return {
    id: `sym:src/demo.ts#${name}`,
    stratum: "util",
    label: { behavior: "Does a thing.", nameFits, ...(nameFits ? {} : { suggestedName: "betterName" }) },
    factSheet: {
      contentKey: key,
      id: `sym:src/demo.ts#${name}`,
      path: "src/demo.ts",
      kind: "function",
      signature: `function ${name}(userId: string): string`,
      doc: null,
      callees: ["fetchUser"],
      returnType: null,
      body,
    },
  };
}

const good = {
  behavior: "Returns the display name for a user.",
  searchTerms: ["display name"],
  nameFits: true,
};

describe("renderFactSheet", () => {
  it("renders header, name and body", () => {
    const r = row("getName", "return user_name;");
    const text = renderFactSheet(r.factSheet);
    expect(text.startsWith("=== FACT SHEET k-getName ===")).toBe(true);
    expect(text).toContain("name: getName");
    expect(text).toContain("callees: fetchUser");
    expect(text).toContain("return user_name;");
    expect(nameOf(r.id)).toBe("getName");
  });
});

describe("schemaProblems", () => {
  it("accepts a valid description", () => {
    expect(schemaProblems(good)).toEqual([]);
  });
  it("rejects missing, wrong-typed and extra fields", () => {
    expect(schemaProblems({ ...good, behavior: "" })).toContain("behavior missing");
    expect(schemaProblems({ ...good, searchTerms: [] })).toContain("searchTerms count");
    expect(schemaProblems({ ...good, searchTerms: ["x".repeat(31)] })).toContain("searchTerm invalid");
    expect(schemaProblems({ ...good, nameFits: "yes" })).toContain("nameFits not boolean");
    expect(schemaProblems({ ...good, extra: 1 })).toContain("unknown key extra");
    expect(schemaProblems(null)).toEqual(["description is not an object"]);
  });
  it("requires suggestedName iff nameFits is false", () => {
    expect(schemaProblems({ ...good, nameFits: false })).toContain("suggestedName invalid");
    expect(schemaProblems({ ...good, nameFits: false, suggestedName: "1bad" })).toContain(
      "suggestedName invalid",
    );
    expect(schemaProblems({ ...good, nameFits: false, suggestedName: "betterName" })).toEqual([]);
    expect(schemaProblems({ ...good, suggestedName: "betterName" })).toContain(
      "suggestedName present though nameFits true",
    );
  });
  it("enforces 200 characters in the schema and 25 words in lengthOk", () => {
    expect(schemaProblems({ ...good, behavior: "a".repeat(201) })).toContain("behavior over 200 chars");
    const words26 = Array.from({ length: 26 }, () => "go").join(" ");
    expect(schemaProblems({ ...good, behavior: words26 })).toEqual([]);
    expect(lengthOk({ behavior: words26 })).toBe(false);
    expect(lengthOk({ behavior: Array.from({ length: 25 }, () => "go").join(" ") })).toBe(true);
  });
});

describe("identifier check (spec section 8 rule 3)", () => {
  const tokens = factSheetTokens(row("getName", "const fullName = user_name;").factSheet);
  it("recognises camelCase, PascalCase and snake_case but not plain words", () => {
    expect(isIdentifierLike("fullName")).toBe(true);
    expect(isIdentifierLike("MilestoneList")).toBe(true);
    expect(isIdentifierLike("user_name")).toBe(true);
    expect(isIdentifierLike("Renders")).toBe(false);
    expect(isIdentifierLike("URL")).toBe(false);
    expect(isIdentifierLike("JavaScript")).toBe(false); // stop-list
  });
  it("passes tokens present in the fact sheet", () => {
    expect(unknownIdentifiers("Returns fullName and user_name for a user.", tokens)).toEqual([]);
    expect(unknownIdentifiers("Calls fetchUser then getName.", tokens)).toEqual([]);
  });
  it("flags invented identifiers once each", () => {
    expect(unknownIdentifiers("Wraps loadProfile and loadProfile via fullName.", tokens)).toEqual([
      "loadProfile",
    ]);
    expect(unknownIdentifiers("Reads other_value.", tokens)).toEqual(["other_value"]);
  });
  it("is case sensitive", () => {
    expect(unknownIdentifiers("Reads fullname.", tokens)).toEqual([]); // all-lowercase is plain English
    expect(unknownIdentifiers("Reads FullName.", tokens)).toEqual(["FullName"]);
  });
});

describe("scoreItem and summarize pass rates", () => {
  const rows = [row("a", "x"), row("b", "y"), row("c", "z"), row("d", "w")];
  const descs = new Map<string, unknown>([
    ["k-a", good],
    ["k-b", { ...good, behavior: "Calls inventedHelper." }], // identifier failure
    ["k-c", { behavior: "No terms.", nameFits: true }], // schema failure
    // k-d missing entirely
  ]);
  it("scores single items", () => {
    expect(scoreItem(rows[0] as LabelledRow, good)).toMatchObject({ schemaOk: true, identifierOk: true });
    expect(scoreItem(rows[1] as LabelledRow, descs.get("k-b"))).toMatchObject({
      schemaOk: true,
      identifierOk: false,
      badIdentifiers: ["inventedHelper"],
    });
    expect(scoreItem(rows[3] as LabelledRow, undefined).present).toBe(false);
  });
  it("uses all rows as the denominator", () => {
    const s = summarize(rows, descs, new Map());
    expect(s.total).toBe(4);
    expect(s.described).toBe(3);
    expect(s.schemaPass).toBe(0.5); // a and b
    expect(s.identifierPass).toBe(0.25); // only a
    expect(s.grades.graded).toBe(0);
  });
});

describe("nameFitsMetrics", () => {
  it("computes precision and recall of the 'name misleads' flag", () => {
    const m = nameFitsMetrics([
      { label: false, predicted: false }, // tp
      { label: false, predicted: true }, // fn
      { label: true, predicted: false }, // fp
      { label: true, predicted: true }, // tn
      { label: true, predicted: undefined }, // not scored
    ]);
    expect(m).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1, labelledPositives: 2 });
    expect(m.precision).toBe(0.5);
    expect(m.recall).toBe(0.5);
    expect(m.agreement).toBe(0.5);
  });
  it("returns null precision when nothing was flagged and null recall when no positives are labelled", () => {
    const none = nameFitsMetrics([{ label: false, predicted: true }]);
    expect(none.precision).toBeNull();
    expect(none.recall).toBe(0);
    const noPositives = nameFitsMetrics([{ label: true, predicted: false }]);
    expect(noPositives.precision).toBe(0);
    expect(noPositives.recall).toBeNull();
  });
  it("feeds from summarize", () => {
    const rows = [row("a", "x", false), row("b", "y", true)];
    const d = new Map<string, unknown>([
      ["k-a", { ...good, nameFits: false, suggestedName: "betterName" }],
      ["k-b", { ...good, nameFits: false, suggestedName: "betterName" }],
    ]);
    const s = summarize(rows, d, new Map());
    expect(s.nameFits.precision).toBe(0.5);
    expect(s.nameFits.recall).toBe(1);
  });
});

describe("grades and retry selection", () => {
  it("counts missing grades as 0", () => {
    const g = gradeStats([2, 1, 0, undefined]);
    expect(g.mean).toBe(0.75);
    expect(g.acceptable).toBe(0.5);
    expect(g.excellent).toBe(0.25);
    expect(g.graded).toBe(3);
  });
  it("picks the worst items: low grade first, then failures, then input order", () => {
    const items = [
      { key: "a", grade: 2, identifierOk: true, schemaOk: true },
      { key: "b", grade: 0, identifierOk: true, schemaOk: true },
      { key: "c", grade: 0, identifierOk: false, schemaOk: true },
      { key: "d", grade: 1, identifierOk: true, schemaOk: true },
    ];
    expect(worstKeys(items, 3)).toEqual(["c", "b", "d"]);
  });
});
