import { describe, expect, it } from "vitest";
import { formatHash, parseHash } from "./route.ts";

describe("hash route", () => {
  it("parses view, focus, depth and filters", () => {
    expect(parseHash("#/debug?focus=sym%3Aa%23B&depth=2&kind=hook&q=a%20b")).toEqual({
      view: "debug",
      focus: "sym:a#B",
      depth: 2,
      filters: { kind: "hook", q: "a b" },
    });
  });

  it("treats an empty hash as no view", () => {
    expect(parseHash("")).toEqual({ view: null, focus: null, depth: null, filters: {} });
    expect(parseHash("#/")).toEqual({ view: null, focus: null, depth: null, filters: {} });
  });

  it("ignores a non-numeric depth", () => {
    expect(parseHash("#/x?depth=abc").depth).toBeNull();
  });

  it("round-trips ids that contain reserved characters", () => {
    const route = {
      view: "debug",
      focus: "ep:@acme/api:GET /posts?x=1#y",
      depth: 1,
      filters: { kind: "route" },
    };
    expect(parseHash(formatHash(route))).toEqual(route);
  });
});
