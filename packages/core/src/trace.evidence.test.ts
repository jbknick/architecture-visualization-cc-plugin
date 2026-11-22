import { describe, expect, it } from "vitest";
import { EVIDENCE_CAP } from "./resolve/index.js";
import { inSpans } from "./trace.js";
import type { EdgeRecord } from "./types.js";

const edge = (evidence: string[], count: number): EdgeRecord => ({
  src: "sym:a:x.ts#f",
  dst: "sym:b:y.ts#g",
  kind: "calls",
  confidence: "high",
  count,
  evidence,
  fileId: "file:a:x.ts",
});
const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `x.ts:${i + 100}`);

describe("span checks of an edge that also notes a sibling repo", () => {
  const spans = [{ start: 1, end: 10 }];

  it("does not count the sibling note as an evidence line", () => {
    // 19 lines and the note: the lines are not capped, so a call with 19 uses is judged by them.
    expect(inSpans(edge([...lines(EVIDENCE_CAP - 1), "sibling:acme/api"], EVIDENCE_CAP), spans)).toBe("no");
  });

  it("still reports capped evidence when all the line entries are kept", () => {
    expect(inSpans(edge([...lines(EVIDENCE_CAP), "sibling:acme/api"], EVIDENCE_CAP + 5), spans)).toBe(
      "capped",
    );
  });

  it("finds a line inside a span past the note", () => {
    expect(inSpans(edge(["x.ts:5", "sibling:acme/api"], 1), spans)).toBe("yes");
  });
});
