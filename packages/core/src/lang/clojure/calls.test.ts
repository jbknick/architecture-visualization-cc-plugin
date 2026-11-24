import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileId } from "../../ids.js";
import { dumpGraph, indexRepo } from "../../indexer.js";
import type { ParsedFile } from "../../parse/index.js";
import { resolvePaths } from "../../paths/index.js";
import { openStore } from "../../store/index.js";
import type { EdgeRecord, WorkspaceRecord } from "../../types.js";
import { parseClojure } from "./parse.js";
import { createClojureResolver } from "./resolve.js";
import { detectClojureWorkspaces } from "./workspace.js";

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

interface Edge {
  kind: string;
  src: string;
  dst: string;
  conf: string;
  level: number | undefined;
}

/** Indexes a repo directory; its `calls` and `depends_on` edges with the repo prefix cut off. */
async function graphOf(dir: string): Promise<{ edges: Edge[]; workspaces: WorkspaceRecord[] }> {
  const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const s = openStore(paths.dbPath);
  try {
    const short = (id: string): string => id.replace(/^(sym|ws):[^:]+:/, "");
    const g = dumpGraph(s);
    return {
      edges: (g.edges as EdgeRecord[])
        .filter((e) => e.kind === "calls" || e.kind === "depends_on")
        .map((e) => ({
          kind: e.kind,
          src: short(e.src),
          dst: short(e.dst),
          conf: e.confidence,
          level: e.level,
        })),
      workspaces: g.workspaces as WorkspaceRecord[],
    };
  } finally {
    s.close();
  }
}

async function edgesOfFiles(files: Record<string, string>): Promise<Edge[]> {
  const fx = await materializeFiles(files);
  cleanups.push(() => fx.cleanup());
  return (await graphOf(fx.dir)).edges.filter((e) => e.kind === "calls");
}

const pairs = (edges: Edge[]): string[] => edges.map((e) => `${e.src} -> ${e.dst} ${e.conf}`).sort();

describe("clojure call edges on fixtures/clojure-basic", () => {
  let edges: Edge[];
  let workspaces: WorkspaceRecord[];
  const has = (src: string, dst: string, conf = "high"): boolean =>
    edges.some(
      (e) => e.kind === "calls" && e.src === src && e.dst === dst && e.conf === conf && e.level === 1,
    );

  it("indexes the fixture", async () => {
    const fx = await materializeFixture("clojure-basic");
    cleanups.push(() => fx.cleanup());
    ({ edges, workspaces } = await graphOf(fx.dir));
    expect(edges.length).toBeGreaterThan(0);
  });

  it("finds one workspace per manifest folder, named by defproject or the folder", () => {
    expect(workspaces.map((w) => `${w.name} ${w.dir} ${w.kind}`)).toEqual([
      "acme/app app app",
      "core core package",
      "tools tools package",
      "ui ui app",
    ]);
    expect(edges.filter((e) => e.kind === "depends_on").map((e) => `${e.src} -> ${e.dst}`)).toEqual([
      "acme/app -> core",
      "tools -> core",
    ]);
  });

  it("resolves an alias, a refer, the namespace of the file and a namespace referred whole (low)", () => {
    expect(has("app/src/acme/app/main.clj#run", "core/src/acme/core/shapes.clj#circle")).toBe(true);
    expect(has("app/src/acme/app/main.clj#run", "core/src/acme/core/util.cljc#clamp")).toBe(true);
    expect(has("app/src/acme/app/main.clj#-main", "app/src/acme/app/main.clj#run")).toBe(true);
    expect(has("app/src/acme/app/main.clj#run", "app/src/acme/app/report.clj#print-report", "low")).toBe(
      true,
    );
  });

  it("goes to a protocol's method, a record's constructor and a defmethod's multimethod", () => {
    expect(has("app/src/acme/app/main.clj#run", "core/src/acme/core/shapes.clj#Shape.area")).toBe(true);
    expect(
      has("app/src/acme/app/report.clj#print-report", "core/src/acme/core/shapes.clj#Shape.describe"),
    ).toBe(true);
    expect(has("core/src/acme/core/shapes.clj#circle", "core/src/acme/core/shapes.clj#->Circle")).toBe(true);
    expect(has("core/src/acme/core/shapes.clj#scale.Circle", "core/src/acme/core/shapes.clj#scale")).toBe(
      true,
    );
    expect(has("core/src/acme/core/shapes.clj#Circle", "core/src/acme/core/util.cljc#square")).toBe(true);
  });

  it("links a form made by a defining macro of the repo to the macro", () => {
    expect(has("app/src/acme/app/main.clj#on-ping", "core/src/acme/core/macros.clj#defhandler")).toBe(true);
  });

  it("gives no edge through a local of the same name, and none for a call of the caller itself", () => {
    expect(edges.some((e) => e.src === "core/src/acme/core/util.cljc#round-to")).toBe(false);
  });

  it("resolves ClojureScript code to a .cljc namespace, and a test to the code it tests", () => {
    expect(has("ui/src/acme/ui/view.cljs#label", "core/src/acme/core/util.cljc#round-to")).toBe(true);
    expect(has("app/test/acme/app/main_test.clj#run-gives-an-area", "app/src/acme/app/main.clj#run")).toBe(
      true,
    );
  });

  it("skips target folders", () => {
    expect(edges.some((e) => e.src.includes("/target/"))).toBe(false);
  });
});

describe("clojure call edges, case by case", () => {
  it("lets every binding form hide a var: let, fn, destructuring, letfn, catch, as->, #() and method bodies", async () => {
    const e = await edgesOfFiles({
      "deps.edn": "{}",
      "src/a.clj": [
        "(ns a)",
        "(defn x [] 1) (defn y [] 2) (defn k [] 3) (defn e [] 4) (defn t [] 5) (defn m [] 6)",
        "(defn uses []",
        "  (let [{:keys [x] :as m} {}] (x m))",
        "  (fn [y] (y))",
        "  (letfn [(k [] (k))] (k))",
        "  (try 1 (catch Exception e (e)))",
        "  (as-> 1 t (t))",
        "  (for [y [1] :let [k y]] (k))",
        "  #(% (x)))",
        "(defrecord R [e] P (m [this] (e) (t)))",
      ].join("\n"),
    });
    expect(pairs(e)).toEqual(["src/a.clj#R -> src/a.clj#t high", "src/a.clj#uses -> src/a.clj#x high"]);
  });

  it("walks the defaults of a destructuring as code, and a constructor call `R.` as the record", async () => {
    const e = await edgesOfFiles({
      "deps.edn": "{}",
      "src/a.clj": [
        "(ns a)",
        "(defn fallback [] 0)",
        "(defrecord R [v])",
        "(defn f [{:keys [a] :or {a (fallback)}}] (R. a))",
      ].join("\n"),
    });
    expect(pairs(e)).toEqual(["src/a.clj#f -> src/a.clj#R high", "src/a.clj#f -> src/a.clj#fallback high"]);
  });

  it("gives no edge for a name two namespaces referred whole both define, nor for a namespace outside the repo", async () => {
    const e = await edgesOfFiles({
      "deps.edn": "{}",
      "src/b.clj": "(ns b)\n(defn same [] 1)",
      "src/c.clj": "(ns c)\n(defn same [] 2)",
      "src/a.clj":
        "(ns a (:require [b :refer :all] [c :refer :all] [clojure.string :as str]))\n(defn f [] (same) (str/join []))",
    });
    expect(pairs(e)).toEqual([]);
  });

  it("keeps a .clj and a .cljs namespace of one name apart, and lets ClojureScript use a .clj macro", async () => {
    const e = await edgesOfFiles({
      "deps.edn": "{}",
      "src/u.clj": "(ns u)\n(defn now [] 1)\n(defmacro with-x [& b] `(do ~@b))",
      "src/u.cljs": "(ns u)\n(defn now [] 2)",
      "src/a.cljs": "(ns a (:require [u :as u] [u :refer-macros [with-x]]))\n(defn f [] (with-x (u/now)))",
      "src/b.clj": "(ns b (:require [u :as u]))\n(defn g [] (u/now))",
    });
    expect(pairs(e)).toEqual([
      "src/a.cljs#f -> src/u.clj#with-x high",
      "src/a.cljs#f -> src/u.cljs#now high",
      "src/b.clj#g -> src/u.clj#now high",
    ]);
  });

  it("resolves a fully qualified name and a var passed as a value, and nothing in a quoted form", async () => {
    const e = await edgesOfFiles({
      "deps.edn": "{}",
      "src/b/core.clj": "(ns b.core)\n(defn h [x] x)\n(defn q [] 1)",
      "src/a.clj": "(ns a (:require b.core))\n(defn f [xs] (map b.core/h xs) '(b.core/q))",
    });
    expect(pairs(e)).toEqual(["src/a.clj#f -> src/b/core.clj#h high"]);
  });
});

describe("clojure resolver", () => {
  it("names the var a symbol or a call at a source range refers to", async () => {
    const files = {
      "deps.edn": "{}",
      "src/b.clj": "(ns b)\n(defn h [x] x)",
      "src/a.clj": "(ns a (:require [b :as bb]))\n(defn f [x] (bb/h x))",
    };
    const fx = await materializeFiles(files);
    cleanups.push(() => fx.cleanup());
    const parsed = new Map<string, ParsedFile>();
    for (const [p, src] of Object.entries(files))
      if (p.endsWith(".clj")) parsed.set(fileId("repo", p), parseClojure("repo", p, src));
    const workspaces = detectClojureWorkspaces(fx.dir, { workspaces: { overrides: {} } }, "repo");
    const r = createClojureResolver({ root: fx.dir, repo: "repo", workspaces, parsed });
    const src = files["src/a.clj"];
    const call = src.indexOf("(bb/h x)");
    expect(r.targetAt?.(fileId("repo", "src/a.clj"), call, call + "(bb/h x)".length)).toBe(
      "sym:repo:src/b.clj#h",
    );
    expect(r.targetAt?.(fileId("repo", "src/a.clj"), call + 1, call + 5)).toBe("sym:repo:src/b.clj#h");
    expect(r.targetAt?.(fileId("repo", "src/a.clj"), call + 6, call + 7)).toBeNull();
  });
});
