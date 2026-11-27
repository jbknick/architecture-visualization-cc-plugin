import { describe, expect, it } from "vitest";
import {
  buildPath,
  changeSetIdForBranch,
  changeSetIdForPr,
  decodeTarget,
  encodeTarget,
  parseChangeSetId,
  ROUTES,
} from "./index.js";

describe("change set ids", () => {
  it("builds the two forms", () => {
    expect(changeSetIdForPr("acme/shop", 12)).toBe("cs:pr:acme/shop#12");
    expect(changeSetIdForBranch("acme/shop", "feat/x")).toBe("cs:branch:acme/shop:feat/x");
  });

  it("round-trips through parseChangeSetId", () => {
    expect(parseChangeSetId(changeSetIdForPr("acme/shop", 12))).toEqual({
      source: "pr",
      repo: "acme/shop",
      pr: 12,
    });
    expect(parseChangeSetId(changeSetIdForBranch("acme/shop", "feat/x#1"))).toEqual({
      source: "branch",
      repo: "acme/shop",
      name: "feat/x#1",
    });
  });

  it("returns undefined for anything else", () => {
    for (const id of [
      "main",
      "cs:pr:acme/shop#0",
      "cs:pr:acme/shop#x",
      "cs:pr:shop#1",
      "cs:ticket:jira:ABC-1",
      "",
    ]) {
      expect(parseChangeSetId(id), id).toBeUndefined();
    }
    expect(parseChangeSetId(`cs:branch:acme/shop:${"x".repeat(1024)}`)).toBeUndefined();
  });
});

describe("buildPath", () => {
  it("encodes a repo and a change set id", () => {
    expect(buildPath(ROUTES.beginUpload, { repo: "acme/shop" })).toBe("/v1/repos/acme%2Fshop/uploads");
    expect(buildPath(ROUTES.closeChangeSet, { repo: "acme/shop", id: "cs:pr:acme/shop#12" })).toBe(
      "/v1/repos/acme%2Fshop/change-sets/cs%3Apr%3Aacme%2Fshop%2312/close",
    );
  });

  it("fills a numeric part number and leaves a static path alone", () => {
    expect(buildPath(ROUTES.putPart, { id: "5f3a9c1e7b2d4a60918c3e7d", n: 3 })).toBe(
      "/v1/uploads/5f3a9c1e7b2d4a60918c3e7d/parts/3",
    );
    expect(buildPath(ROUTES.pull)).toBe("/v1/pull");
  });

  it("decodes back to the id, and throws on a missing parameter", () => {
    const id = changeSetIdForBranch("acme/shop", "feat/ü 100%");
    const path = buildPath(ROUTES.closeChangeSet, { repo: "acme/shop", id });
    const segment = path.split("/")[5] as string;
    expect(decodeURIComponent(segment)).toBe(id);
    expect(() => buildPath(ROUTES.closeChangeSet, { repo: "acme/shop" })).toThrow(/:id/);
  });
});

describe("target header", () => {
  it("leaves main alone and round-trips awkward branch names", () => {
    expect(encodeTarget("main")).toBe("main");
    expect(encodeTarget("cs:pr:fixture/pnpm-turbo#1")).toBe("cs%3Apr%3Afixture%2Fpnpm-turbo%231");
    for (const name of ["feat/100%", "feat/%41", "feature/日本語", "feat/émoji-🚀"]) {
      const id = changeSetIdForBranch("acme/shop", name);
      const header = encodeTarget(id);
      expect(/^[\x20-\x7e]*$/.test(header), header).toBe(true);
      expect(decodeTarget(header)).toBe(id);
    }
  });

  it("throws on a malformed value", () => {
    expect(() => decodeTarget("%E0%A4%A")).toThrow(URIError);
  });
});
