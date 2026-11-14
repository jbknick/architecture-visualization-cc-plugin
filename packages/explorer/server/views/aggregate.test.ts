import type { EdgeRecord } from "@gantry/core";
import { describe, expect, it } from "vitest";
import { ImportAggregator } from "./aggregate.js";

const edge = (src: string, dst: string, count: number, confidence: "high" | "low" = "high"): EdgeRecord =>
  ({ src, dst, kind: "imports", count, confidence, fileId: src }) as EdgeRecord;

describe("ImportAggregator", () => {
  it("counts distinct file pairs as imports and sums bindings separately", () => {
    const agg = new ImportAggregator();
    agg.add("A", "B", edge("file:a1", "file:b1", 5));
    agg.add("A", "B", edge("file:a1", "file:b2", 2));
    agg.add("A", "B", edge("file:a2", "file:b1", 1));
    agg.add("A", "B", edge("file:a1", "file:b1", 5)); // same pair again: not counted twice
    const [e] = agg.edges();
    expect(e).toMatchObject({ id: "A|imports|B", kind: "imports", weight: 3, bindings: 8 });
  });

  it("omits bindings when it equals the import count, ignores self pairs, and keeps direction", () => {
    const agg = new ImportAggregator();
    agg.add("A", "B", edge("file:a1", "file:b1", 1));
    agg.add("B", "A", edge("file:b1", "file:a1", 1, "low"));
    agg.add("A", "A", edge("file:a1", "file:a2", 1));
    const edges = agg.edges();
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({
      id: "A|imports|B",
      src: "A",
      dst: "B",
      kind: "imports",
      weight: 1,
      confidence: "high",
    });
    expect(edges[1]?.confidence).toBe("low");
  });
});
