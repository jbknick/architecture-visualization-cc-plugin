import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sqlite-vec cannot be loaded on this "machine" (for example an unsupported platform).
vi.mock("sqlite-vec", () => ({
  load: () => {
    throw new Error("no prebuilt sqlite-vec for this platform");
  },
}));

import { openStore, type Store } from "../store/index.js";
import { embedPending, ensureVecTables, knn, offlineEmbedder, putVectors, vecAvailable } from "./index.js";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gantry-failopen-"));
  store = openStore(join(dir, "gantry.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("sqlite-vec unavailable (fail open)", () => {
  it("opens the store, records meta.vec_available = 0 and creates no vec tables", () => {
    expect(store.getMeta("vec_available")).toBe("0");
    expect(store.getMeta("schema_version")).toBe("2");
    expect(vecAvailable(store)).toBe(false);
    const names = (store.db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names.some((n) => n.startsWith("vec_"))).toBe(false);
    expect(store.getMeta("embed_model")).toBeUndefined();
  });

  it("the rest of the store keeps working", () => {
    store.setMeta("head_sha", "abc");
    expect(store.getMeta("head_sha")).toBe("abc");
    expect(store.effectiveSymbols()).toEqual([]);
  });

  it("every vector entry point is a harmless no-op", async () => {
    expect(ensureVecTables(store, 768)).toBe(false);
    expect(knn(store, "vec_code", new Float32Array(768), 5)).toEqual([]);
    store.db
      .prepare(
        "INSERT INTO descriptions(content_key, behavior, search_terms) VALUES ('k:p1', 'Does x.', '[\"x\"]')",
      )
      .run();
    expect(await embedPending(store, { embedder: offlineEmbedder() })).toEqual({ descriptions: 0, code: 0 });
    expect(() => putVectors(store, "vec_code", [])).not.toThrow();
  });
});
