import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import { findDuplicates, rebuildSimilarEdges } from "./index.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
interface MaterializedMultirepo {
  root: string;
  repos: { web: string; api: string };
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

const MAKE_SLUG = "sym:web:src/lib/slug.ts#makeSlug";
const TO_SLUG = "sym:acme/api:apps/server/src/slug.ts#toSlug";

async function setup(): Promise<{ mr: MaterializedMultirepo; web: GantryPaths }> {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-dup-mr-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const web = resolvePaths(mr.repos.web, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  return { mr, web };
}

describe("duplicates across the repos of a workspace", () => {
  it("finds the copy in the other repo, in both directions", async () => {
    const { web } = await setup();
    await indexRepo(web, { layer: "main" });
    const store = openStore(web.dbPath, { repo: web.repo });
    cleanups.push(() => store.close());
    const fromWeb = await findDuplicates(store, { symbol: store.getSymbol(MAKE_SLUG) });
    expect(fromWeb.map((c) => [c.symbolId, c.tier])).toEqual([[TO_SLUG, "exact"]]);
    const fromApi = await findDuplicates(store, { symbol: store.getSymbol(TO_SLUG) });
    expect(fromApi.map((c) => c.symbolId)).toEqual([MAKE_SLUG]);
    await rebuildSimilarEdges(store, { tiers: ["exact", "near"] });
    const edges = store.effectiveEdges({ kind: ["similar_to"] });
    expect(edges.map((e) => [e.src, e.dst])).toEqual([[TO_SLUG, MAKE_SLUG]]);
  });

  it("never matches a Go function with a TypeScript one, even in another repo", async () => {
    const { mr, web } = await setup();
    mkdirSync(join(mr.repos.api, "apps/goslug"), { recursive: true });
    writeFileSync(join(mr.repos.api, "apps/goslug/go.mod"), "module example.com/goslug\n\ngo 1.22\n");
    writeFileSync(
      join(mr.repos.api, "apps/goslug/slug.go"),
      [
        "package goslug",
        "",
        'import "strings"',
        "",
        "func MakeSlug(input string) string {",
        "\tlower := strings.ToLower(input)",
        "\ttrimmed := strings.TrimSpace(lower)",
        '\tdashed := strings.ReplaceAll(trimmed, " ", "-")',
        '\tclean := strings.ReplaceAll(dashed, "_", "-")',
        '\tcollapsed := strings.ReplaceAll(clean, "--", "-")',
        '\treturn strings.Trim(collapsed, "-")',
        "}",
        "",
      ].join("\n"),
    );
    await indexRepo(web, { layer: "main" });
    const store = openStore(web.dbPath, { repo: web.repo });
    cleanups.push(() => store.close());
    const go = store.getSymbol("sym:acme/api:apps/goslug/slug.go#MakeSlug");
    expect(go?.lang).toBe("go");
    const ids = (await findDuplicates(store, { symbol: store.getSymbol(MAKE_SLUG) })).map((c) => c.symbolId);
    expect(ids).not.toContain(go?.id);
    expect(
      (await findDuplicates(store, { symbol: go })).filter((c) => c.symbolId.includes("slug.ts")),
    ).toEqual([]);
  });
});
