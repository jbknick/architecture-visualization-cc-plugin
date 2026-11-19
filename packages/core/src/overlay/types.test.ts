import { describe, expect, it } from "vitest";
import {
  FilterSpecSchema,
  GroupIdSchema,
  GroupSchema,
  LabelSchema,
  SavedViewSchema,
  SelectorSchema,
} from "./types.js";

const glob = { type: "glob", glob: "packages/utils/src/**" } as const;

describe("SelectorSchema", () => {
  it("accepts each selector type", () => {
    expect(SelectorSchema.parse(glob)).toEqual(glob);
    expect(SelectorSchema.parse({ type: "kind", kind: "function" })).toEqual({
      type: "kind",
      kind: "function",
    });
    expect(SelectorSchema.parse({ type: "workspace", workspace: "ws:@acme/ui" }).type).toBe("workspace");
    expect(SelectorSchema.parse({ type: "ids", ids: ["file:r:a.ts"] }).type).toBe("ids");
  });

  it("rejects an unknown type, a long glob, 501 ids, an unknown kind and extra keys", () => {
    expect(SelectorSchema.safeParse({ type: "regex", regex: "x" }).success).toBe(false);
    expect(SelectorSchema.safeParse({ type: "glob", glob: "a".repeat(301) }).success).toBe(false);
    expect(SelectorSchema.safeParse({ type: "glob", glob: "a".repeat(300) }).success).toBe(true);
    const ids = Array.from({ length: 501 }, (_, i) => `file:r:${i}.ts`);
    expect(SelectorSchema.safeParse({ type: "ids", ids }).success).toBe(false);
    expect(SelectorSchema.safeParse({ type: "ids", ids: ids.slice(0, 500) }).success).toBe(true);
    expect(SelectorSchema.safeParse({ type: "ids", ids: [] }).success).toBe(false);
    expect(SelectorSchema.safeParse({ type: "kind", kind: "package" }).success).toBe(false);
    expect(SelectorSchema.safeParse({ ...glob, extra: 1 }).success).toBe(false);
  });
});

describe("GroupIdSchema", () => {
  it("accepts lower case, digits and dashes and rejects upper case, a leading dash and 64 characters", () => {
    expect(GroupIdSchema.safeParse("dates-2").success).toBe(true);
    expect(GroupIdSchema.safeParse("Dates").success).toBe(false);
    expect(GroupIdSchema.safeParse("-dates").success).toBe(false);
    expect(GroupIdSchema.safeParse("a".repeat(64)).success).toBe(false);
  });
});

describe("FilterSpecSchema", () => {
  it("fills defaults and rejects extra keys and a bad level", () => {
    expect(FilterSpecSchema.parse({ view: "project-map" })).toEqual({
      view: "project-map",
      hidden: [],
      groups: [],
      filters: {},
    });
    expect(FilterSpecSchema.safeParse({ view: "project-map", extra: true }).success).toBe(false);
    expect(FilterSpecSchema.safeParse({ view: "project-map", level: "all" }).success).toBe(false);
    expect(FilterSpecSchema.safeParse({ view: "project-map", groups: ["Up"] }).success).toBe(false);
  });
});

describe("GroupSchema", () => {
  const group = { id: "dates", name: "Dates", selectors: [glob] };
  it("defaults mayUse to null and needs at least one selector", () => {
    expect(GroupSchema.parse(group).mayUse).toBeNull();
    expect(GroupSchema.safeParse({ ...group, selectors: [] }).success).toBe(false);
    expect(GroupSchema.safeParse({ ...group, id: "Dates" }).success).toBe(false);
    expect(GroupSchema.safeParse({ ...group, extra: 1 }).success).toBe(false);
    expect(GroupSchema.safeParse({ ...group, name: "" }).success).toBe(false);
  });
});

describe("SavedViewSchema and LabelSchema", () => {
  it("accept valid values and reject extra keys", () => {
    const view = { id: "curated", name: "Curated", spec: { view: "project-map" } };
    expect(SavedViewSchema.parse(view).spec.hidden).toEqual([]);
    expect(SavedViewSchema.safeParse({ ...view, extra: 1 }).success).toBe(false);
    expect(LabelSchema.parse({ nodeId: "file:r:a.ts", text: "" }).text).toBe("");
    expect(LabelSchema.safeParse({ nodeId: "file:r:a.ts", text: "x".repeat(81) }).success).toBe(false);
    expect(LabelSchema.safeParse({ nodeId: "file:r:a.ts", text: "x", extra: 1 }).success).toBe(false);
  });
});
