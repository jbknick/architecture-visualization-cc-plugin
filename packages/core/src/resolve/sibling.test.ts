import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { computeImpact } from "../review/impact.js";
import { openStore, type Store } from "../store/index.js";

interface MaterializedMultirepo {
  root: string;
  repos: { web: string; api: string };
  git: (repo: "web" | "api", args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeMultirepo } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeMultirepo: () => Promise<MaterializedMultirepo>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const POSTS = "file:web:src/pages/posts.tsx";
const CONTRACTS = "file:acme/api:packages/contracts/src/index.ts";
const FORMAT_DATE = "sym:acme/api:packages/contracts/src/index.ts#formatDate";

async function setup(): Promise<{ mr: MaterializedMultirepo; web: () => GantryPaths }> {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-sibling-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  // Resolved when asked, so a test can change the workspace file first.
  const web = (): GantryPaths =>
    resolvePaths(mr.repos.web, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  return { mr, web };
}

async function indexed(
  paths: () => GantryPaths,
): Promise<{ store: Store; result: Awaited<ReturnType<typeof indexRepo>> }> {
  const web = paths();
  const result = await indexRepo(web, { layer: "main" });
  const store = openStore(web.dbPath, { repo: web.repo });
  cleanups.push(() => store.close());
  return { store, result };
}

describe("imports of a package a sibling repo publishes", () => {
  it("resolves the import to the sibling's source file and notes the sibling in the evidence", async () => {
    const { web } = await setup();
    const { store } = await indexed(web);
    const imports = store.effectiveEdges({ kind: ["imports"] }).filter((e) => e.src === POSTS);
    expect(imports.map((e) => e.dst).sort()).toEqual(["ext:react", CONTRACTS]);
    const edge = imports.find((e) => e.dst === CONTRACTS);
    expect(edge?.confidence).toBe("high");
    expect(edge?.evidence).toEqual(["src/pages/posts.tsx:1", "sibling:acme/api"]);
    // An import inside one repo carries no such note.
    expect(imports.find((e) => e.dst === "ext:react")?.evidence.some((x) => x.startsWith("sibling:"))).toBe(
      false,
    );
  });

  it("links the call of formatDate to the function in the other repo", async () => {
    const { web } = await setup();
    const { store } = await indexed(web);
    const calls = store.effectiveEdges({ kind: ["calls"] }).filter((e) => e.dst === FORMAT_DATE);
    const fromWeb = calls.filter((e) => e.src.startsWith("sym:web:"));
    expect(fromWeb.map((e) => e.src)).toEqual(["sym:web:src/pages/posts.tsx#PostsPage"]);
    expect(fromWeb[0]?.confidence).toBe("high");
    expect(fromWeb[0]?.evidence.at(-1)).toBe("sibling:acme/api");
    // A call inside the other repo carries no such note.
    expect(
      calls.find((e) => e.src.startsWith("sym:acme/api:"))?.evidence.some((x) => x.startsWith("sibling:")),
    ).toBe(false);
  });

  it("lists the component in the other repo as a direct consumer of formatDate", async () => {
    const { web } = await setup();
    const { store } = await indexed(web);
    const side = {
      id: FORMAT_DATE,
      path: "packages/contracts/src/index.ts",
      line: 1,
      signature: "formatDate(iso: string): string",
      exactHash: "x",
      kind: "function" as const,
      exported: true,
      complexity: 1,
    };
    const impact = computeImpact(store, [
      {
        id: FORMAT_DATE,
        kind: "modified",
        before: side,
        after: side,
        signatureChanged: false,
        exportedChanged: false,
        locDelta: 1,
      },
    ]);
    const direct = impact.consumers.find((c) => c.id === FORMAT_DATE)?.direct ?? [];
    expect(direct.map((d) => d.id)).toContain("sym:web:src/pages/posts.tsx#PostsPage");
  });

  it("counts a package no repo publishes as external, as before", async () => {
    const { web } = await setup();
    const { store, result } = await indexed(web);
    expect(
      store.effectiveEdges({ kind: ["imports"] }).some((e) => e.src === POSTS && e.dst === "ext:react"),
    ).toBe(true);
    expect(result.specifierCounts.ambiguous).toBe(0);
    expect(result.unresolved.some((u) => u.specifier === "@mr/contracts")).toBe(false);
  });

  it("leaves a package that two other repos publish ambiguous, with both candidates", async () => {
    const { mr, web } = await setup();
    const third = join(mr.root, "third");
    mkdirSync(join(third, "src"), { recursive: true });
    writeFileSync(
      join(third, "package.json"),
      JSON.stringify({ name: "@mr/contracts", version: "2.0.0", exports: { ".": "./src/index.ts" } }),
    );
    writeFileSync(
      join(third, "src/index.ts"),
      "export function formatDate(iso: string): string {\n  return iso;\n}\n",
    );
    writeFileSync(
      join(mr.root, "gantry-workspace.json"),
      JSON.stringify({
        repos: [{ path: "./web" }, { path: "./api", repo: "acme/api" }, { path: "./third", repo: "third" }],
      }),
    );
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.name", "t"],
      ["config", "user.email", "t@example.invalid"],
      ["config", "commit.gpgsign", "false"],
      ["add", "-A", "-f"],
      ["commit", "-q", "-m", "third"],
    ]) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", args, { cwd: third, stdio: "ignore" });
    }
    const { store, result } = await indexed(web);
    expect(
      store
        .effectiveEdges({ kind: ["imports"] })
        .filter((e) => e.src === POSTS)
        .map((e) => e.dst),
    ).toEqual(["ext:react"]);
    expect(
      store
        .effectiveEdges({ kind: ["calls"] })
        .filter((e) => e.src.startsWith("sym:web:src/pages/posts.tsx")),
    ).toEqual([]);
    expect(result.specifierCounts.ambiguous).toBe(1);
    expect(result.unresolved.find((u) => u.specifier === "@mr/contracts")).toEqual({
      specifier: "@mr/contracts",
      from: "src/pages/posts.tsx",
      candidates: ["ws:acme/api:@mr/contracts", "ws:third:."],
    });
  });
});
