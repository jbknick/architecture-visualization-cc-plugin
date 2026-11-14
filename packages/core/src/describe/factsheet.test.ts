import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../store/index.js";
import {
  buildFactSheet,
  contentKey,
  FACT_BODY_MAX,
  FACT_DOC_MAX,
  leadingDoc,
  PROMPT_MAJOR,
  returnTypeOf,
  SensitivePathError,
  trimBody,
} from "./factsheet.js";
import { cleanupData, fakeSymbol, indexedFixture, putFile } from "./testkit.js";

afterEach(() => cleanupData());

describe("contentKey", () => {
  it("is the exact hash plus the prompt major", () => {
    expect(PROMPT_MAJOR).toBe("p1");
    expect(contentKey("abc123")).toBe("abc123:p1");
  });
});

describe("trimBody", () => {
  it("leaves bodies up to 1,500 chars alone", () => {
    const body = "x".repeat(FACT_BODY_MAX);
    expect(trimBody(body)).toBe(body);
  });

  it("keeps head and tail and inserts a marker for 1,501 chars", () => {
    const body = `${"H".repeat(800)}${"m".repeat(500)}${"T".repeat(201)}`;
    expect(body).toHaveLength(1501);
    const t = trimBody(body);
    expect(t.length).toBeLessThanOrEqual(FACT_BODY_MAX);
    expect(t).toContain("/* … */");
    expect(t.startsWith("H".repeat(800))).toBe(true);
    expect(t.endsWith("T".repeat(100))).toBe(true);
    expect(t).not.toContain("m".repeat(500));
  });

  it("trims very long bodies to exactly the limit", () => {
    expect(trimBody("a".repeat(50_000))).toHaveLength(FACT_BODY_MAX);
  });
});

describe("leadingDoc", () => {
  it("reads JSDoc blocks, line comments and skips decorators", () => {
    const lines = ["/**", " * Adds two numbers.", " * Pure.", " */", "@memo()", "function add() {}"];
    expect(leadingDoc(lines, 6)).toBe("Adds two numbers. Pure.");
    expect(leadingDoc(["// one", "// two", "function f() {}"], 3)).toBe("one two");
    expect(leadingDoc(["const a = 1;", "function f() {}"], 2)).toBeNull();
    expect(leadingDoc(["// detached", "", "function f() {}"], 3)).toBeNull();
  });

  it("cuts to 400 chars", () => {
    const doc = leadingDoc([`// ${"w ".repeat(500)}`, "function f() {}"], 2);
    expect(doc).not.toBeNull();
    expect((doc as string).length).toBe(FACT_DOC_MAX);
  });
});

describe("returnTypeOf", () => {
  it.each([
    ["(a: number): string", "string"],
    ["<T>(a: T): Promise<T>", "Promise<T>"],
    ["(cb: (x: number) => void): void", "void"],
    ["<T extends { a: () => void }>(x: T)", null],
    ["(a: number)", null],
    ["(a: 'x):y'): number", "number"],
    ["", null],
  ])("%s", (sig, expected) => {
    expect(returnTypeOf(sig)).toBe(expected);
  });
});

describe("buildFactSheet", () => {
  it("matches the snapshot for five fixture functions", async () => {
    const ix = await indexedFixture("pnpm-turbo");
    try {
      const ids = [
        "sym:packages/utils/src/date.ts#formatRelativeDate",
        "sym:packages/utils/src/slug.ts#slugify",
        "sym:apps/web/src/hooks/useDebounce.ts#useDebounce",
        "sym:packages/db/src/queries.ts#createPost",
        "sym:apps/web/src/components/PostList.tsx#PostList",
      ];
      const sheets = ids.map((id) => {
        const sym = ix.store.getSymbol(id);
        const rel = (sym?.fileId ?? "").slice(5);
        return buildFactSheet(ix.store, id, readFileSync(join(ix.fx.dir, rel), "utf8"));
      });
      expect(sheets).toMatchSnapshot();
      for (const s of sheets) {
        expect(s.body.length).toBeLessThanOrEqual(FACT_BODY_MAX);
        expect(s.contentKey.endsWith(":p1")).toBe(true);
      }
    } finally {
      await ix.close();
    }
  });

  it("collects sorted callee names from calls, renders and uses_hook edges only", () => {
    const store = openStore(":memory:");
    const caller = fakeSymbol("src/a.ts", "caller", { startLine: 2, endLine: 3 });
    const targets = Array.from({ length: 25 }, (_, i) =>
      fakeSymbol("src/t.ts", `t${String(24 - i).padStart(2, "0")}`),
    );
    const edge = (dst: string, kind: "calls" | "renders" | "uses_hook" | "references_type") => ({
      src: caller.id,
      dst,
      kind,
      confidence: "high" as const,
      count: 1,
      evidence: [],
      fileId: caller.fileId,
    });
    putFile(store, "src/t.ts", targets);
    putFile(
      store,
      "src/a.ts",
      [caller],
      [
        ...targets.map((t) => edge(t.id, "calls")),
        edge("sym:src/x.ts#Widget", "renders"),
        edge("sym:src/x.ts#useThing", "uses_hook"),
        edge("sym:src/x.ts#SomeType", "references_type"),
      ],
    );
    const sheet = buildFactSheet(store, caller.id, "// doc line\nfunction caller() {\n}\n");
    expect(sheet.callees).toHaveLength(20);
    expect(sheet.callees).toEqual([...sheet.callees].sort());
    expect(sheet.callees).not.toContain("SomeType");
    expect(sheet.doc).toBe("doc line");
    expect(sheet.body).toBe("function caller() {\n}");
    store.close();
  });

  it("never builds a sheet for a sensitive path", () => {
    const store = openStore(":memory:");
    const s = fakeSymbol("config/secrets.ts", "getKey");
    putFile(store, "config/secrets.ts", [s]);
    expect(() => buildFactSheet(store, s.id, "export function getKey() {}")).toThrow(SensitivePathError);
    expect(() => buildFactSheet(store, "sym:nope#x", "")).toThrow(/Unknown symbol/);
    store.close();
  });
});
