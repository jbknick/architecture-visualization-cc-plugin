import { describe, expect, it } from "vitest";
import { shortWorkspaceLabels } from "./labels.js";

describe("shortWorkspaceLabels", () => {
  it("strips the scope shared by most scoped workspaces and keeps unscoped names", () => {
    const names = [
      "@some-long-org-scope/api",
      "@some-long-org-scope/web",
      "@some-long-org-scope/core",
      "tooling",
      "scripts",
    ];
    const m = shortWorkspaceLabels(names);
    expect(names.map((n) => m.get(n))).toEqual(["api", "web", "core", "tooling", "scripts"]);
  });

  it("keeps minority scopes in full", () => {
    const names = ["@a/x", "@a/y", "@a/z", "@b/w"];
    const m = shortWorkspaceLabels(names);
    expect([...m.values()]).toEqual(["x", "y", "z", "@b/w"]);
  });

  it("keeps full names when no scope is shared by a majority", () => {
    const names = ["@a/x", "@b/y", "@c/z"];
    expect([...shortWorkspaceLabels(names).values()]).toEqual(names);
  });

  it("falls back to full names on a collision", () => {
    const m = shortWorkspaceLabels(["@a/x", "@a/y", "x"]);
    expect(m.get("@a/x")).toBe("@a/x");
    expect(m.get("x")).toBe("x");
    expect(m.get("@a/y")).toBe("y");
  });
});
