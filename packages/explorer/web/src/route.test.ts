import { describe, expect, it } from "vitest";
import { encodeFilters } from "./api.ts";
import { formatHash, parseHash } from "./route.ts";

describe("hash route", () => {
  it("parses view, focus, level, hops, selection and filters", () => {
    expect(
      parseHash("#/project-map?focus=ws%3A%40acme%2Fui&level=dirs&hops=3&sel=sym%3Aa%23B&kinds=hook&q=a%20b"),
    ).toEqual({
      view: "project-map",
      focus: "ws:@acme/ui",
      sel: "sym:a#B",
      level: "dirs",
      hops: 3,
      filters: { kinds: "hook", q: "a b" },
    });
  });

  it("treats an empty hash as no view", () => {
    const empty = { view: null, focus: null, sel: null, level: null, hops: null, filters: {} };
    expect(parseHash("")).toEqual(empty);
    expect(parseHash("#/")).toEqual(empty);
  });

  it("ignores a bad level and a non-numeric or zero hops", () => {
    expect(parseHash("#/x?level=galaxy").level).toBeNull();
    expect(parseHash("#/x?hops=abc").hops).toBeNull();
    expect(parseHash("#/x?hops=0").hops).toBeNull();
  });

  it("round-trips ids that contain reserved characters", () => {
    const route = {
      view: "ego",
      focus: "ep:@acme/api:GET /posts?x=1#y",
      sel: "sym:a b#c&d",
      level: null,
      hops: 1,
      filters: { edgeKinds: "calls|renders" },
    };
    expect(parseHash(formatHash(route))).toEqual(route);
  });

  it("writes a short, readable hash", () => {
    expect(
      formatHash({
        view: "project-map",
        focus: null,
        sel: null,
        level: "workspaces",
        hops: null,
        filters: { hideTests: "false" },
      }),
    ).toBe("#/project-map?level=workspaces&hideTests=false");
  });
});

describe("filters sent to the server", () => {
  it("become one JSON object the server's option parser accepts", () => {
    expect(encodeFilters({})).toBeUndefined();
    expect(encodeFilters({ hideTests: "false", workspaces: "ws:a|ws:b" })).toBe(
      '{"hideTests":"false","workspaces":"ws:a|ws:b"}',
    );
  });
});
