import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../../indexer.js";
import { resolvePaths } from "../../paths/index.js";
import { openStore } from "../../store/index.js";
import type { EdgeRecord } from "../../types.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../test/helpers/fixture.js";
const { materializeFixture, materializeFiles } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
  materializeFiles: (files: Record<string, string>) => Promise<MaterializedFixture>;
};

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

/** Indexes a repo directory and returns the `calls`, `extends` and `implements` edges as `src -> dst` strings. */
async function edgesOf(dir: string): Promise<{ kind: string; src: string; dst: string; conf: string }[]> {
  const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const s = openStore(paths.dbPath);
  try {
    const short = (id: string): string => id.replace(/^sym:[^:]+:/, "");
    return (dumpGraph(s).edges as EdgeRecord[])
      .filter((e) => e.kind === "calls" || e.kind === "extends" || e.kind === "implements")
      .map((e) => ({ kind: e.kind, src: short(e.src), dst: short(e.dst), conf: e.confidence }));
  } finally {
    s.close();
  }
}

/** A throwaway repo holding a module `example.com/m` and the given files. */
async function repoOf(files: Record<string, string>): Promise<string> {
  const fx = await materializeFiles({ "go.mod": "module example.com/m\n\ngo 1.22\n", ...files });
  cleanups.push(() => fx.cleanup());
  return fx.dir;
}

describe("go call edges on fixtures/go-basic", () => {
  let edges: Awaited<ReturnType<typeof edgesOf>>;
  const has = (kind: string, src: string, dst: string, conf?: string): boolean =>
    edges.some(
      (e) => e.kind === kind && e.src === src && e.dst === dst && (conf === undefined || e.conf === conf),
    );

  it("indexes the fixture", async () => {
    const fx = await materializeFixture("go-basic");
    cleanups.push(() => fx.cleanup());
    edges = await edgesOf(fx.dir);
    expect(edges.length).toBeGreaterThan(0);
  });

  it("same-package call", () => {
    expect(has("calls", "internal/text/slug.go#Slugify", "internal/text/slug.go#trimDashes", "high")).toBe(
      true,
    );
    expect(has("calls", "internal/app/app.go#clean", "internal/text/slug.go#Slugify")).toBe(true);
  });

  it("package-qualified call, plain and through an aliased import", () => {
    expect(has("calls", "internal/app/app.go#App.Run", "internal/text/slug.go#Slugify", "high")).toBe(true);
    expect(has("calls", "cmd/server/main.go#main", "internal/text/slug.go#Slugify", "high")).toBe(true);
    expect(has("calls", "cmd/server/main.go#main", "internal/store/store.go#New", "high")).toBe(true);
    expect(has("calls", "internal/app/app.go#New", "internal/store/store.go#New")).toBe(true);
  });

  it("method on a local variable and on a struct field chain", () => {
    expect(has("calls", "cmd/server/main.go#main", "internal/store/store.go#Store.Put", "high")).toBe(true);
    expect(has("calls", "cmd/server/main.go#main", "internal/store/store.go#Store.Get", "high")).toBe(true);
    expect(has("calls", "internal/app/app.go#App.Run", "internal/store/store.go#Store.Put", "high")).toBe(
      true,
    );
    expect(has("calls", "internal/app/app.go#App.Run", "internal/store/store.go#Store.Get", "high")).toBe(
      true,
    );
  });

  it("method promoted through embedding", () => {
    expect(has("calls", "internal/store/store.go#Warm", "internal/store/store.go#Store.Put", "high")).toBe(
      true,
    );
  });

  it("method on a range variable over a slice", () => {
    expect(has("calls", "internal/store/store.go#Dump", "internal/store/store.go#Store.Get", "high")).toBe(
      true,
    );
  });

  it("call through an interface goes to the interface method symbol", () => {
    expect(has("calls", "internal/store/store.go#Lookup", "internal/store/store.go#Reader.Get", "high")).toBe(
      true,
    );
    expect(has("calls", "internal/store/store.go#Lookup", "internal/store/store.go#Store.Get")).toBe(false);
  });

  it("types implement an interface by method names, at low confidence", () => {
    expect(has("implements", "internal/store/store.go#Store", "internal/store/store.go#Reader", "low")).toBe(
      true,
    );
    expect(has("implements", "internal/store/store.go#Mirror", "internal/store/store.go#Reader", "low")).toBe(
      true,
    );
    // Promoted methods count.
    expect(has("implements", "internal/store/store.go#Cache", "internal/store/store.go#Reader", "low")).toBe(
      true,
    );
    expect(edges.some((e) => e.kind === "implements" && e.src === "internal/app/app.go#App")).toBe(false);
  });

  it("a struct extends each embedded in-repo type", () => {
    expect(has("extends", "internal/store/store.go#Cache", "internal/store/store.go#Store", "high")).toBe(
      true,
    );
    expect(edges.filter((e) => e.kind === "extends")).toHaveLength(1);
  });

  it("emits no edge for an external call", () => {
    expect(edges.some((e) => e.dst.includes("fmt") || e.dst.includes("strings"))).toBe(false);
  });
});

describe("go call edges on small repos", () => {
  it("an unknown receiver emits no edge", async () => {
    const dir = await repoOf({
      "a/a.go": `package a

type T struct{}

func (t *T) Run() {}

func Use(m map[string]any, f func() int) {
	x := m["k"]
	x.Run()
	y := f()
	y.Run()
	undefinedHelper()
}
`,
    });
    const edges = await edgesOf(dir);
    expect(edges.filter((e) => e.kind === "calls")).toEqual([]);
  });

  it("an external http.ResponseWriter.Header() call emits no in-repo edge", async () => {
    const dir = await repoOf({
      "srv/srv.go": `package srv

import "net/http"

type Handler struct{}

func (h Handler) Header() {}

func Serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("a", "b")
	w.WriteHeader(200)
}

type Wrapper struct {
	http.ResponseWriter
}

func (w Wrapper) Mark() {
	w.Header().Set("a", "b")
}
`,
    });
    const edges = await edgesOf(dir);
    expect(edges.filter((e) => e.kind === "calls")).toEqual([]);
  });

  it("maps imports by the package clause, not the last path element", async () => {
    const dir = await repoOf({
      "lib/v2/lib.go": "package lib\n\nfunc Do() {}\n",
      "app/app.go": `package app

import "example.com/m/lib/v2"

func Run() { lib.Do() }
`,
    });
    const edges = await edgesOf(dir);
    expect(edges.map((e) => `${e.src}>${e.dst}`)).toContain("app/app.go#Run>lib/v2/lib.go#Do");
  });

  it("infers element types of slices and maps, constructor results and type assertions", async () => {
    const dir = await repoOf({
      "a/a.go": `package a

type T struct{}

func (t *T) Run() {}
func NewT() *T { return &T{} }

type Group []*T

func Each(g Group, m map[string]*T, a any) {
	for _, t := range g {
		t.Run()
	}
	for _, v := range m {
		v.Run()
	}
	first := g[0]
	first.Run()
	n := NewT()
	n.Run()
	if t, ok := a.(*T); ok {
		t.Run()
	}
	func() {
		n.Run()
	}()
}
`,
    });
    const edges = await edgesOf(dir);
    const calls = edges.filter((e) => e.kind === "calls");
    expect(calls.map((e) => `${e.src}>${e.dst}`).sort()).toEqual([
      "a/a.go#Each>a/a.go#NewT",
      "a/a.go#Each>a/a.go#T.Run",
    ]);
  });
});
