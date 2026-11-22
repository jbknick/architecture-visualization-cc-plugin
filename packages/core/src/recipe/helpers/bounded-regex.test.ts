import { afterAll, describe, expect, it } from "vitest";
import { REGEX_JOB_BUDGET_MS, RegexRunner } from "./bounded-regex.js";

const runner = new RegexRunner();
afterAll(() => runner.close());

const hundredKb = `${"a".repeat(100_000)}!`;

describe("bounded-regex", () => {
  it("runs a plain pattern and returns groups and indexes", () => {
    const r = runner.run("(\\w+)=(\\d+)", "g", "a=1 b=2");
    expect(r).toEqual({
      ok: true,
      matches: [
        { index: 0, groups: ["a=1", "a", "1"], starts: [0, 0, 2] },
        { index: 4, groups: ["b=2", "b", "2"], starts: [4, 4, 6] },
      ],
    });
    expect(runner.run("(x)?y", "", "y", true)).toEqual({
      ok: true,
      matches: [{ index: 0, groups: ["y", ""], starts: [0, -1] }],
    });
  });

  it("stops a catastrophic nested quantifier on a 100 KB line within the budget", () => {
    const t0 = performance.now();
    const r = new RegexRunner();
    const res = r.run("(a+)+$", "gm", hundredKb);
    r.close();
    expect(res).toMatchObject({ ok: false, reason: "timeout" });
    expect(performance.now() - t0).toBeLessThan(REGEX_JOB_BUDGET_MS + 1500);
  });

  it("stops a catastrophic alternation on a 100 KB line within the budget", () => {
    const t0 = performance.now();
    const r = new RegexRunner();
    const res = r.run("(a|a)+$", "gm", hundredKb);
    r.close();
    expect(res).toMatchObject({ ok: false, reason: "timeout" });
    expect(performance.now() - t0).toBeLessThan(REGEX_JOB_BUDGET_MS + 1500);
  });

  it("keeps working after a timeout (a new worker takes the next job)", () => {
    const r = new RegexRunner(50, 5000);
    expect(r.run("(a+)+$", "gm", hundredKb)).toMatchObject({ ok: false, reason: "timeout" });
    expect(r.run("a", "g", "aa")).toMatchObject({ ok: true });
    r.close();
  });

  it("refuses every job once the run budget is spent", () => {
    const r = new RegexRunner(50, 50);
    expect(r.run("(a+)+$", "gm", hundredKb)).toMatchObject({ ok: false, reason: "timeout" });
    expect(r.run("a", "g", "a")).toMatchObject({ ok: false, reason: "timeout" });
    r.close();
  });

  it("reports a pattern that does not compile", () => {
    expect(runner.run("(", "g", "x")).toMatchObject({ ok: false, reason: "invalid" });
  });
});
