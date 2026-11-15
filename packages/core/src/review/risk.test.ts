import { describe, expect, it } from "vitest";
import { computeRisk, RISK_CAP, RISK_RULES, type RiskFacts, riskLevel } from "./risk.js";

const none: RiskFacts = {
  signatureChangedExported: false,
  removedExportedWithCallers: false,
  hop1Callers: 0,
  crossings: 0,
  maxComplexity: 0,
  untested: false,
};

describe("computeRisk", () => {
  it("scores nothing as 0 and low", () => {
    expect(computeRisk(none)).toEqual({ score: 0, level: "low", reasons: [] });
  });

  it("adds each rule with its points and lists them in table order", () => {
    const r = computeRisk({ ...none, signatureChangedExported: true, hop1Callers: 3, untested: true });
    expect(r.score).toBe(46);
    expect(r.level).toBe("medium");
    expect(r.reasons).toEqual([
      "+30 signature changed on an exported symbol",
      "+6 3 direct callers",
      "+10 changed function in a file no test imports",
    ]);
  });

  it("caps callers and crossings at 20 points each and the sum at 100", () => {
    const r = computeRisk({ ...none, hop1Callers: 50, crossings: 50 });
    expect(r.reasons).toEqual(["+20 50 direct callers", "+20 50 boundary crossings"]);
    const all = computeRisk({
      signatureChangedExported: true,
      removedExportedWithCallers: true,
      hop1Callers: 50,
      crossings: 50,
      maxComplexity: 40,
      untested: true,
    });
    expect(all.score).toBe(RISK_CAP);
    expect(all.level).toBe("high");
    expect(all.reasons).toHaveLength(6);
  });

  it("uses complexity strictly above 15", () => {
    expect(computeRisk({ ...none, maxComplexity: 15 }).score).toBe(0);
    expect(computeRisk({ ...none, maxComplexity: 16 }).score).toBe(10);
  });

  it("maps scores to levels: below 30 low, below 60 medium, else high", () => {
    expect([0, 29, 30, 59, 60, 100].map(riskLevel)).toEqual([
      "low",
      "low",
      "medium",
      "medium",
      "high",
      "high",
    ]);
  });

  it("keeps the scoring table in one exported constant", () => {
    expect(RISK_RULES.map((r) => r.points)).toEqual([30, 30, 2, 5, 10, 10]);
  });
});
