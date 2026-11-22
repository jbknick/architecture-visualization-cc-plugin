import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scipDescriptor } from "./map.js";
import { ProtoError } from "./proto.js";
import { readScip, type ScipDocument } from "./read.js";

// A SCIP index built by hand, field numbers as in scip.proto.
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const tag = (no: number, wire: number): number[] => varint(no * 8 + wire);
const len = (no: number, bytes: number[]): number[] => [...tag(no, 2), ...varint(bytes.length), ...bytes];
const str = (no: number, s: string): number[] => len(no, [...Buffer.from(s, "utf8")]);
const int = (no: number, n: number): number[] => [...tag(no, 0), ...varint(n)];

const occurrence = (opts: {
  legacy?: number[];
  unpacked?: number[];
  single?: [number, number, number];
  multi?: [number, number, number, number];
  symbol: string;
  roles?: number;
}): number[] => [
  ...(opts.legacy ? len(1, opts.legacy.flatMap(varint)) : []),
  ...(opts.unpacked ?? []).flatMap((n) => int(1, n)),
  ...(opts.single
    ? len(8, [...int(1, opts.single[0]), ...int(2, opts.single[1]), ...int(3, opts.single[2])])
    : []),
  ...(opts.multi
    ? len(9, [
        ...int(1, opts.multi[0]),
        ...int(2, opts.multi[1]),
        ...int(3, opts.multi[2]),
        ...int(4, opts.multi[3]),
      ])
    : []),
  ...str(2, opts.symbol),
  ...(opts.roles ? int(3, opts.roles) : []),
];

const document = (path: string, occurrences: number[][], extra: number[] = []): number[] => [
  ...str(1, path),
  ...occurrences.flatMap((o) => len(2, o)),
  ...len(3, [...str(1, "pkg . . . f()."), ...int(5, 17), ...str(6, "f")]),
  ...str(4, "TypeScript"),
  ...int(6, 2),
  ...extra,
];

const index = (docs: number[][]): Buffer =>
  Buffer.from([
    ...len(1, [
      ...int(1, 0),
      ...len(2, [...str(1, "scip-typescript"), ...str(2, "0.6.2")]),
      ...str(3, "file:///root"),
    ]),
    ...docs.flatMap((d) => len(2, d)),
    ...len(3, [...str(1, "ext . . . g().")]),
  ]);

const dir = mkdtempSync(join(tmpdir(), "gantry-scip-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function read(bytes: Buffer, name: string) {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  const documents: ScipDocument[] = [];
  let metadata: unknown;
  for await (const item of readScip(file)) {
    if (item.kind === "metadata") metadata = item.metadata;
    else documents.push(item.document);
  }
  return { documents, metadata };
}

describe("readScip", () => {
  it("reads the metadata, the documents and what they hold, and skips external symbols", async () => {
    const { documents, metadata } = await read(
      index([document("src/a.ts", [occurrence({ legacy: [1, 2, 3], symbol: "pkg . . . f().", roles: 1 })])]),
      "basic.scip",
    );
    expect(metadata).toEqual({
      toolName: "scip-typescript",
      toolVersion: "0.6.2",
      projectRoot: "file:///root",
    });
    expect(documents).toEqual([
      {
        path: "src/a.ts",
        language: "TypeScript",
        positionEncoding: 2,
        occurrences: [
          { line: 1, startCharacter: 2, endLine: 1, endCharacter: 3, symbol: "pkg . . . f().", roles: 1 },
        ],
        symbols: [{ symbol: "pkg . . . f().", kind: 17, displayName: "f" }],
      },
    ]);
  });

  it("reads a range of three integers, of four, an unpacked one and the typed ranges", async () => {
    const { documents } = await read(
      index([
        document("a.ts", [
          occurrence({ legacy: [4, 5, 9], symbol: "s1" }),
          occurrence({ legacy: [4, 5, 6, 7], symbol: "s2" }),
          occurrence({ unpacked: [7, 1, 2], symbol: "s3" }),
          occurrence({ single: [8, 3, 4], symbol: "s4" }),
          occurrence({ multi: [9, 0, 11, 2], symbol: "s5" }),
          // `typed_range` wins over the deprecated `range` when both are set.
          occurrence({ legacy: [1, 1, 1], single: [2, 2, 3], symbol: "s6" }),
        ]),
      ]),
      "ranges.scip",
    );
    const r = (documents[0] as ScipDocument).occurrences.map((o) => [
      o.line,
      o.startCharacter,
      o.endLine,
      o.endCharacter,
    ]);
    expect(r).toEqual([
      [4, 5, 4, 9],
      [4, 5, 6, 7],
      [7, 1, 7, 2],
      [8, 3, 8, 4],
      [9, 0, 11, 2],
      [2, 2, 2, 3],
    ]);
  });

  it("skips fields it does not know, whatever their wire type", async () => {
    const extra = [
      ...tag(40, 5),
      1,
      2,
      3,
      4,
      ...tag(41, 1),
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      ...str(42, "ignored"),
      ...int(43, 9),
    ];
    const { documents } = await read(index([document("a.ts", [], extra)]), "unknown.scip");
    expect((documents[0] as ScipDocument).path).toBe("a.ts");
  });

  it("streams an index larger than one read buffer, one document at a time", async () => {
    const docs: number[][] = [];
    for (let i = 0; i < 30000; i++) {
      docs.push(
        document(`src/file${i}.ts`, [
          occurrence({ legacy: [i % 100, 0, 5], symbol: `pkg . . . f${i}().`, roles: 1 }),
        ]),
      );
    }
    const bytes = index(docs);
    expect(bytes.length).toBeGreaterThan(2 * (1 << 20));
    const { documents } = await read(bytes, "big.scip");
    expect(documents).toHaveLength(30000);
    expect((documents[29999] as ScipDocument).path).toBe("src/file29999.ts");
    expect((documents[29999] as ScipDocument).occurrences[0]?.symbol).toBe("pkg . . . f29999().");
  });

  it("rejects a file that ends inside a field", async () => {
    const bytes = index([document("a.ts", [])]);
    await expect(read(bytes.subarray(0, bytes.length - 20), "cut.scip")).rejects.toBeInstanceOf(ProtoError);
  });
});

describe("scipDescriptor", () => {
  const sym = (d: string): string => `scip-typescript npm @acme/web 0.0.0 ${d}`;
  it("gives the last descriptor's name and kind of suffix", () => {
    expect(scipDescriptor(sym("src/`date.ts`/formatRelativeDate()."))).toEqual({
      name: "formatRelativeDate",
      suffix: "method",
    });
    expect(scipDescriptor(sym("src/`counter.ts`/Counter#increment()."))).toEqual({
      name: "increment",
      suffix: "method",
    });
    expect(scipDescriptor(sym("src/`counter.ts`/Counter#"))).toEqual({ name: "Counter", suffix: "type" });
    expect(scipDescriptor(sym("src/`schema.ts`/posts."))).toEqual({ name: "posts", suffix: "term" });
    expect(scipDescriptor(sym("src/`router.ts`/posts0:"))).toEqual({ name: "posts0", suffix: "meta" });
    expect(scipDescriptor(sym("src/`a.ts`/f().(x)"))).toEqual({ name: "x", suffix: "parameter" });
  });
  it("reads backtick names, a doubled backtick and an escaped space in the package", () => {
    expect(scipDescriptor(sym("src/`a``b.ts`/"))).toEqual({ name: "a`b.ts", suffix: "namespace" });
    expect(scipDescriptor("scip-typescript npm my  pkg 1.0 src/`a.ts`/f().")).toEqual({
      name: "f",
      suffix: "method",
    });
  });
  it("gives nothing for a local symbol or a malformed one", () => {
    expect(scipDescriptor("local 3")).toBeUndefined();
    expect(scipDescriptor("scip-typescript npm pkg")).toBeUndefined();
    expect(scipDescriptor(sym("src/a.ts?"))).toBeUndefined();
  });
});
