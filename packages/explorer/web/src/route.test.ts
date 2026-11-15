import { describe, expect, it } from "vitest";
import { encodeFilters } from "./api.ts";
import { formatHash, parseHash, parseInitialHash } from "./route.ts";

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

describe("initial hash", () => {
  it("selects the focus node when there is no sel key", () => {
    expect(parseInitialHash("#/ego?focus=sym%3Aa%23B&hops=2").sel).toBe("sym:a#B");
  });
  it("lets an explicit sel win, including an empty one", () => {
    expect(parseInitialHash("#/ego?focus=sym%3Aa%23B&sel=sym%3Ac%23D").sel).toBe("sym:c#D");
    expect(parseInitialHash("#/ego?focus=sym%3Aa%23B&sel=").sel).toBeNull();
  });
  it("selects nothing without a focus", () => {
    expect(parseInitialHash("#/duplicates").sel).toBeNull();
  });
});

describe("empty sel and question marks", () => {
  it("keeps an explicit empty sel through the load-time rewrite", () => {
    const hash = formatHash(parseInitialHash("#/ego?focus=X&sel="));
    expect(hash).toBe("#/ego?focus=X&sel=");
    expect(parseInitialHash(hash).sel).toBeNull();
  });
  it("writes sel= for a focus with nothing selected, and nothing without a focus", () => {
    expect(formatHash({ ...parseHash("#/ego?focus=X&sel=Y"), sel: null })).toBe("#/ego?focus=X&sel=");
    expect(formatHash(parseHash("#/duplicates"))).toBe("#/duplicates");
  });
  it("splits at the first ? only", () => {
    const route = parseInitialHash(`#/ego?focus=${encodeURIComponent("ep:GET /a?b")}&q=a?b`);
    expect(route.focus).toBe("ep:GET /a?b");
    expect(route.filters.q).toBe("a?b");
    expect(parseHash("#/ego?focus=X&q=a?b=c").filters.q).toBe("a?b=c");
  });
});
