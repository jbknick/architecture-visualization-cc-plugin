import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileId, symId } from "../../../ids.js";
import { encodeParsed, LazyParsedMap } from "../../../parse/cache.js";
import type { ParsedFile } from "../../../parse/index.js";
import type { ResolveContext } from "../../../resolve/index.js";
import type { EdgeRecord } from "../../../types.js";
import type { LanguageModule } from "../../index.js";
import { goPack } from "../../packs/index.js";
import { buildLanguage } from "../module.js";
import type { LanguagePack } from "../pack.js";
import { type FileEntry, ImportIndex, type ImportResolution } from "./imports.js";

/**
 * A synthetic language: its own extension, manifest, name rules and import separator, reading its sources with a grammar
 * the engine already has loaded. The files below are written in that grammar's syntax. It has no typing rules, so its
 * calls are resolved by names alone (level 1).
 */
const { typing: _typing, ...nodesWithoutTyping } = goPack.nodes;
const toyPack = {
  ...goPack,
  id: "toy",
  label: "Toy",
  extensions: [".toy"],
  testPatterns: ["**/*_check.toy"],
  nodes: { ...nodesWithoutTyping, import: { ...goPack.nodes.import, separator: "." } },
  workspace: {
    manifest: "toy.mod",
    quotes: '"',
    comment: /#.*$/gm,
    name: /^\s*name\s+(\S+)/m,
    skipDirs: ["vendored"],
    deps: { directive: "needs", tokens: 1 },
    main: /^package main\b/m,
    group: { file: "toy.work", directive: "use", tokens: 1 },
  },
} as const satisfies LanguagePack;

const FILES: Record<string, string> = {
  "toy.mod": "name app\n",
  "main.toy": `package main

import "app.util"
import "libs.shared"
import "elsewhere.thing"

var boot = helper()

func main() {
	helper()
	util.Run()
	shared.Make()
	thing.Go()
	Remote()
	Dup()
	x.Only()
	y.Twice()
	main()
	nowhere()
	Far()
	Hidden()
	Get()
}

func helper() {}
`,
  "other.toy": `package main

type T struct{}
type U struct{}

func Remote() {}
func Dup() {}
func Go() {}
func (t T) Only() {}
func (t T) Twice() {}
func (u U) Twice() {}
func Get() {}
func (t T) Get() {}
`,
  "main_check.toy": `package main

func Spec() {
	Remote()
	Hidden()
}
`,
  "hidden_check.toy": `package main

func Hidden() {}
`,
  "util/util.toy": `package util

func Run() {}
func Dup() {}
`,
  "libs/toy.mod": "name libs\n",
  "libs/shared/shared.toy": `package shared

func Make() {}
func Far() {}
`,
};

const REPO = "toyrepo";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes the files to a fresh folder and returns every edge of every file, as the module's resolver gives them. */
function indexed(files: Record<string, string>): {
  edges: EdgeRecord[];
  ctx: ResolveContext;
  lang: LanguageModule;
} {
  const root = mkdtempSync(join(tmpdir(), "gantry-toy-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const lang = buildLanguage(toyPack);
  const workspaces = lang.detectWorkspaces(root, { workspaces: { overrides: {} } }, REPO);
  const parsed = new Map<string, ParsedFile>();
  for (const rel of Object.keys(files).filter((f) => f.endsWith(".toy")))
    parsed.set(fileId(REPO, rel), lang.parseSource(REPO, rel, readFileSync(join(root, rel), "utf8")));
  const ctx: ResolveContext = { root, repo: REPO, workspaces, parsed };
  const resolver = lang.createResolver(ctx);
  const edges = [...parsed.keys()].sort().flatMap((id) => resolver.edgesForFile(id));
  return { edges, ctx, lang };
}

const sym = (rel: string, name: string): string => symId(REPO, rel, name);
const calls = (edges: EdgeRecord[]): EdgeRecord[] => edges.filter((e) => e.kind === "calls");
const from = (edges: EdgeRecord[], src: string): EdgeRecord[] =>
  calls(edges).filter((e) => e.src === sym("main.toy", src));

describe("the name resolver on a synthetic pack", () => {
  it("resolves a callee in the same file at high confidence", () => {
    const e = from(indexed(FILES).edges, "main").find((x) => x.dst === sym("main.toy", "helper"));
    expect(e).toMatchObject({
      confidence: "high",
      level: 1,
      count: 1,
      kind: "calls",
      fileId: fileId(REPO, "main.toy"),
    });
    expect(e?.evidence).toEqual(["main.toy:10"]);
  });

  it("resolves an imported name in the same workspace and in a sibling workspace at high confidence", () => {
    const edges = from(indexed(FILES).edges, "main");
    expect(edges.find((x) => x.dst === sym("util/util.toy", "Run"))).toMatchObject({
      confidence: "high",
      level: 1,
    });
    expect(edges.find((x) => x.dst === sym("libs/shared/shared.toy", "Make"))).toMatchObject({
      confidence: "high",
      level: 1,
    });
  });

  it("makes no edge to an external import, even when the repo has a function of that name", () => {
    const edges = from(indexed(FILES).edges, "main");
    expect(edges.some((x) => x.dst === sym("other.toy", "Go"))).toBe(false);
  });

  it("resolves a name that is unique in the repo at low confidence", () => {
    const edges = from(indexed(FILES).edges, "main");
    expect(edges.find((x) => x.dst === sym("other.toy", "Remote"))).toMatchObject({
      confidence: "low",
      level: 1,
    });
  });

  it("makes no edge for a name reached through a receiver that is not an import, even when one method has that name", () => {
    const edges = from(indexed(FILES).edges, "main");
    expect(edges.some((x) => x.dst === sym("other.toy", "T.Only"))).toBe(false);
  });

  it("counts functions and methods together: a clash of kinds gives no edge", () => {
    const edges = from(indexed(FILES).edges, "main");
    expect(edges.filter((x) => x.dst.endsWith("#Get") || x.dst.endsWith(".Get"))).toEqual([]);
  });

  it("reaches a name only in the caller's workspace or one it depends on", () => {
    const far = sym("libs/shared/shared.toy", "Far");
    expect(from(indexed(FILES).edges, "main").some((x) => x.dst === far)).toBe(false);
    const files = { ...FILES, "toy.mod": "name app\nneeds libs\n" };
    expect(from(indexed(files).edges, "main").find((x) => x.dst === far)).toMatchObject({
      confidence: "low",
      level: 1,
    });
  });

  it("names a symbol of a test file only from a test file", () => {
    const { edges } = indexed(FILES);
    const hidden = sym("hidden_check.toy", "Hidden");
    expect(from(edges, "main").some((x) => x.dst === hidden)).toBe(false);
    const spec = calls(edges).filter((x) => x.src === sym("main_check.toy", "Spec"));
    expect(spec.map((x) => x.dst).sort()).toEqual([hidden, sym("other.toy", "Remote")]);
  });

  it("gives no edge to a name with several candidates", () => {
    const edges = from(indexed(FILES).edges, "main");
    expect(edges.filter((x) => x.dst.endsWith("#Dup"))).toEqual([]);
    expect(edges.filter((x) => x.dst.endsWith(".Twice"))).toEqual([]);
  });

  it("makes no edge to a name nothing declares, to the caller itself, or from code outside a function", () => {
    const { edges } = indexed(FILES);
    expect(from(edges, "main").map((x) => x.dst)).toEqual(
      [
        sym("libs/shared/shared.toy", "Make"),
        sym("main.toy", "helper"),
        sym("other.toy", "Remote"),
        sym("util/util.toy", "Run"),
      ].sort(),
    );
    // `var boot = helper()` (line 7) is outside every function.
    expect(calls(edges).filter((x) => x.evidence.includes("main.toy:7"))).toEqual([]);
  });

  it("counts repeated calls on one edge", () => {
    const files = {
      ...FILES,
      "main.toy": FILES["main.toy"]?.replace("\thelper()\n", "\thelper()\n\thelper()\n") ?? "",
    };
    const e = from(indexed(files).edges, "main").find((x) => x.dst === sym("main.toy", "helper"));
    expect(e?.count).toBe(2);
    expect(e?.evidence).toEqual(["main.toy:10", "main.toy:11"]);
  });

  it("resolves a file that imports nothing and sits in no workspace by names in the repo", () => {
    const files = { "a.toy": "package a\n\nfunc One() { Two() }\n", "b.toy": "package a\n\nfunc Two() {}\n" };
    const edges = calls(indexed(files).edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      src: sym("a.toy", "One"),
      dst: sym("b.toy", "Two"),
      confidence: "low",
      level: 1,
    });
  });

  it("resolves an import path to a folder of the same workspace, of a sibling workspace, or to nothing in the repo", () => {
    const { ctx } = indexed(FILES);
    const index = new ImportIndex(toyPack, ctx);
    const main = index.byFileId.get(fileId(REPO, "main.toy")) as FileEntry;
    const names = (r: ImportResolution): string[] => (r.kind === "external" ? [] : r.files.map((f) => f.rel));
    const same = index.resolve(main, "app.util");
    expect(same.kind).toBe("same-workspace");
    expect(names(same)).toEqual(["util/util.toy"]);
    const sibling = index.resolve(main, "libs.shared");
    expect(sibling.kind).toBe("sibling-workspace");
    expect(names(sibling)).toEqual(["libs/shared/shared.toy"]);
    expect(index.resolve(main, "app")).toMatchObject({ kind: "same-workspace" });
    expect(index.resolve(main, "app.missing")).toEqual({ kind: "external", specifier: "app.missing" });
    expect(index.resolve(main, "elsewhere.thing")).toEqual({
      kind: "external",
      specifier: "elsewhere.thing",
    });
  });

  it("lists the files of a lazy parsed map that are not decoded yet", () => {
    const { ctx } = indexed(FILES);
    const lazy = new LazyParsedMap();
    for (const [id, pf] of ctx.parsed) lazy.setRaw(id, encodeParsed(pf));
    const rels = (c: ResolveContext): string[] => new ImportIndex(toyPack, c).files.map((f) => f.rel);
    expect(rels({ ...ctx, parsed: lazy })).toEqual(rels(ctx));
    expect(rels(ctx).length).toBeGreaterThan(3);
  });

  it("finds a target by place and reads no types", () => {
    const { ctx, lang } = indexed(FILES);
    const resolver = lang.createResolver(ctx);
    const source = FILES["main.toy"] as string;
    const at = source.indexOf("helper()\n\tutil");
    expect(resolver.targetAt?.(fileId(REPO, "main.toy"), at, at + "helper()".length)).toBe(
      sym("main.toy", "helper"),
    );
    expect(resolver.targetAt?.(fileId(REPO, "main.toy"), at, at + 1)).toBeNull();
    expect(resolver.typeNameAt?.(fileId(REPO, "main.toy"), at, at + "helper()".length)).toBeNull();
  });

  it("dumps byte-equal edges from two fresh folders", () => {
    const dumps = [0, 1].map(() => JSON.stringify(indexed(FILES).edges, null, 2));
    expect(dumps[0]).toBe(dumps[1]);
    expect(dumps[0]?.length).toBeGreaterThan(100);
  });
});
