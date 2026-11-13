import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { build } from "tsup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeRecord, FileRecord, SymbolRecord } from "../types.js";
import { openStore, SchemaTooNewError, splitIdentifier } from "./index.js";
import type { Store } from "./repo.js";

const here = dirname(fileURLToPath(import.meta.url));

const file = (id: string, extra: Partial<FileRecord> = {}): FileRecord => ({
  id: `file:${id}`,
  path: id,
  workspaceId: "ws:.",
  contentHash: `h-${id}`,
  mtimeMs: 1,
  deleted: false,
  ...extra,
});
const sym = (path: string, name: string, extra: Partial<SymbolRecord> = {}): SymbolRecord => ({
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
  minhash: Uint32Array.from({ length: 64 }, (_, i) => (i * 2654435761) >>> 0),
  ...extra,
});
const edge = (path: string, src: string, dst: string): EdgeRecord => ({
  src,
  dst,
  kind: "calls",
  confidence: "high",
  count: 2,
  evidence: ["a.ts:1"],
  fileId: `file:${path}`,
});

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gantry-store-"));
  store = openStore(join(dir, "nested", "gantry.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("openStore", () => {
  it("creates every spec table and sets pragmas", () => {
    const names = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of [
      "meta",
      "workspaces",
      "files",
      "symbols",
      "edges",
      "descriptions",
      "backlog",
      "usage_log",
      "dismissals",
      "overviews",
      "layouts",
      "fts_symbols",
    ]) {
      expect(names).toContain(t);
    }
    expect(names.some((n) => n.startsWith("vec_"))).toBe(false);
    expect(store.getMeta("schema_version")).toBe("1");
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(store.db.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("is reopenable and throws SchemaTooNewError for a newer version", () => {
    const p = join(dir, "again.db");
    const s = openStore(p);
    s.setMeta("schema_version", "99");
    s.close();
    expect(() => openStore(p)).toThrow(SchemaTooNewError);
    const raw = new Database(p);
    raw.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    raw.close();
    openStore(p).close();
  });

  it("meta round-trips and overwrites", () => {
    expect(store.getMeta("head_sha")).toBeUndefined();
    store.setMeta("head_sha", "abc");
    store.setMeta("head_sha", "def");
    expect(store.getMeta("head_sha")).toBe("def");
  });

  it("upserts workspaces with JSON columns", () => {
    const w = {
      id: "ws:.",
      name: "root",
      dir: ".",
      kind: "app" as const,
      frameworks: ["react"],
      deps: ["zod"],
      exportsMap: { ".": "./index.js" },
    };
    store.upsertWorkspaces([w]);
    store.upsertWorkspaces([{ ...w, kind: "package" }]);
    const rows = store.db.prepare("SELECT * FROM workspaces").all() as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("package");
    expect(JSON.parse(rows[0]?.frameworks ?? "")).toEqual(["react"]);
    expect(JSON.parse(rows[0]?.exports_map ?? "")).toEqual({ ".": "./index.js" });
  });
});

describe("effective view", () => {
  const seedMain = () => {
    store.replaceFile(
      "main",
      file("a.ts"),
      [sym("a.ts", "foo"), sym("a.ts", "bar", { exported: false, kind: "const" })],
      [edge("a.ts", "sym:a.ts#foo", "sym:a.ts#bar")],
    );
    store.replaceFile("main", file("b.ts"), [sym("b.ts", "baz")], []);
  };

  it("main only, sorted by id, with round-tripped fields", () => {
    seedMain();
    expect(store.effectiveFiles().map((f) => f.id)).toEqual(["file:a.ts", "file:b.ts"]);
    const syms = store.effectiveSymbols();
    expect(syms.map((s) => s.id)).toEqual(["sym:a.ts#bar", "sym:a.ts#foo", "sym:b.ts#baz"]);
    const foo = store.getSymbol("sym:a.ts#foo");
    expect(foo).toEqual(sym("a.ts", "foo"));
    expect(foo?.minhash).toBeInstanceOf(Uint32Array);
    expect(foo?.minhash.length).toBe(64);
    expect(store.effectiveEdges()).toEqual([edge("a.ts", "sym:a.ts#foo", "sym:a.ts#bar")]);
    const blob = store.db.prepare("SELECT minhash FROM symbols LIMIT 1").get() as {
      minhash: Buffer;
    };
    expect(blob.minhash.length).toBe(256);
  });

  it("filters", () => {
    seedMain();
    expect(store.effectiveSymbols({ fileId: "file:b.ts" }).map((s) => s.name)).toEqual(["baz"]);
    expect(store.effectiveSymbols({ kind: ["const"] }).map((s) => s.name)).toEqual(["bar"]);
    expect(store.effectiveSymbols({ exported: false }).map((s) => s.name)).toEqual(["bar"]);
    expect(store.effectiveSymbols({ exported: true })).toHaveLength(2);
    expect(store.effectiveEdges({ src: "sym:a.ts#foo" })).toHaveLength(1);
    expect(store.effectiveEdges({ dst: "sym:nope" })).toHaveLength(0);
    expect(store.effectiveEdges({ kind: ["imports"] })).toHaveLength(0);
    expect(store.effectiveEdges({ kind: ["calls", "imports"] })).toHaveLength(1);
  });

  it("working row overrides main for that file only", () => {
    seedMain();
    store.replaceFile(
      "working",
      file("a.ts", { contentHash: "new" }),
      [sym("a.ts", "foo", { signature: "function foo(x)" })],
      [],
    );
    expect(store.effectiveFiles().find((f) => f.id === "file:a.ts")?.contentHash).toBe("new");
    expect(store.effectiveSymbols().map((s) => s.id)).toEqual(["sym:a.ts#foo", "sym:b.ts#baz"]);
    expect(store.getSymbol("sym:a.ts#foo")?.signature).toBe("function foo(x)");
    expect(store.getSymbol("sym:a.ts#bar")).toBeUndefined();
    expect(store.effectiveEdges()).toEqual([]);
  });

  it("working delete hides main rows; clearWorking restores main", () => {
    seedMain();
    store.markDeleted("working", "file:a.ts");
    expect(store.effectiveFiles().map((f) => f.id)).toEqual(["file:b.ts"]);
    expect(store.effectiveSymbols().map((s) => s.id)).toEqual(["sym:b.ts#baz"]);
    expect(store.effectiveEdges()).toEqual([]);
    expect(store.getSymbol("sym:a.ts#foo")).toBeUndefined();
    // main rows physically remain
    expect(store.db.prepare("SELECT count(*) c FROM symbols WHERE layer='main'").get()).toEqual({
      c: 3,
    });
    store.clearWorking("file:a.ts");
    expect(store.effectiveFiles()).toHaveLength(2);
    expect(store.effectiveSymbols()).toHaveLength(3);
    expect(store.effectiveEdges()).toHaveLength(1);
  });

  it("clearWorking() with no argument clears all working rows", () => {
    seedMain();
    store.replaceFile("working", file("a.ts"), [sym("a.ts", "other")], []);
    store.markDeleted("working", "file:b.ts");
    store.replaceFile("working", file("c.ts"), [sym("c.ts", "only")], []);
    store.clearWorking();
    expect(store.effectiveFiles().map((f) => f.id)).toEqual(["file:a.ts", "file:b.ts"]);
    expect(store.effectiveSymbols()).toHaveLength(3);
    expect(store.db.prepare("SELECT count(*) c FROM files WHERE layer='working'").get()).toEqual({
      c: 0,
    });
  });

  it("markDeleted on main removes the file from the view", () => {
    seedMain();
    store.markDeleted("main", "file:a.ts");
    expect(store.effectiveFiles().map((f) => f.id)).toEqual(["file:b.ts"]);
    expect(store.effectiveSymbols()).toHaveLength(1);
    store.markDeleted("working", "file:never-seen.ts");
    expect(store.effectiveFiles().map((f) => f.id)).toEqual(["file:b.ts"]);
  });

  it("replaceFile is idempotent and removes stale rows", () => {
    seedMain();
    const snap = () => [store.effectiveFiles(), store.effectiveSymbols(), store.effectiveEdges()];
    const before = snap();
    seedMain();
    seedMain();
    expect(snap()).toEqual(before);
    store.replaceFile("main", file("a.ts"), [sym("a.ts", "foo")], []);
    expect(store.effectiveSymbols({ fileId: "file:a.ts" }).map((s) => s.name)).toEqual(["foo"]);
    expect(store.effectiveEdges()).toEqual([]);
    expect(store.effectiveSymbols({ fileId: "file:b.ts" })).toHaveLength(1);
  });

  it("tx rolls back on throw and nests", () => {
    expect(() =>
      store.tx(() => {
        store.setMeta("k", "v");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getMeta("k")).toBeUndefined();
    expect(store.tx(() => store.tx(() => 7))).toBe(7);
  });
});

describe("fts", () => {
  it("upserts and removes rows", () => {
    const row = {
      nameTokens: "parse http",
      suggestedName: "",
      path: "a.ts",
      behavior: "parses",
      searchTerms: "parser",
    };
    store.fts.upsert("sym:a.ts#x", row);
    store.fts.upsert("sym:a.ts#x", { ...row, behavior: "changed" });
    const count = () =>
      store.db.prepare("SELECT count(*) c FROM fts_symbols WHERE symbol_id = 'sym:a.ts#x'").get();
    expect(count()).toEqual({ c: 1 });
    expect(
      store.db.prepare("SELECT behavior FROM fts_symbols WHERE fts_symbols MATCH 'changed'").get(),
    ).toEqual({ behavior: "changed" });
    store.fts.remove("sym:a.ts#x");
    expect(count()).toEqual({ c: 0 });
  });
});

describe("splitIdentifier", () => {
  it.each([
    ["parseHTTPResponse2xx", ["parse", "http", "response", "2", "xx"]],
    ["snake_case_name", ["snake", "case", "name"]],
    ["PascalCase", ["pascal", "case"]],
    ["useAuth", ["use", "auth"]],
    ["$weird__id", ["weird", "id"]],
    ["", []],
  ])("%s", (input, expected) => {
    expect(splitIdentifier(input)).toEqual(expected);
  });
});

describe("concurrent writers", () => {
  it("two worker threads writing at once neither corrupt nor throw SQLITE_BUSY", async () => {
    // Workers cannot load .ts, so bundle the store once into a temp dir.
    const out = join(dir, "bundle");
    mkdirSync(out, { recursive: true });
    await build({
      entry: { store: join(here, "index.ts") },
      outDir: out,
      format: ["esm"],
      platform: "node",
      target: "node22",
      external: ["better-sqlite3"],
      silent: true,
      dts: false,
      config: false,
    });
    copyFileSync(join(here, "schema.sql"), join(out, "schema.sql"));
    symlinkSync(join(here, "../../node_modules"), join(out, "node_modules"), "dir");
    const workerPath = join(out, "worker.mjs");
    writeFileSync(
      workerPath,
      `import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "./store.js";
const s = openStore(workerData.db);
const mh = new Uint32Array(64);
for (let i = 0; i < workerData.n; i++) {
  const path = workerData.tag + i + ".ts";
  s.replaceFile("main", { id: "file:" + path, path, workspaceId: null, contentHash: "h", mtimeMs: 1, deleted: false },
    [{ id: "sym:" + path + "#f", fileId: "file:" + path, name: "f", kind: "function", exported: true, signature: "",
       startLine: 1, endLine: 1, loc: 1, complexity: 1, stmtCount: 1, exactHash: "e", shapeHash: "s", minhash: mh }], []);
  s.setMeta("last_" + workerData.tag, String(i));
}
s.close();
parentPort.postMessage("done");
`,
    );
    const dbPath = join(dir, "shared.db");
    openStore(dbPath).close(); // pre-create; the first-open race is covered below
    const n = 150;
    const run = (tag: string) =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(workerPath, { workerData: { db: dbPath, tag, n } });
        w.on("message", () => resolve());
        w.on("error", reject);
        w.on("exit", (c) => c !== 0 && reject(new Error(`worker exit ${c}`)));
      });
    await Promise.all([run("a"), run("b")]);
    const s = openStore(dbPath);
    expect(s.effectiveFiles()).toHaveLength(n * 2);
    expect(s.effectiveSymbols()).toHaveLength(n * 2);
    expect(s.db.pragma("integrity_check", { simple: true })).toBe("ok");
    s.close();
  }, 60_000);
});
