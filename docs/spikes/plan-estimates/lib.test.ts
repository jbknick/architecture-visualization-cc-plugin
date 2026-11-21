import { describe, expect, it } from "vitest";
import { type PlanText, planText, prKey, quantile, seededShuffle } from "./lib.js";

describe("quantile", () => {
  it("interpolates and handles the edges", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([5], 0.75)).toBe(5);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe("seededShuffle", () => {
  it("is a permutation and repeats for one seed", () => {
    const xs = Array.from({ length: 30 }, (_, i) => i);
    const a = seededShuffle(xs, 1);
    expect(a).toEqual(seededShuffle(xs, 1));
    expect([...a].sort((x, y) => x - y)).toEqual(xs);
    expect(a).not.toEqual(seededShuffle(xs, 2));
  });
});

describe("planText", () => {
  const long = "x".repeat(200);
  it("uses the PR description when it has 200 characters", () => {
    const t: PlanText = { title: "T", body: long, issueBody: "issue" };
    expect(planText(t)).toBe(`T\n\n${long}`);
  });
  it("adds the linked issue body to a short description", () => {
    const t: PlanText = { title: "T", body: "short", issueBody: "issue" };
    expect(planText(t)).toBe("T\n\nshort\n\nissue");
  });
});

describe("prKey", () => {
  it("joins repo and number", () => {
    expect(prKey({ repo: "cal.com", number: 7 })).toBe("cal.com#7");
  });
});
