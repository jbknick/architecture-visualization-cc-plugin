import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupData, type Indexed, indexedFixture } from "../describe/testkit.js";
import type { SymbolRecord } from "../types.js";
import { type Advice, adviseReuse } from "./index.js";

/** Reuse advice for a Go match (spec section 18), on `fixtures/go-basic` plus a third module and two small files. */
const EXTRA = {
  "internal/text/words.go": "package text\n\nfunc Words(s string) []string {\n\treturn nil\n}\n",
  "pub/clamp.go": "package pub\n\nfunc Clamp(v, lo, hi int) int {\n\treturn v\n}\n",
  "tools/helper.go": 'package main\n\nfunc Help() string {\n\treturn ""\n}\n',
  "extra/go.mod": "module example.com/extra\n\ngo 1.22\n",
  "extra/main.go": "package main\n\nfunc main() {}\n",
};

let ix: Indexed;
beforeAll(async () => {
  ix = await indexedFixture("go-basic", EXTRA);
});
afterAll(async () => {
  await ix.close();
  cleanupData();
});

function sym(path: string, name: string): SymbolRecord {
  const s = ix.store.getSymbol(`sym:go-basic:${path}#${name}`);
  if (!s) throw new Error(`no symbol ${path}#${name}`);
  return s;
}

const SLUGIFY = ["internal/text/slug.go", "Slugify"] as const;
const cases: { name: string; caller: string; sym: readonly [string, string]; want: Advice[] }[] = [
  {
    name: "(1) same package: call it, no import",
    caller: "internal/text/words.go",
    sym: SLUGIFY,
    want: [
      {
        situation: 1,
        action: "Call it: Slugify is in the same package (internal/text)",
        inline: true,
      },
    ],
  },
  {
    name: "(1) exported, another package of the same module: import the package",
    caller: "cmd/server/main.go",
    sym: SLUGIFY,
    want: [
      {
        situation: 1,
        action: 'Import it: import "example.com/gobasic/internal/text"',
        inline: true,
        importPath: "example.com/gobasic/internal/text",
      },
    ],
  },
  {
    name: "(1) a method of an exported type is imported through its package",
    caller: "cmd/server/main.go",
    sym: ["internal/store/store.go", "Store.Get"],
    want: [
      {
        situation: 1,
        action: 'Import it: import "example.com/gobasic/internal/store"',
        inline: true,
        importPath: "example.com/gobasic/internal/store",
      },
    ],
  },
  {
    name: "(3) not exported: export it or move it to a shared package",
    caller: "cmd/server/main.go",
    sym: ["internal/text/slug.go", "trimDashes"],
    want: [{ situation: 3, action: "Export it or move it to a shared package", inline: false }],
  },
  {
    name: "(3) exported but in an internal package the caller's module cannot import",
    caller: "extra/main.go",
    sym: SLUGIFY,
    want: [{ situation: 3, action: "Export it or move it to a shared package", inline: false }],
  },
  {
    name: "(2) another module that the caller does not require: add the dependency",
    caller: "extra/main.go",
    sym: ["pub/clamp.go", "Clamp"],
    want: [
      {
        situation: 2,
        action: "Add the dependency: require example.com/gobasic in extra/go.mod, then import it",
        inline: false,
        importPath: "example.com/gobasic/pub",
      },
    ],
  },
  {
    name: "(1) another module that the caller requires: import it",
    caller: "tools/main.go",
    sym: ["pub/clamp.go", "Clamp"],
    want: [
      {
        situation: 1,
        action: 'Import it: import "example.com/gobasic/pub"',
        inline: true,
        importPath: "example.com/gobasic/pub",
      },
    ],
  },
  {
    name: "(4) adding the dependency would make a cycle",
    caller: "cmd/server/main.go",
    sym: ["tools/helper.go", "Help"],
    want: [
      {
        situation: 4,
        action:
          "Move it to a shared package (adding example.com/gobasic/tools would make a dependency cycle)",
        inline: false,
      },
    ],
  },
];

describe("adviseReuse for a Go match", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(adviseReuse(ix.store, c.caller, sym(...c.sym))).toEqual(c.want);
    });
  }

  it("a match in the caller's own file needs no advice", () => {
    expect(adviseReuse(ix.store, "internal/text/slug.go", sym(...SLUGIFY))).toEqual([]);
  });

  it("a caller that is not a Go file (or unknown) gets none", () => {
    expect(adviseReuse(ix.store, ".", sym(...SLUGIFY))).toEqual([]);
    expect(adviseReuse(ix.store, "web/page.ts", sym(...SLUGIFY))).toEqual([]);
  });
});
