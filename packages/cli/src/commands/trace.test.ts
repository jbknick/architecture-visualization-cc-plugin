import type { TraceResult } from "@gantry/core";
import { describe, expect, it } from "vitest";
import { traceText } from "./trace.js";

const result = (repo: boolean): TraceResult => ({
  target: "route:web:.:/invoices/$id",
  direction: "down",
  chain: [
    { id: "route:web:.:/invoices/$id", kind: "route", label: "/invoices/$id", via: "target", depth: 0 },
    {
      id: "ep:billing:.:GET /invoices/:id",
      kind: "endpoint",
      label: "GET /invoices/:id",
      via: "requests",
      depth: 2,
    },
    { id: "table:billing:invoices", kind: "table", label: "invoices", via: "reads", depth: 4 },
  ].map((s) => ({ ...s, ...(repo ? { repo: s.id.split(":")[1] } : {}) })),
  edges: [],
  gaps: [],
  omitted: 0,
  truncated: false,
});

describe("traceText", () => {
  it("leads each step with its repo when the workspace has several", () => {
    expect(traceText(result(true))).toBe(
      [
        "Down from route:web:.:/invoices/$id",
        "    [billing] requests → endpoint ep:billing:.:GET /invoices/:id",
        "        [billing] reads → table table:billing:invoices",
        "",
      ].join("\n"),
    );
  });

  it("prints no repo for a store with one repo", () => {
    expect(traceText(result(false))).not.toContain("[");
  });
});
