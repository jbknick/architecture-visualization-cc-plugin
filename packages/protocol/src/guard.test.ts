import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { assertNoSource, MAX_STRING_LENGTH, UploadRefused } from "./guard.js";
import { DEFAULT_PART_LIMITS, splitIntoParts } from "./parts.js";
import type { PartRecord } from "./schemas.js";
import { changeSet, description, REPO, SHA, snapshot } from "./testing/samples.js";

// Counts every gzip the package asks for, so a test can show that a refused record was never compressed.
vi.mock("node:zlib", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:zlib")>();
  return { ...real, gzipSync: vi.fn(real.gzipSync) };
});

const FIXTURES = join(import.meta.dirname, "../../../fixtures/team-upload");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const FORBIDDEN = [
  "signature",
  "body",
  "text",
  "code",
  "snippet",
  "doc",
  "content",
  "contents",
  "fact_sheet",
  "factSheet",
] as const;

const refusedAt = (value: unknown): string => {
  try {
    assertNoSource(value);
  } catch (err) {
    expect(err).toBeInstanceOf(UploadRefused);
    expect((err as UploadRefused).message).toBe(
      `upload refused: field ${(err as UploadRefused).path} may carry source`,
    );
    return (err as UploadRefused).path;
  }
  throw new Error("assertNoSource did not throw");
};

describe("assertNoSource: forbidden keys", () => {
  for (const key of FORBIDDEN) {
    it(`refuses "${key}" at depth 1, nested in an array, in an UploadStart and in a part record`, () => {
      expect(refusedAt({ [key]: "x" })).toBe(key);
      expect(refusedAt({ symbols: [{ id: "a" }, {}, {}, { [key]: "x" }] })).toBe(`symbols[3].${key}`);
      expect(refusedAt({ a: { b: [[{ [key]: 1 }]] } })).toBe(`a.b[0][0].${key}`);
      const start = { kind: "main", sha: SHA, counts: { symbols: 1 }, [key]: "x" };
      expect(refusedAt(start)).toBe(key);
      const record = { t: "s", id: "sym:a", name: "a", kind: "function", [key]: "x" };
      expect(refusedAt(record)).toBe(key);
    });
  }

  it("refuses the key whatever its value, even null or undefined or empty", () => {
    for (const value of [null, undefined, "", 0, false, {}, []])
      expect(refusedAt({ signature: value })).toBe("signature");
  });

  it("refuses a key in another case or spelling", () => {
    for (const key of ["Signature", "SIGNATURE", "Fact_Sheet", "fact-sheet", "FactSheet", "Body", "Doc"]) {
      expect(refusedAt({ x: { [key]: "x" } })).toBe(`x.${key}`);
    }
  });

  it("reports the first offence in key order", () => {
    expect(refusedAt({ a: 1, body: 1, signature: 2 })).toBe("body");
  });
});

describe("assertNoSource: the source key", () => {
  it('allows "pr" and "branch" and nothing else', () => {
    expect(() => assertNoSource({ source: "pr" })).not.toThrow();
    expect(() => assertNoSource({ source: "branch" })).not.toThrow();
    expect(refusedAt({ source: "typescript" })).toBe("source");
    expect(refusedAt({ nodes: [{ source: "export const a = 1;" }] })).toBe("nodes[0].source");
    for (const value of ["", "PR", "pr ", 1, null, undefined, {}, ["pr"], true]) {
      expect(refusedAt({ source: value })).toBe("source");
    }
    expect(refusedAt({ Source: "x" })).toBe("Source");
  });
});

describe("assertNoSource: long strings", () => {
  it("allows 1,000 characters and refuses 1,001, at any depth", () => {
    expect(MAX_STRING_LENGTH).toBe(1000);
    expect(() => assertNoSource({ name: "a".repeat(1000) })).not.toThrow();
    expect(refusedAt({ name: "a".repeat(1001) })).toBe("name");
    expect(refusedAt({ files: [{ path: "a".repeat(1001) }] })).toBe("files[0].path");
    expect(refusedAt(["a".repeat(1001)])).toBe("[0]");
    expect(refusedAt("a".repeat(1001))).toBe("$");
  });

  it("refuses a key longer than 1,000 characters and keeps the path short", () => {
    const path = refusedAt({ ["a".repeat(1001)]: 1 });
    expect(path.length).toBeLessThan(100);
  });
});

describe("assertNoSource: values that have no plain JSON form", () => {
  it("refuses a value that could write something other than what it holds", () => {
    class Carrier {
      signature = "x";
    }
    expect(refusedAt({ a: new Carrier() })).toBe("a");
    expect(refusedAt({ a: new Map([["k", "v"]]) })).toBe("a");
    expect(refusedAt({ a: new Date(0) })).toBe("a");
    expect(refusedAt({ a: Buffer.from("export const a = 1") })).toBe("a");
    expect(refusedAt({ a: new Uint8Array(4) })).toBe("a");
    expect(refusedAt({ a: { toJSON: () => "x" } })).toBe("a.toJSON");
    expect(refusedAt({ a: () => "x" })).toBe("a");
    expect(refusedAt({ a: 10n })).toBe("a");
    expect(refusedAt({ a: Symbol("x") })).toBe("a");
    expect(refusedAt({ a: Number.NaN })).toBe("a");
    expect(refusedAt({ a: Number.POSITIVE_INFINITY })).toBe("a");
  });

  it("refuses a getter, which could answer differently when it is read again", () => {
    let reads = 0;
    const value = {
      get name() {
        reads += 1;
        return reads === 1 ? "fine" : "export const secret = 1;";
      },
    };
    expect(refusedAt(value)).toBe("name");
  });

  it("refuses a value that contains itself, and one nested too deep", () => {
    const loop: Record<string, unknown> = {};
    loop.again = loop;
    expect(() => assertNoSource(loop)).toThrow(UploadRefused);
    let deep: unknown = "x";
    for (let i = 0; i < 100; i += 1) deep = { a: deep };
    expect(() => assertNoSource(deep)).toThrow(UploadRefused);
  });

  it("allows a null-prototype object", () => {
    const plain = Object.assign(Object.create(null) as object, { name: "a" });
    expect(() => assertNoSource(plain)).not.toThrow();
  });

  it("is not fooled by a forbidden key set by __proto__ or inherited from a prototype", () => {
    expect(refusedAt(JSON.parse('{"__proto__":{"signature":"x"}}'))).toBe("__proto__.signature");
    const inherited = Object.create({ signature: "x" }) as object;
    expect(() => assertNoSource(inherited)).toThrow(UploadRefused);
  });
});

describe("assertNoSource: what the protocol sends passes", () => {
  it("passes the committed payload fixtures", () => {
    expect(() => assertNoSource(fixture("main-snapshot.json"))).not.toThrow();
    expect(() => assertNoSource(fixture("change-set.json"))).not.toThrow();
    const lines = readFileSync(join(FIXTURES, "main-snapshot.part-1.ndjson"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(() => assertNoSource(JSON.parse(line))).not.toThrow();
  });

  it("passes the package's sample snapshot and change set, a close body and a full description batch", () => {
    expect(() => assertNoSource(snapshot())).not.toThrow();
    expect(() => assertNoSource(changeSet())).not.toThrow();
    expect(() => assertNoSource({ merged: true, head_sha: SHA })).not.toThrow();
    expect(() => assertNoSource({ merged: false })).not.toThrow();
    const full = { ...description(), suggested_name: "joinPath", behavior: "x".repeat(400) };
    expect(Object.keys(full)).toHaveLength(9);
    expect(() =>
      assertNoSource({ repo: REPO, descriptions: [full, description(`${"b".repeat(32)}:p1`)] }),
    ).not.toThrow();
    expect(() => assertNoSource({ kind: "change_set", counts: { nodes: 2, radius: 1 } })).not.toThrow();
  });
});

describe("splitIntoParts refuses before anything is compressed", () => {
  const good: PartRecord = { t: "w", id: `ws:${REPO}:.`, name: "root", path: "." };
  const bad = {
    t: "w",
    id: `ws:${REPO}:.`,
    name: "root",
    path: ".",
    signature: "export const a = 1",
  } as PartRecord;

  it("throws UploadRefused for a bad record after many good ones, with no gzip call", () => {
    const gzip = vi.mocked(zlib.gzipSync);
    gzip.mockClear();
    const records = [...Array.from({ length: 5000 }, () => good), bad];
    expect(() => splitIntoParts(records, DEFAULT_PART_LIMITS)).toThrow(UploadRefused);
    expect(gzip).not.toHaveBeenCalled();
    expect(splitIntoParts([good], DEFAULT_PART_LIMITS)).toHaveLength(1);
    expect(gzip).toHaveBeenCalledTimes(1);
  });

  it("refuses a part record with an injected signature, a source value and a long string", () => {
    for (const injected of [{ signature: "x" }, { source: "typescript" }, { name: "a".repeat(1001) }]) {
      expect(() => splitIntoParts([{ ...good, ...injected } as PartRecord], DEFAULT_PART_LIMITS)).toThrow(
        UploadRefused,
      );
    }
  });
});
