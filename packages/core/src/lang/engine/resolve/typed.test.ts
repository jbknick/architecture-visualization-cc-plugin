import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileId, symId } from "../../../ids.js";
import type { ParsedFile } from "../../../parse/index.js";
import type { ResolveContext, Resolver } from "../../../resolve/index.js";
import type { EdgeRecord } from "../../../types.js";
import { goPack } from "../../packs/index.js";
import { buildLanguage } from "../module.js";
import type { LanguagePack } from "../pack.js";
import { typeCallResolver } from "./typed.js";

/**
 * A synthetic language that keeps the typing rules of the pack it is cut from: its own extension and manifest, reading
 * its sources with a grammar the engine already has loaded. The files below are written in that grammar's syntax.
 */
const typedPack = {
  ...goPack,
  id: "typed",
  label: "Typed",
  extensions: [".tt"],
  testPatterns: ["**/*_check.tt"],
  workspace: {
    manifest: "typed.mod",
    quotes: '"',
    comment: /#.*$/gm,
    name: /^\s*name\s+(\S+)/m,
    skipDirs: [],
    deps: { directive: "needs", tokens: 1 },
    main: /^package main\b/m,
    group: { file: "typed.work", directive: "use", tokens: 1 },
  },
} as const satisfies LanguagePack;

const FILES: Record<string, string> = {
  "typed.mod": "name app\n",
  "main.tt": `package main

import "app/util"

type Runner interface {
	Run()
}

type Job struct{ n int }

func (j *Job) Run() {}

type Base struct{}

func (b Base) Setup() {}

type Task struct {
	Base
	job *Job
}

func NewJob() *Job { return &Job{} }

func Main(r Runner, t Task) {
	r.Run()
	t.Setup()
	t.job.Run()
	k := NewJob()
	k.Run()
	util.Make().Hit()
	unknown.Run()
}

func Bare() {
	Setup()
	Hit()
}
`,
  "util/util.tt": `package util

type Maker struct{}

func (m *Maker) Hit() {}

func Make() *Maker { return &Maker{} }
`,
};

const REPO = "typedrepo";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function indexed(files: Record<string, string>): {
  edges: EdgeRecord[];
  resolver: Resolver;
  ctx: ResolveContext;
} {
  const root = mkdtempSync(join(tmpdir(), "gantry-typed-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const lang = buildLanguage(typedPack);
  const workspaces = lang.detectWorkspaces(root, { workspaces: { overrides: {} } }, REPO);
  const parsed = new Map<string, ParsedFile>();
  for (const rel of Object.keys(files).filter((f) => f.endsWith(".tt")))
    parsed.set(fileId(REPO, rel), lang.parseSource(REPO, rel, readFileSync(join(root, rel), "utf8")));
  const ctx: ResolveContext = { root, repo: REPO, workspaces, parsed };
  const resolver = lang.createResolver(ctx);
  const edges = [...parsed.keys()].sort().flatMap((id) => resolver.edgesForFile(id));
  return { edges, resolver, ctx };
}

const sym = (rel: string, name: string): string => symId(REPO, rel, name);
const from = (edges: EdgeRecord[], kind: string, src: string): EdgeRecord[] =>
  edges.filter((e) => e.kind === kind && e.src === src);

/** True when a syntax node is reachable from the value through fields, maps, sets and arrays. */
function holdsNode(root: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (v: unknown): boolean => {
    if (typeof v !== "object" || v === null || seen.has(v)) return false;
    seen.add(v);
    const o = v as { kind?: unknown; findAll?: unknown };
    if (typeof o.kind === "function" && typeof o.findAll === "function") return true;
    if (v instanceof Map) return [...v.entries()].some(([k, x]) => walk(k) || walk(x));
    if (v instanceof Set || Array.isArray(v)) return [...v].some(walk);
    return Object.values(v).some(walk);
  };
  return walk(root);
}

describe("the type resolver on a synthetic pack", () => {
  const mainId = sym("main.tt", "Main");

  it("resolves the receiver of a call from a parameter, a field chain, a constructor result and a result type", () => {
    const { edges } = indexed(FILES);
    const calls = from(edges, "calls", mainId);
    expect(calls.map((e) => e.dst).sort()).toEqual(
      [
        sym("main.tt", "Base.Setup"),
        sym("main.tt", "Job.Run"),
        sym("main.tt", "NewJob"),
        sym("main.tt", "Runner.Run"),
        sym("util/util.tt", "Maker.Hit"),
        sym("util/util.tt", "Make"),
      ].sort(),
    );
    expect(calls.every((e) => e.confidence === "high" && e.level === 2)).toBe(true);
    expect(calls.find((e) => e.dst === sym("main.tt", "Job.Run"))?.count).toBe(2);
  });

  it("gives an interface call the interface's method and a promoted method the declaring type's", () => {
    const calls = from(indexed(FILES).edges, "calls", mainId);
    expect(calls.some((e) => e.dst === sym("main.tt", "Runner.Run"))).toBe(true);
    expect(calls.some((e) => e.dst === sym("main.tt", "Base.Setup"))).toBe(true);
  });

  it("makes no edge from a name alone, or from a receiver of unknown type", () => {
    const { edges } = indexed(FILES);
    expect(from(edges, "calls", sym("main.tt", "Bare"))).toEqual([]);
    expect(from(edges, "calls", mainId).some((e) => e.evidence.includes("main.tt:31"))).toBe(false);
  });

  it("adds extends for an embedded type and implements, at low confidence, for a type that covers an interface", () => {
    const { edges } = indexed(FILES);
    expect(from(edges, "extends", sym("main.tt", "Task"))).toMatchObject([
      { dst: sym("main.tt", "Base"), confidence: "high" },
    ]);
    expect(from(edges, "implements", sym("main.tt", "Job"))).toMatchObject([
      { dst: sym("main.tt", "Runner"), confidence: "low" },
    ]);
  });

  it("finds a target and a type by place", () => {
    const { resolver } = indexed(FILES);
    const source = FILES["main.tt"] as string;
    const id = fileId(REPO, "main.tt");
    const call = "t.job.Run()";
    const at = source.indexOf(call);
    expect(resolver.targetAt?.(id, at, at + call.length)).toBe(sym("main.tt", "Job.Run"));
    const recv = source.indexOf("t.job.Run");
    expect(resolver.typeNameAt?.(id, recv, recv + "t.job".length)).toBe("Job");
    expect(resolver.targetAt?.(id, at, at + 1)).toBeNull();
  });

  it("holds no syntax tree once the edges and the places are read", () => {
    const { ctx } = indexed(FILES);
    const calls = typeCallResolver(typedPack)(ctx);
    const id = fileId(REPO, "main.tt");
    const parsed = ctx.parsed.get(id) as ParsedFile;
    expect(calls.edgesForFile(id, parsed).length).toBeGreaterThan(0);
    const at = (FILES["main.tt"] as string).indexOf("k.Run()");
    expect(calls.targetAt(id, at, at + "k.Run()".length)).toBe(sym("main.tt", "Job.Run"));
    expect(calls.typeNameAt(id, at, at + 1)).toBe("Job");
    expect(holdsNode(calls)).toBe(false);
    // The scan finds a node where one is held.
    expect(holdsNode({ keep: [{ kind: () => "x", findAll: () => [] }] })).toBe(true);
  });

  it("dumps byte-equal edges from two fresh folders", () => {
    const dumps = [0, 1].map(() => JSON.stringify(indexed(FILES).edges, null, 2));
    expect(dumps[0]).toBe(dumps[1]);
    expect(dumps[0]?.length).toBeGreaterThan(100);
  });
});
