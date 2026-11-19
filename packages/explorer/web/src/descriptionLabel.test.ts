import { describe, expect, it } from "vitest";
import { descriptionLabel } from "./descriptionLabel.ts";

describe("descriptionLabel (#180)", () => {
  it("names each provenance and never says a fallback is written from names", () => {
    expect(descriptionLabel("model")).toBe("Generated description — may be wrong");
    expect(descriptionLabel(undefined)).toBe("Generated description — may be wrong");
    expect(descriptionLabel("template")).toBe("Template text copied from the code — may be wrong");
    expect(descriptionLabel("fallback")).toMatch(/^Generated without a model from the kind/);
    for (const by of ["model", "template", "fallback", undefined] as const)
      expect(descriptionLabel(by)).not.toMatch(/names only/);
  });
});
