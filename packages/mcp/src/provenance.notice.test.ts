// #180 item 5: the untrusted notices name all three provenances, and the node tool no longer says fallbacks are
// written "from names only" (they repeat no name since #175).
import { describe, expect, it } from "vitest";
import { UNTRUSTED_NOTICE } from "./tool.js";
import { TOOLS } from "./tools/index.js";

describe("provenance wording of the untrusted notices", () => {
  it("the shared notice names model, template and fallback text", () => {
    expect(UNTRUSTED_NOTICE).toMatch(/written by a model/);
    expect(UNTRUSTED_NOTICE).toMatch(/copied from the code by a template/);
    expect(UNTRUSTED_NOTICE).toMatch(/attacker can write/);
    expect(UNTRUSTED_NOTICE).toMatch(/fallback/);
    expect(UNTRUSTED_NOTICE).toMatch(/described_by/);
  });

  it("every tool description carries the notice", () => {
    for (const t of TOOLS) expect([t.name, t.description.includes(UNTRUSTED_NOTICE)]).toEqual([t.name, true]);
  });

  it("no tool description says a fallback is written from names", () => {
    for (const t of TOOLS) expect([t.name, /names only/i.test(t.description)]).toEqual([t.name, false]);
    const node = TOOLS.find((t) => t.name === "gantry_node");
    expect(node?.description).toMatch(/fallback: a fixed sentence Gantry generated without a model/);
    expect(node?.description).toMatch(
      /template: text copied from the code itself, which can be written by an attacker/,
    );
  });
});
