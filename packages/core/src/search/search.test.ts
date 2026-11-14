import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store, splitIdentifier } from "../store/index.js";
import type { EdgeKind, FileRecord, SymbolRecord } from "../types.js";
import { usageSummary } from "../usage/index.js";
import { ftsSearch } from "./fts.js";
import { nodeInfo } from "./node.js";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

const file = (path: string, workspaceId = "ws:a", extra: Partial<FileRecord> = {}): FileRecord => ({
  id: `file:${path}`,
  path,
  workspaceId,
  contentHash: `h-${path}`,
  mtimeMs: 1,
  deleted: false,
  ...extra,
});

function sym(path: string, name: string, extra: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: `sym:${path}#${name}`,
    fileId: `file:${path}`,
    name,
    kind: "function",
    exported: true,
    signature: `function ${name}()`,
    startLine: 1,
    endLine: 3,
    loc: 3,
    complexity: 1,
    stmtCount: 1,
    exactHash: `e-${name}`,
    shapeHash: `s-${name}`,
    minhash: new Uint32Array(64),
    ...extra,
  };
}

function put(f: FileRecord, symbols: SymbolRecord[], edges: [string, string, EdgeKind][] = []): void {
  store.replaceFile(
    "main",
    f,
    symbols,
    edges.map(([src, dst, kind]) => ({
      src,
      dst,
      kind,
      confidence: "high",
      count: 1,
      evidence: [],
      fileId: f.id,
    })),
  );
  for (const s of symbols) {
    store.fts.upsert(s.id, {
      nameTokens: splitIdentifier(s.name).join(" "),
      suggestedName: "",
      path: f.path,
      behavior: "",
      searchTerms: "",
    });
  }
}

describe("ftsSearch", () => {
  beforeEach(() => {
    store.upsertWorkspaces([
      { id: "ws:a", name: "alpha", dir: "a", kind: "package", frameworks: [], deps: [], exportsMap: null },
      { id: "ws:b", name: "beta", dir: "b", kind: "package", frameworks: [], deps: [], exportsMap: null },
    ]);
    put(file("a/date.ts"), [
      sym("a/date.ts", "formatRelativeDate", { startLine: 1, endLine: 10 }),
      sym("a/date.ts", "formatDate", { startLine: 11, endLine: 14 }),
      sym("a/date.ts", "relativeHelper", { exported: false, startLine: 15, endLine: 17 }),
    ]);
    put(file("b/other.ts", "ws:b"), [
      sym("b/other.ts", "dateParser", { kind: "const" }),
      sym("b/other.ts", "Date", { kind: "class" }),
    ]);
  });

  it("ANDs prefix tokens and ranks the full match first", () => {
    const hits = ftsSearch(store, "relative date");
    expect(hits[0]).toMatchObject({
      name: "formatRelativeDate",
      kind: "function",
      path: "a/date.ts",
      line: 1,
    });
    expect(hits.map((h) => h.name)).not.toContain("formatDate");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("falls back to OR when AND finds nothing", () => {
    const hits = ftsSearch(store, "relative parser");
    expect(hits.map((h) => h.name).sort()).toEqual(["dateParser", "formatRelativeDate", "relativeHelper"]);
  });

  it("matches camelCase queries and path tokens by prefix", () => {
    expect(ftsSearch(store, "formatRel")[0]?.name).toBe("formatRelativeDate");
    expect(
      ftsSearch(store, "other")
        .map((h) => h.name)
        .sort(),
    ).toEqual(["Date", "dateParser"]);
  });

  it("boosts exact name matches and exported symbols", () => {
    expect(ftsSearch(store, "date")[0]?.name).toBe("Date");
    const h = ftsSearch(store, "relative").map((x) => x.name);
    expect(h.indexOf("formatRelativeDate")).toBeLessThan(h.indexOf("relativeHelper"));
  });

  it("filters by kind, workspace (id or name), exported and limit", () => {
    expect(ftsSearch(store, "date", { kind: ["class"] }).map((h) => h.name)).toEqual(["Date"]);
    expect(ftsSearch(store, "date", { workspace: "beta" }).every((h) => h.path.startsWith("b/"))).toBe(true);
    expect(ftsSearch(store, "date", { workspace: "ws:a" }).every((h) => h.path.startsWith("a/"))).toBe(true);
    expect(ftsSearch(store, "date", { workspace: "nope" })).toEqual([]);
    expect(ftsSearch(store, "relative", { exported: false }).map((h) => h.name)).toEqual(["relativeHelper"]);
    expect(ftsSearch(store, "date", { limit: 2 })).toHaveLength(2);
  });

  it("returns [] for empty and hostile queries without throwing", () => {
    expect(ftsSearch(store, "")).toEqual([]);
    expect(ftsSearch(store, "   ")).toEqual([]);
    expect(ftsSearch(store, '"* OR NEAR( ) AND -:^')).toEqual([]);
    expect(ftsSearch(store, "date'; DROP TABLE symbols;--").length).toBeGreaterThanOrEqual(0);
    expect(store.effectiveSymbols().length).toBe(5);
  });

  it("hides symbols of files deleted in the working layer", () => {
    store.markDeleted("working", "file:b/other.ts");
    expect(ftsSearch(store, "parser")).toEqual([]);
  });
});

describe("nodeInfo", () => {
  beforeEach(() => {
    put(
      file("src/a.ts"),
      [
        sym("src/a.ts", "outer", { startLine: 1, endLine: 20 }),
        sym("src/a.ts", "inner", { kind: "method", startLine: 5, endLine: 8 }),
      ],
      [
        ["file:src/a.ts", "sym:src/a.ts#outer", "contains"],
        ["sym:src/a.ts#outer", "sym:src/b.ts#target", "calls"],
        ["sym:src/a.ts#outer", "sym:src/b.ts#other", "calls"],
      ],
    );
    put(
      file("src/b.ts"),
      [sym("src/b.ts", "target")],
      [["sym:src/c.ts#caller", "sym:src/b.ts#target", "calls"]],
    );
  });

  it("resolves path:line to the innermost containing symbol", () => {
    expect(nodeInfo(store, "src/a.ts:6")?.node).toMatchObject({ name: "inner" });
    expect(nodeInfo(store, "src/a.ts:15")?.node).toMatchObject({ name: "outer" });
    expect(nodeInfo(store, "src/a.ts:99")).toBeNull();
    expect(nodeInfo(store, "src/zzz.ts:1")).toBeNull();
  });

  it("groups neighbors by edge kind and counts fan-in/out without contains", () => {
    const info = nodeInfo(store, "sym:src/a.ts#outer");
    expect(info?.fanOut).toBe(2);
    expect(info?.fanIn).toBe(0);
    expect(info?.neighbors).toEqual({
      calls: ["sym:src/b.ts#other", "sym:src/b.ts#target"],
      "contains:in": ["file:src/a.ts"],
    });
    const target = nodeInfo(store, "sym:src/b.ts#target");
    expect(target?.fanIn).toBe(2);
    expect(target?.neighbors["calls:in"]).toEqual(["sym:src/a.ts#outer", "sym:src/c.ts#caller"]);
  });

  it("resolves file ids and bare paths to the file", () => {
    expect(nodeInfo(store, "file:src/a.ts")?.node).toMatchObject({ path: "src/a.ts" });
    expect(nodeInfo(store, "src/b.ts")?.node).toMatchObject({ id: "file:src/b.ts" });
    expect(nodeInfo(store, "file:nope.ts")).toBeNull();
    expect(nodeInfo(store, "sym:nope#x")).toBeNull();
  });
});

describe("usageSummary", () => {
  it("is empty without rows and groups by task and model", () => {
    expect(usageSummary(store)).toEqual([]);
    const ins = store.db.prepare(
      "INSERT INTO usage_log(at, task, model, effort, functions, input_tokens, output_tokens, cost_estimate_usd, source) VALUES ('t', ?, ?, 'low', ?, ?, ?, ?, 'x')",
    );
    ins.run("describe.init", "haiku", 10, 100, 20, 0.5);
    ins.run("describe.init", "haiku", 5, 50, 10, 0.25);
    ins.run("overview", "sonnet", 1, 7, 3, 0.1);
    expect(usageSummary(store)).toEqual([
      {
        task: "describe.init",
        model: "haiku",
        runs: 2,
        functions: 15,
        inputTokens: 150,
        outputTokens: 30,
        costUsd: 0.75,
      },
      {
        task: "overview",
        model: "sonnet",
        runs: 1,
        functions: 1,
        inputTokens: 7,
        outputTokens: 3,
        costUsd: 0.1,
      },
    ]);
  });
});
