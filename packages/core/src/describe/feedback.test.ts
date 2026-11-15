import { describe, expect, it } from "vitest";
import { ATTACK_CORPUS, attackSheet } from "./corpus.attack.js";
import { ATTACK_CORPUS_2 } from "./corpus.attack2.js";
import { allFeedbackFixes, allFeedbackRules, rejectionFeedback } from "./feedback.js";
import { sheet as sessionSheet } from "./validate.fixtures.js";
import { validateDescription } from "./validate.js";

const RULE_REASONS = ["schema", "length", "shape", "identifier", "injection", "secret"];
const FIXES = new Set(allFeedbackFixes());
const RULES = new Set(allFeedbackRules());

describe("rejectionFeedback (#150)", () => {
  it("gives a fixed rule and rewrite instruction for every validator reason", () => {
    for (const reason of RULE_REASONS) {
      const f = rejectionFeedback(reason, "");
      expect(f).not.toBeNull();
      expect(f?.rule).toBe(reason);
      expect(f?.field).toBe("behavior");
      expect(FIXES.has(f?.fix as string)).toBe(true);
    }
  });

  it("names the issue's rewrite instructions for shape, injection and identifier", () => {
    expect(rejectionFeedback("shape", "behavior: something else")?.fix).toBe(
      "Write one plain sentence about what it does, no lists, code or quotes.",
    );
    expect(rejectionFeedback("injection", "behavior and terms: x")?.fix).toMatch(
      /^Describe behaviour only; do not mention instructions, prompts, roles or the reader/,
    );
    expect(rejectionFeedback("identifier", "behavior not in the fact sheet: abc…")?.fix).toMatch(
      /^Name only identifiers that appear in the code shown/,
    );
  });

  it("picks a sub-rule from the validator's rule codes and the field from the detail's head", () => {
    expect(rejectionFeedback("shape", "behavior: first-word")).toMatchObject({
      rule: "shape.first-word",
      field: "behavior",
    });
    expect(rejectionFeedback("shape", "searchTerms: a term of function words only")).toMatchObject({
      rule: "shape.function-words-only",
      field: "searchTerms",
    });
    expect(rejectionFeedback("injection", "suggestedName: directive name")).toMatchObject({
      rule: "injection.directive",
      field: "suggestedName",
    });
    expect(rejectionFeedback("injection", "behavior: permission-claim")?.rule).toBe(
      "injection.permission-claim",
    );
  });

  it("does not echo an ungrounded token that the validator's own detail does echo", () => {
    const sheet = sessionSheet();
    const v = validateDescription(
      { behavior: "Returns the zqxjvortle value for a session.", searchTerms: ["session"], nameFits: true },
      sheet,
    );
    expect(v).toMatchObject({ ok: false, reason: "identifier" });
    if (v.ok) return;
    expect(v.detail).toContain("zqxjvortle");
    const f = rejectionFeedback(v.reason, v.detail);
    expect(JSON.stringify(f)).not.toContain("zqxj");
    expect(f?.rule).toBe("identifier");
  });

  it("returns null for reasons that need no rewrite, and for prototype keys", () => {
    for (const r of [
      "not_in_batch",
      "attempts_exhausted",
      "stale",
      "unavailable",
      "duplicate",
      "constructor",
      "toString",
      "__proto__",
      "",
    ])
      expect(rejectionFeedback(r, "behavior: first-word")).toBeNull();
  });

  it("never echoes the detail: rule and fix come from the closed lists whatever the detail holds", () => {
    const marker = "ZQXJ_marker_9f3e";
    for (const reason of RULE_REASONS) {
      for (const detail of [
        `behavior not in the fact sheet: ${marker}…`,
        `searchTerms: ${marker} first-word`,
        `${marker}: speech-act`,
        marker,
      ]) {
        const f = rejectionFeedback(reason, detail);
        expect(RULES.has(f?.rule as string)).toBe(true);
        expect(FIXES.has(f?.fix as string)).toBe(true);
        expect(JSON.stringify(f)).not.toContain(marker);
        expect(JSON.stringify(f).toLowerCase()).not.toContain("zqxj");
      }
    }
  });

  it("answers every rejected attack of both corpora from the closed lists, never with the rejected text", () => {
    let checked = 0;
    const cases = [
      ...ATTACK_CORPUS.map((c) => ({ c, sheet: attackSheet() })),
      ...ATTACK_CORPUS_2.map((c) => ({ c, sheet: c.sheet ?? sessionSheet() })),
    ];
    for (const { c, sheet } of cases) {
      const raw: Record<string, unknown> = {
        behavior: c.behavior,
        searchTerms: c.terms ? [...c.terms] : ["user lookup"],
        nameFits: c.name === undefined,
      };
      if (c.name !== undefined) raw.suggestedName = c.name;
      const v = validateDescription(raw, sheet);
      if (v.ok) continue;
      const f = rejectionFeedback(v.reason, v.detail);
      expect(f).not.toBeNull();
      expect(RULES.has(f?.rule as string)).toBe(true);
      expect(FIXES.has(f?.fix as string)).toBe(true);
      const text = JSON.stringify(f).toLowerCase();
      expect(text).not.toContain(c.behavior.toLowerCase());
      checked++;
    }
    expect(checked).toBeGreaterThan(350);
  });
});
