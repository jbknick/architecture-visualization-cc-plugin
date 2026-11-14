import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GantryConfig } from "../config/index.js";
import { cleanupData, type Indexed, indexedFixture } from "../describe/testkit.js";
import { parseSource } from "../parse/index.js";
import type { Description, SymbolRecord } from "../types.js";
import { type Advice, adviseReuse, checkImports, importPathFor } from "./index.js";

const open: Indexed[] = [];
async function fixture(files: Record<string, string> = {}): Promise<Indexed> {
  const ix = await indexedFixture("pnpm-turbo", files);
  open.push(ix);
  return ix;
}
afterAll(async () => {
  for (const ix of open.splice(0)) await ix.close();
  cleanupData();
});

function sym(ix: Indexed, path: string, name: string): SymbolRecord {
  const s = ix.store.getSymbol(`sym:${path}#${name}`);
  if (!s) throw new Error(`no symbol ${path}#${name}`);
  return s;
}

const UI_BUTTON = "packages/ui/src/button.tsx";
const WEB = "apps/web/src/components/PostList.tsx";
const API = "apps/api/src/router.ts";

describe("adviseReuse on fixtures/pnpm-turbo", () => {
  let ix: Indexed;
  beforeAll(async () => {
    ix = await fixture();
  });

  const cases: {
    name: string;
    caller: string;
    sym: [string, string];
    want: Advice[];
  }[] = [
    {
      name: "(1) same workspace: relative import",
      caller: WEB,
      sym: ["apps/web/src/lib/slug.ts", "slugify"],
      want: [
        {
          situation: 1,
          action: "Import it: import { slugify } from '../lib/slug'",
          inline: true,
          importPath: "../lib/slug",
        },
      ],
    },
    {
      name: "(1) reachable and a dependency: web -> ui entry",
      caller: WEB,
      sym: [UI_BUTTON, "Button"],
      want: [
        {
          situation: 1,
          action: "Import it: import { Button } from '@acme/ui'",
          inline: true,
          importPath: "@acme/ui",
        },
      ],
    },
    {
      name: "(1) reachable through a re-export from main: web -> utils",
      caller: WEB,
      sym: ["packages/utils/src/date.ts", "formatRelativeDate"],
      want: [
        {
          situation: 1,
          action: "Import it: import { formatRelativeDate } from '@acme/utils'",
          inline: true,
          importPath: "@acme/utils",
        },
      ],
    },
    {
      name: "(2) reachable, not a dependency: api -> ui",
      caller: API,
      sym: [UI_BUTTON, "Button"],
      want: [
        {
          situation: 2,
          action: 'Add "@acme/ui" to apps/api/package.json, then import it',
          inline: false,
          importPath: "@acme/ui",
        },
      ],
    },
    {
      name: "(3) not reachable: web -> utils internal slugify (not exported)",
      caller: WEB,
      sym: ["packages/utils/src/slug.ts", "slugify"],
      want: [
        {
          situation: 3,
          action: "Export it from @acme/utils (add to exports map) or move it to a shared package",
          inline: false,
        },
      ],
    },
    {
      name: "(3) exported from its file but outside the exports map: web -> ui internal",
      caller: WEB,
      sym: ["packages/ui/src/internal.ts", "INTERNAL_PADDING"],
      want: [
        {
          situation: 3,
          action: "Export it from @acme/ui (add to exports map) or move it to a shared package",
          inline: false,
        },
      ],
    },
    {
      name: "(4) lives in another app: api -> web",
      caller: API,
      sym: ["apps/web/src/components/Header.tsx", "Header"],
      want: [
        {
          situation: 4,
          action: "Move it to a shared package (it lives in app @acme/web)",
          inline: false,
        },
      ],
    },
  ];

  it.each(cases)("$name", (c) => {
    expect(adviseReuse(ix.store, c.caller, sym(ix, ...c.sym))).toEqual(c.want);
  });

  it("returns nothing when the match is in the caller's own file", () => {
    expect(adviseReuse(ix.store, UI_BUTTON, sym(ix, UI_BUTTON, "Button"))).toEqual([]);
  });

  it("is deterministic and does not change the store", () => {
    const m = sym(ix, UI_BUTTON, "Button");
    const before = ix.store.generation();
    const a = adviseReuse(ix.store, API, m);
    expect(adviseReuse(ix.store, API, m)).toEqual(a);
    expect(ix.store.generation()).toBe(before);
  });

  describe("(5) rename", () => {
    const m = (): SymbolRecord => sym(ix, "packages/utils/src/time.ts", "parseTimestamp");
    const bad: Description = {
      behavior: "Formats a date.",
      searchTerms: [],
      nameFits: false,
      suggestedName: "formatElapsed",
    };
    const on = { renameSuggestions: true } as GantryConfig;
    const off = { renameSuggestions: false } as GantryConfig;
    const rename: Advice = {
      situation: 5,
      action: "Consider renaming parseTimestamp to formatElapsed",
      inline: false,
    };

    it.each([
      ["flag on, name does not fit", bad, on, true],
      ["flag off", bad, off, false],
      ["no config (default off)", bad, undefined, false],
      ["flag on, name fits", { ...bad, nameFits: true }, on, false],
      ["flag on, no suggestion", { ...bad, suggestedName: undefined }, on, false],
      ["flag on, no description", null, on, false],
    ] as [string, Description | null, GantryConfig | undefined, boolean][])(
      "%s",
      (_n, description, config, expected) => {
        const got = adviseReuse(ix.store, WEB, m(), description, config);
        expect(got.some((a) => a.situation === 5)).toBe(expected);
        if (expected) expect(got).toEqual([expect.objectContaining({ situation: 1 }), rename]);
      },
    );
  });

  describe("importPathFor", () => {
    const ws = (name: string) => {
      const w = ix.store.listWorkspaces().find((x) => x.name === name);
      if (!w) throw new Error(name);
      return w;
    };
    it("uses the exports map, then main", () => {
      expect(importPathFor(ws("@acme/ui"), sym(ix, UI_BUTTON, "Button"), ix.store)).toBe("@acme/ui");
      expect(
        importPathFor(ws("@acme/utils"), sym(ix, "packages/utils/src/time.ts", "parseTimestamp"), ix.store),
      ).toBe("@acme/utils");
    });
    it("is null when no entry reaches the symbol", () => {
      expect(
        importPathFor(ws("@acme/utils"), sym(ix, "packages/utils/src/slug.ts", "slugify"), ix.store),
      ).toBeNull();
      expect(
        importPathFor(ws("@acme/ui"), sym(ix, "packages/ui/src/internal.ts", "INTERNAL_PADDING"), ix.store),
      ).toBeNull();
    });
    it("without a store only a direct export from the entry file counts", () => {
      expect(importPathFor(ws("@acme/ui"), sym(ix, UI_BUTTON, "Button"))).toBe("@acme/ui/button");
      expect(
        importPathFor(ws("@acme/utils"), sym(ix, "packages/utils/src/date.ts", "formatRelativeDate")),
      ).toBeNull(); // re-exported by index.ts
    });
  });
});

describe("exports map subpaths and wildcards", () => {
  it("prefers `.`, falls back to a subpath, and supports `*` entries", async () => {
    const ix = await fixture({
      "packages/ui/package.json": JSON.stringify({
        name: "@acme/ui",
        version: "0.0.0",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts", "./button": "./src/button.tsx", "./icons/*": "./src/icons/*.ts" },
        dependencies: { react: "^19.0.0" },
      }),
      "packages/ui/src/icons/arrow.ts": "export function arrow(n: number) {\n  return n + 1;\n}\n",
      "packages/ui/src/hidden.ts": "export function hidden(n: number) {\n  return n + 2;\n}\n",
    });
    const ui = ix.store.listWorkspaces().find((w) => w.name === "@acme/ui");
    if (!ui) throw new Error("ui");
    expect(importPathFor(ui, sym(ix, "packages/ui/src/icons/arrow.ts", "arrow"), ix.store)).toBe(
      "@acme/ui/icons/arrow",
    );
    expect(importPathFor(ui, sym(ix, "packages/ui/src/hidden.ts", "hidden"), ix.store)).toBeNull();
    expect(importPathFor(ui, sym(ix, UI_BUTTON, "Button"), ix.store)).toBe("@acme/ui");
  });
});

describe("(2) -> (4): workspace cycle", () => {
  it("suggests moving it when adding the dependency would close a cycle", async () => {
    // ui depends on utils; utils importing ui would be a cycle. Indirect: db -> ui -> utils.
    const ix = await fixture({
      "packages/ui/package.json": JSON.stringify({
        name: "@acme/ui",
        version: "0.0.0",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts", "./button": "./src/button.tsx" },
        dependencies: { "@acme/utils": "workspace:*" },
      }),
      "packages/db/package.json": JSON.stringify({
        name: "@acme/db",
        version: "0.0.0",
        private: true,
        type: "module",
        main: "./src/index.ts",
        dependencies: { "@acme/ui": "workspace:*" },
      }),
    });
    const button = sym(ix, UI_BUTTON, "Button");
    const direct = adviseReuse(ix.store, "packages/utils/src/date.ts", button);
    expect(direct).toEqual([
      {
        situation: 4,
        action: "Move it to a shared package (adding @acme/ui would make a dependency cycle)",
        inline: false,
      },
    ]);
    // Control: the api app is not in the closure, so the dependency can be added.
    expect(adviseReuse(ix.store, API, button)[0]?.situation).toBe(2);
    // Transitive: utils -> (adding) db -> ui -> utils.
    const q = sym(ix, "packages/db/src/queries.ts", "getPost");
    expect(adviseReuse(ix.store, "packages/utils/src/date.ts", q)[0]?.situation).toBe(4);
  });
});

describe("(2) -> (4): server/client boundary", () => {
  let ix: Indexed;
  beforeAll(async () => {
    ix = await fixture({
      "packages/ui/src/index.ts":
        'export { Button } from "./button";\nexport { Card } from "./card";\nexport { readSecret } from "./secret";\nexport { loadRows } from "./rows.server";\n',
      "packages/ui/package.json": JSON.stringify({
        name: "@acme/ui",
        version: "0.0.0",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts", "./button": "./src/button.tsx" },
        dependencies: { react: "^19.0.0", "server-only": "^0.0.1" },
      }),
      "packages/ui/src/secret.ts":
        'import "server-only";\nexport function readSecret(key: string) {\n  return key.toUpperCase();\n}\n',
      "packages/ui/src/rows.server.ts": "export function loadRows(n: number) {\n  return [n, n + 1];\n}\n",
      "apps/api/src/client.tsx": '"use client";\nexport function Widget() {\n  return <div />;\n}\n',
      "apps/api/src/server.ts": "export function Handler() {\n  return 1;\n}\n",
    });
  });

  it("stores the directive on the file row and emits no self import edge", () => {
    expect(ix.store.effectiveFile("file:apps/api/src/client.tsx")?.directives).toEqual(["use client"]);
    expect(ix.store.effectiveFile("file:apps/api/src/server.ts")?.directives).toBeUndefined();
    const selfImports = ix.store.effectiveEdges({ kind: ["imports"] }).filter((e) => e.src === e.dst);
    expect(selfImports).toEqual([]);
    const raw = ix.store.db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'imports' AND src = dst")
      .get();
    expect(raw).toEqual({ n: 0 });
  });

  it("parses the directive the indexer stores", () => {
    expect(parseSource("a.tsx", '"use client";\nexport const a = 1;\n').directives).toEqual(["use client"]);
    expect(parseSource("a.ts", "export const a = 1;\n").directives).toBeUndefined();
    expect(
      parseSource("a.ts", "// c\n'use strict';\n'use client';\nexport const a = 1;\n").directives,
    ).toEqual(["use strict", "use client"]);
  });

  const secret = (): SymbolRecord => sym(ix, "packages/ui/src/secret.ts", "readSecret");
  const rows = (): SymbolRecord => sym(ix, "packages/ui/src/rows.server.ts", "loadRows");
  const button = (): SymbolRecord => sym(ix, UI_BUTTON, "Button");
  const boundary: Advice = {
    situation: 4,
    action: "Move it to a shared package (it is server-only, the caller is a client file)",
    inline: false,
  };

  it.each([
    ["client caller, `server-only` import in the match file", "apps/api/src/client.tsx", secret, [boundary]],
    ["client caller, `.server.ts` match file", "apps/api/src/client.tsx", rows, [boundary]],
    ["client caller, ordinary match: dependency can be added", "apps/api/src/client.tsx", button, null],
    ["server caller, server-only match: dependency can be added", "apps/api/src/server.ts", secret, null],
  ] as [string, string, () => SymbolRecord, Advice[] | null][])("%s", (_n, caller, m, want) => {
    const got = adviseReuse(ix.store, caller, m());
    if (want) expect(got).toEqual(want);
    else expect(got[0]?.situation).toBe(2);
  });
});

describe("checkImports", () => {
  let ix: Indexed;
  beforeAll(async () => {
    ix = await fixture();
  });
  const check = (path: string, src: string) =>
    checkImports(ix.store, path, parseSource(path, src)).map((f) => [f.kind, f.specifier, f.line, f.action]);

  it("reports the fixture's undeclared @acme/db import in apps/web", () => {
    const path = "apps/web/src/routes/posts.$postId.tsx";
    const src = readFileSync(join(ix.fx.dir, path), "utf8");
    expect(check(path, src)).toEqual([
      ["undeclared", "@acme/db", 3, 'Declare "@acme/db" in apps/web/package.json'],
    ]);
  });

  it("does not report @acme/db in apps/api, which declares it", () => {
    const path = "apps/api/src/router.ts";
    expect(check(path, readFileSync(join(ix.fx.dir, path), "utf8"))).toEqual([]);
  });

  const W = "apps/web/src/x.ts";
  const table: [string, string, string, unknown[]][] = [
    ["declared workspace package", W, 'import { Button } from "@acme/ui";', []],
    ["declared npm package", W, 'import React from "react";', []],
    ["node: builtin", W, 'import fs from "node:fs";', []],
    ["bare builtin", W, 'import fs from "fs";\nimport p from "fs/promises";', []],
    ["type-only import of an undeclared package", W, 'import type { A } from "@acme/db";', []],
    [
      "relative and alias-looking specifiers",
      W,
      'import a from "./a";\nimport b from "~/b";\nimport c from "@/c";',
      [],
    ],
    ["scheme specifier", W, 'import a from "virtual:thing";', []],
    [
      "undeclared npm package",
      W,
      'import _ from "lodash";',
      [["undeclared", "lodash", 1, 'Declare "lodash" in apps/web/package.json']],
    ],
    [
      "undeclared scoped package, subpath",
      W,
      'import x from "@scope/pkg/sub";',
      [["undeclared", "@scope/pkg/sub", 1, 'Declare "@scope/pkg" in apps/web/package.json']],
    ],
    [
      "deep import past the exports map",
      W,
      'import { x } from "@acme/ui/internal";',
      [["deep_import", "@acme/ui/internal", 1, "Import from an exported entry of @acme/ui"]],
    ],
    ["exported subpath", W, 'import { Button } from "@acme/ui/button";', []],
    ["subpath of a package with no exports map", W, 'import { s } from "@acme/utils/src/slug";', []],
    ["subpath of a non-workspace package", W, 'import { x } from "react/jsx-runtime";', []],
    [
      "undeclared and deep",
      W,
      'import { x } from "@acme/db/src/schema";\nimport { y } from "@acme/db";',
      [
        ["undeclared", "@acme/db/src/schema", 1, 'Declare "@acme/db" in apps/web/package.json'],
        ["undeclared", "@acme/db", 2, 'Declare "@acme/db" in apps/web/package.json'],
      ],
    ],
    [
      "dynamic import and sorted by line",
      W,
      'import _ from "zod";\nconst m = () => import("lodash");',
      [
        ["undeclared", "zod", 1, 'Declare "zod" in apps/web/package.json'],
        ["undeclared", "lodash", 2, 'Declare "lodash" in apps/web/package.json'],
      ],
    ],
    ["its own package", W, 'import x from "@acme/web";', []],
    [
      "root-level file is checked against the root package.json",
      "scripts/x.ts",
      'import _ from "lodash";',
      [["undeclared", "lodash", 1, 'Declare "lodash" in package.json']],
    ],
  ];
  it.each(table)("%s", (_n, path, src, want) => {
    expect(check(path, src)).toEqual(want);
  });
});
