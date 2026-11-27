import {
  EdgeSchema,
  FileSchema,
  FilterSpecSchema,
  GroupSchema,
  SavedViewSchema,
  SelectorSchema,
  SymbolSchema,
} from "@gantry/protocol";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as core from "../index.js";

// Lives here, not in the protocol package: the protocol package depends on zod only, and the client in this package
// depends on it, so a test that needs both sits on the client's side.
const REPO = "fixture/pnpm-turbo";
const WS = `ws:${REPO}:@acme/utils`;
const FILE_ID = `file:${REPO}:packages/utils/src/slug.ts`;
const SYM_ID = `sym:${REPO}:packages/utils/src/slug.ts#slugify`;
const HASH = "9c1b7e4a2d5f80136a4be7c9d0e2f581";
const snap = {
  files: [{ id: FILE_ID, path: "packages/utils/src/slug.ts", workspace: WS, lang: "typescript" }],
  symbols: [
    {
      id: SYM_ID,
      name: "slugify",
      kind: "function",
      lang: "typescript",
      path: "packages/utils/src/slug.ts",
      workspace: WS,
      line_start: 2,
      line_end: 9,
      exact_hash: HASH,
      renamed_hash: "4d8e1f6a9b3c7025e1a8f4b6c2d9073e",
      content_key: `${HASH}:p1`,
    },
  ],
  edges: [{ from: FILE_ID, to: SYM_ID, kind: "contains" }],
};

describe("overlay schemas match the ones the indexing library uses", () => {
  // The same samples as the library's own tests: both sides accept or both reject each one.
  const glob = { type: "glob", glob: "packages/utils/src/**" };
  const ids501 = Array.from({ length: 501 }, (_, i) => `file:r:${i}.ts`);
  const selectors: unknown[] = [
    glob,
    { type: "kind", kind: "function" },
    { type: "workspace", workspace: "ws:@acme/ui" },
    { type: "ids", ids: ["file:r:a.ts"] },
    { type: "regex", regex: "x" },
    { type: "glob", glob: "a".repeat(301) },
    { type: "glob", glob: "a".repeat(300) },
    { type: "ids", ids: ids501 },
    { type: "ids", ids: ids501.slice(0, 500) },
    { type: "ids", ids: [] },
    { type: "kind", kind: "package" },
    { ...glob, extra: 1 },
  ];
  const filterSpecs: unknown[] = [
    { view: "project-map" },
    { view: "project-map", extra: true },
    { view: "project-map", level: "all" },
    { view: "project-map", level: "files", focus: "file:r:a.ts" },
    { view: "project-map", groups: ["Up"] },
    { view: "x".repeat(51) },
    { view: "v", filters: { a: "b" } },
  ];
  const g = { id: "dates", name: "Dates", selectors: [glob] };
  const groups: unknown[] = [
    g,
    { ...g, selectors: [] },
    { ...g, id: "Dates" },
    { ...g, extra: 1 },
    { ...g, name: "" },
    { ...g, mayUse: ["web"] },
    { ...g, mayUse: null },
  ];
  const v = { id: "curated", name: "Curated", spec: { view: "project-map" } };
  const views: unknown[] = [v, { ...v, extra: 1 }, { ...v, id: "-x" }, { ...v, name: "x".repeat(81) }];

  const pairs: [string, z.ZodType, z.ZodType, unknown[]][] = [
    ["Selector", SelectorSchema, core.SelectorSchema, selectors],
    ["FilterSpec", FilterSpecSchema, core.FilterSpecSchema, filterSpecs],
    ["Group", GroupSchema, core.GroupSchema, groups],
    ["SavedView", SavedViewSchema, core.SavedViewSchema, views],
  ];
  for (const [name, ours, theirs, samples] of pairs) {
    it(`${name} gives the same verdict and the same value`, () => {
      for (const sample of samples) {
        const a = ours.safeParse(sample);
        const b = theirs.safeParse(sample);
        expect(a.success, JSON.stringify(sample).slice(0, 80)).toBe(b.success);
        if (a.success && b.success) expect(a.data).toEqual(b.data);
      }
    });
  }

  it("lists the same selector kinds", () => {
    expect([...core.SELECTOR_KINDS]).toEqual([
      "workspace",
      "dir",
      "file",
      "function",
      "method",
      "component",
      "hook",
      "class",
      "type",
      "interface",
      "enum",
      "const",
      "route",
      "endpoint",
      "middleware",
      "table",
    ]);
  });

  it("accepts every language id and symbol and edge kind the library produces", () => {
    const kinds = ["function", "method", "component", "hook", "class", "type", "interface", "enum", "const"];
    const edgeKinds = [
      "contains",
      "imports",
      "exports",
      "calls",
      "renders",
      "uses_hook",
      "extends",
      "implements",
      "references_type",
      "depends_on",
      "serves",
      "handles",
      "requests",
      "reads",
      "writes",
    ];
    for (const lang of core.LANG_IDS)
      expect(FileSchema.safeParse({ ...snap.files[0], lang }).success, lang).toBe(true);
    for (const kind of kinds)
      expect(SymbolSchema.safeParse({ ...snap.symbols[0], kind }).success, kind).toBe(true);
    for (const kind of edgeKinds)
      expect(EdgeSchema.safeParse({ ...snap.edges[0], kind }).success, kind).toBe(true);
  });
});
