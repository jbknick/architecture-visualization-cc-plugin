import type { EdgeRecord } from "@gantry/core";
import { describe, expect, it } from "vitest";
import { inSpan } from "./endpoints.js";

const edge = (evidence: string[], count: number): EdgeRecord => ({
  src: "sym:a:x.ts#f",
  dst: "sym:b:y.ts#g",
  kind: "calls",
  confidence: "high",
  count,
  evidence,
  fileId: "file:a:x.ts",
});

describe("the handler span check of an edge that also notes a sibling repo", () => {
  const span = { start: 1, end: 10 };

  it("does not take the sibling note for a kept line", () => {
    // Two calls, one line kept outside the span, one dropped by the cap: the dropped one may be inside.
    expect(inSpan(edge(["x.ts:50", "sibling:acme/api"], 2), span)).toBe(true);
  });

  it("is false when every line is kept and none is inside", () => {
    expect(inSpan(edge(["x.ts:50", "sibling:acme/api"], 1), span)).toBe(false);
  });
});
