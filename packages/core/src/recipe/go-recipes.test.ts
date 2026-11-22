import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recipeAdapter } from "../adapters/recipe.js";
import { indexRepo } from "../indexer.js";
import { openStore } from "../store/index.js";
import { checkRecipeText, listRecipeNodes, recipeCheckOk } from "./index.js";
import { type Graph, indexGraph, makeRepo, pathsFor } from "./testkit.js";

const helperPath = "../../test/helpers/fixture.js";
interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const cleanups: (() => Promise<void>)[] = [];

import { afterAll } from "vitest";

afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function fixture(name: string): Promise<{ dir: string; graph: Graph; recipe: string }> {
  const fx = await materializeFixture(`go-recipes/${name}`);
  cleanups.push(() => fx.cleanup());
  return {
    dir: fx.dir,
    graph: await indexGraph(fx.dir),
    recipe: readFileSync(join(fx.dir, ".gantry/recipe.json"), "utf8"),
  };
}

const symName = (id: string): string => id.slice(id.indexOf("#") + 1);

/** `LABEL | handler | file` of every endpoint, sorted. */
const endpoints = (g: Graph): string[] =>
  g.nodes
    .filter((n) => n.kind === "endpoint")
    .map((n) => `${n.label} | ${n.data.handler} | ${n.data.file}`)
    .sort();

/** `endpoint label -> handler symbol` of the `handles` edges, sorted. */
const handles = (g: Graph): string[] => {
  const label = new Map(g.nodes.map((n) => [n.id, n.label]));
  return g.edges
    .filter((e) => e.kind === "handles")
    .map((e) => `${label.get(e.src)} -> ${symName(e.dst)}`)
    .sort();
};

describe("Go recipes: net/http ServeMux", () => {
  it("makes the endpoints of the registrations, with the method read from the pattern", async () => {
    const { graph } = await fixture("nethttp");
    expect(endpoints(graph)).toEqual([
      "ALL / | index | main.go",
      "DELETE /users/{id} | http.HandlerFunc | users.go",
      "GET /health | health | main.go",
      "GET /legacy | health | users.go",
      "GET /users/{id} | h.get | users.go",
      "POST /users | h.create | users.go",
    ]);
    // A host pattern (`shop.example.com/`) is left out by the rule's constraint, not by the engine.
    expect(graph.nodes.some((n) => n.label.includes("shop.example.com"))).toBe(false);
    expect(handles(graph)).toEqual([
      "ALL / -> index",
      "GET /health -> health",
      "GET /legacy -> health",
      "GET /users/{id} -> usersHandler.get",
      "POST /users -> usersHandler.create",
    ]);
  });
});

describe("Go recipes: chi with a mounted sub-router", () => {
  it("joins the prefixes of Mount, Route and a router that a function or a method returns", async () => {
    const { graph } = await fixture("chi");
    expect(endpoints(graph)).toEqual([
      "ALL /static/* | http.NotFoundHandler | main.go",
      "GET /api/items | listItems | api.go",
      "GET /api/items/{itemID} | getItem | api.go",
      "GET /api/users/{id} | a.get | users.go",
      "GET /me | me | main.go",
      "GET /ping | ping | main.go",
      "POST /api/items | createItem | api.go",
      "POST /api/users | a.create | users.go",
    ]);
    expect(handles(graph)).toContain("GET /api/users/{id} -> UserAPI.get");
    expect(handles(graph)).toContain("POST /api/items -> createItem");
  });

  it("makes middleware nodes that serve the endpoints below the router they are used on", async () => {
    const { graph } = await fixture("chi");
    const mw = graph.nodes.filter((n) => n.kind === "middleware").map((n) => n.label);
    expect(mw.sort()).toEqual(["middleware.Logger /*", "requireLogin /*"]);
    const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const served = graph.edges
      .filter((e) => e.kind === "serves" && label.get(e.src) === "requireLogin /*")
      .map((e) => label.get(e.dst));
    expect(served).toEqual(["GET /me"]);
  });
});

describe("Go recipes: gin with a group", () => {
  it("builds the path from Group calls and a router passed into a function", async () => {
    const { graph } = await fixture("gin");
    expect(endpoints(graph)).toEqual([
      "DELETE /api/users/:id | remove | users/routes.go",
      "GET /api/me | me | main.go",
      "GET /api/users | list | users/routes.go",
      "GET /api/users/:id | get | users/routes.go",
      "GET /ping | inline | main.go",
      "POST /api/users | create | users/routes.go",
    ]);
    expect(handles(graph)).toContain("DELETE /api/users/:id -> remove");
  });
});

describe("Go recipes: raw SQL, a typed value and query files", () => {
  it("declares tables from migrations and rules, and attributes reads and writes to the Go function", async () => {
    const { graph } = await fixture("sql");
    const tables = graph.nodes.filter((n) => n.kind === "table");
    expect(tables.map((n) => n.label).sort()).toEqual(["Audit", "posts", "users", "{table}"]);
    expect(tables.find((n) => n.label === "{table}")?.data.reason).toBe("table name is a function parameter");
    const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const access = graph.edges
      .filter((e) => e.kind === "reads" || e.kind === "writes")
      .map((e) => `${e.kind} ${symName(e.src)} ${label.get(e.dst)} ${e.confidence}`)
      .sort();
    expect(access).toEqual(
      [
        "reads Queries.ListAuthorPosts posts high",
        "reads Queries.ListAuthorPosts users high",
        "reads Queries.ListPosts posts high",
        "reads RecentAudits Audit high",
        "reads CountRows {table} low",
        "reads ListUsers users high",
        "reads PostsByUser posts high",
        "reads PostsByUser users high",
        "writes CreatePost posts high",
        "writes DeleteUser users high",
        "writes LogAudit Audit high",
        "writes Queries.PublishPost posts high",
      ].sort(),
    );
  });

  it("shows a read or write written in a query file at that file, on the line of the table", async () => {
    const { graph } = await fixture("sql");
    const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const queried = graph.edges
      .filter((e) => (e.kind === "reads" || e.kind === "writes") && symName(e.src).startsWith("Queries."))
      .map((e) => {
        expect(e.fileId.endsWith(":db/gen/posts.sql.go")).toBe(true);
        return `${e.kind} ${symName(e.src)} ${label.get(e.dst)} ${e.evidence.join(",")}`;
      })
      .sort();
    expect(queried).toEqual([
      "reads Queries.ListAuthorPosts posts db/queries/posts.sql:10",
      "reads Queries.ListAuthorPosts users db/queries/posts.sql:11",
      "reads Queries.ListPosts posts db/queries/posts.sql:2",
      "writes Queries.PublishPost posts db/queries/posts.sql:6",
    ]);
  });
});

describe("gantry recipe check on the Go fixtures", () => {
  for (const name of ["nethttp", "chi", "gin", "sql"]) {
    it(`${name}: every rule is valid, its examples pass, and --nodes lists the nodes the index stores`, async () => {
      const { dir, graph, recipe } = await fixture(name);
      const paths = pathsFor(dir);
      const check = checkRecipeText(paths, recipe);
      expect(check.errors).toEqual([]);
      expect(check.rules.filter((r) => !r.valid || r.examples.failed.length > 0)).toEqual([]);
      expect(recipeCheckOk(check)).toBe(true);
      // Every rule finds something in its own fixture (a zero would be a warning).
      expect(check.rules.filter((r) => r.matches === 0).map((r) => r.id)).toEqual([]);

      const nodes = await listRecipeNodes(paths, recipe, { limit: 1000 });
      const count = (kind: string): number => graph.nodes.filter((n) => n.kind === kind).length;
      const byLabel = (xs: { label: string }[]): string[] => xs.map((x) => x.label).sort();
      for (const kind of ["table", "middleware"] as const)
        expect(byLabel(nodes.entries.filter((e) => e.kind === kind))).toEqual(
          byLabel(graph.nodes.filter((n) => n.kind === kind)),
        );
      const nodeLabel = new Map(graph.nodes.map((n) => [n.id, n.label]));
      const accessOf = (edge: string): string[] =>
        graph.edges
          .filter((e) => e.kind === edge)
          .map((e) => `${nodeLabel.get(e.dst)} ${symName(e.src)}`)
          .sort();
      for (const [kind, edge] of [
        ["read", "reads"],
        ["write", "writes"],
      ] as const)
        expect(
          nodes.entries
            .filter((e) => e.kind === kind)
            .map((e) => `${e.label} ${e.in}`)
            .sort(),
        ).toEqual(accessOf(edge));
      expect(nodes.totals.endpoint).toBe(count("endpoint"));
      expect(nodes.totals.middleware).toBe(count("middleware"));
      expect(nodes.totals.table).toBe(count("table"));
      expect(nodes.totals.read).toBe(graph.edges.filter((e) => e.kind === "reads").length);
      expect(nodes.totals.write).toBe(graph.edges.filter((e) => e.kind === "writes").length);
      expect(
        nodes.entries
          .filter((e) => e.kind === "endpoint")
          .map((e) => e.label)
          .sort(),
      ).toEqual(
        graph.nodes
          .filter((n) => n.kind === "endpoint")
          .map((n) => n.label)
          .sort(),
      );
    });
  }

  it("reports a rule whose pattern cannot match as a failed example", async () => {
    const { dir, recipe } = await fixture("nethttp");
    const broken = JSON.parse(recipe) as { rules: { id: string; examples: { match: string[] } }[] };
    // A one-argument call parses as a conversion unless the pattern gives a context: the example catches it.
    broken.rules.push({
      id: "single-argument",
      language: "go",
      rule: { pattern: "$R.Use($H)" },
      emit: { kind: "middleware", receiver: "$R", handler: "$H" },
      examples: { match: ["mux.Use(logging)"], noMatch: [] },
    } as never);
    const check = checkRecipeText(pathsFor(dir), JSON.stringify(broken));
    const bad = check.rules.find((r) => r.id === "single-argument");
    expect(bad?.examples.failed).toHaveLength(1);
    expect(recipeCheckOk(check)).toBe(false);
  });
});

describe("Go recipes are read from the working tree and the index", () => {
  it("a second index run gives the same nodes", async () => {
    const { dir, graph } = await fixture("chi");
    const paths = pathsFor(dir);
    await indexRepo(paths, { layer: "main", adapters: [recipeAdapter] });
    const store = openStore(paths.dbPath);
    try {
      const again = store.effectiveAdapterNodes().filter((n) => n.kind === "endpoint");
      expect(again.map((n) => n.label).sort()).toEqual(
        graph.nodes
          .filter((n) => n.kind === "endpoint")
          .map((n) => n.label)
          .sort(),
      );
    } finally {
      store.close();
    }
  });
});

describe("uncalled: a function that takes a router and is called nowhere", () => {
  const recipeFor = (uncalled: boolean): string =>
    JSON.stringify({
      version: 1,
      dependencies: [],
      helpers: ["resolve-names", "const-strings", "mount-graph", "param-flow"],
      rules: [
        {
          id: "mux",
          language: "go",
          rule: { pattern: "http.NewServeMux()" },
          emit: { kind: "router" },
          examples: { match: ["m := http.NewServeMux()"], noMatch: [] },
        },
        {
          id: "handle",
          language: "go",
          ...(uncalled ? { uncalled: true } : {}),
          rule: { pattern: "$R.HandleFunc($P, $H)" },
          emit: { kind: "endpoint", receiver: "$R", methodInPath: true, path: "$P", handler: "$H" },
          examples: { match: ['m.HandleFunc("GET /a", h)'], noMatch: [] },
        },
      ],
    });
  const files = (recipe: string): Record<string, string> => ({
    "go.mod": "module example.com/dead\n\ngo 1.22\n",
    "main.go": `package main

import "net/http"

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /live", live)
	used(mux)
	var s server
	s.unresolved(mux)
}

func live(w http.ResponseWriter, r *http.Request) {}

func used(m *http.ServeMux) { m.HandleFunc("GET /used", live) }

func neverCalled(m *http.ServeMux) { m.HandleFunc("GET /dead", live) }

func onlyTested(m *http.ServeMux) { m.HandleFunc("GET /tested", live) }

type server struct{}

func (s server) unresolved(m *http.ServeMux) {}
`,
    "main_test.go": 'package main\n\nimport "net/http"\n\nfunc init() { onlyTested(http.NewServeMux()) }\n',
    "other.go": `package main

import "net/http"

type other struct{}

// The call below names calledButUnresolved, but its receiver has no known type, so the call resolves to nothing.
func (o other) run(x unknownType, m *http.ServeMux) { x.calledButUnresolved(m) }

func (o other) calledButUnresolved(m *http.ServeMux) { m.HandleFunc("GET /unresolved", live) }
`,
    ".gantry/recipe.json": recipe,
  });
  const labels = async (uncalled: boolean): Promise<string[]> => {
    const repo = await makeRepo(files(recipeFor(uncalled)));
    const g = await indexGraph(repo.dir);
    return g.nodes
      .filter((n) => n.kind === "endpoint")
      .map((n) => n.label)
      .sort();
  };

  it("registers nothing for dead code or a test-only helper by default", async () => {
    expect(await labels(false)).toEqual(["GET /live", "GET /used"]);
  });

  it("with the option on, dead code and a caller outside the read set count as called nowhere", async () => {
    // `calledButUnresolved` is named by a call whose target does not resolve: it registers nothing either way.
    expect(await labels(true)).toEqual(["GET /dead", "GET /live", "GET /tested", "GET /used"]);
  });
});
