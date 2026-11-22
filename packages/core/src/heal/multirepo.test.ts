import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildSimilarEdges } from "../dup/index.js";
import { indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { ftsSearch } from "../search/fts.js";
import { openStore, type Store } from "../store/index.js";
import { heal, refreshWorking } from "./index.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
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

async function setup() {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-heal-mr-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const env = { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  const web = resolvePaths(mr.repos.web, env);
  const api = resolvePaths(mr.repos.api, env);
  await indexRepo(web, { layer: "main" });
  const store = openStore(web.dbPath, { repo: web.repo });
  try {
    await rebuildSimilarEdges(store);
  } finally {
    store.close();
  }
  return { mr, web, api };
}

/** sha256 of one repo's files, symbols and edges rows, each ordered by id (edges by their key). */
function repoRows(store: Store, repo: string): string {
  const prefix = `${repo}:`;
  const h = createHash("sha256");
  const rows = [
    store.db.prepare("SELECT * FROM files WHERE repo = ? ORDER BY id, layer").all(repo),
    store.db
      .prepare("SELECT * FROM symbols WHERE substr(id, 1, ?) = ? ORDER BY id, layer")
      .all(`sym:${prefix}`.length, `sym:${prefix}`),
    store.db
      .prepare("SELECT * FROM edges WHERE substr(file_id, 1, ?) = ? ORDER BY src, dst, kind, layer")
      .all(`file:${prefix}`.length, `file:${prefix}`),
  ];
  h.update(JSON.stringify(rows));
  return h.digest("hex");
}

function hashes(paths: ReturnType<typeof resolvePaths>) {
  const store = openStore(paths.dbPath, { repo: paths.repo });
  try {
    return { api: repoRows(store, "acme/api"), web: repoRows(store, "web") };
  } finally {
    store.close();
  }
}

function headSha(paths: ReturnType<typeof resolvePaths>, repo: string): string | undefined {
  const store = openStore(paths.dbPath, { repo: paths.repo });
  try {
    return store.headSha(repo);
  } finally {
    store.close();
  }
}

describe("heal in a workspace", () => {
  it("a checkout of a new commit in web updates web's rows and leaves acme/api's byte-identical", async () => {
    const { mr, web } = await setup();
    const before = hashes(web);
    mr.git("web", ["checkout", "-q", "-b", "feature"]);
    appendFileSync(
      join(mr.repos.web, "src/lib/only-in-web.ts"),
      "export function addedInWeb(): number {\n  return 7;\n}\n",
    );
    mr.git("web", ["add", "-A"]);
    mr.git("web", ["commit", "-q", "-m", "more"]);

    const r = await heal(web, { repo: "web" });
    expect(r.changed).toBeGreaterThan(0);
    const after = hashes(web);
    expect(after.api).toBe(before.api);
    expect(after.web).not.toBe(before.web);
    expect(headSha(web, "web")).toBe(mr.git("web", ["rev-parse", "HEAD"]).trim());

    const store = openStore(web.dbPath, { repo: web.repo });
    try {
      expect(ftsSearch(store, "addedInWeb")[0]).toMatchObject({ name: "addedInWeb", repo: "web" });
    } finally {
      store.close();
    }
  });

  it("a heal with no repo heals each repo in turn, each to its own HEAD", async () => {
    const { mr, web } = await setup();
    for (const repo of ["web", "api"] as const) {
      mr.git(repo, ["checkout", "-q", "-b", "feature"]);
      const file = repo === "web" ? "src/lib/only-in-web.ts" : "apps/server/src/retry.ts";
      appendFileSync(join(mr.repos[repo], file), `\nexport const marker_${repo} = 1;\n`);
      mr.git(repo, ["commit", "-q", "-am", "marker"]);
    }
    await heal(web);
    expect(headSha(web, "web")).toBe(mr.git("web", ["rev-parse", "HEAD"]).trim());
    expect(headSha(web, "acme/api")).toBe(mr.git("api", ["rev-parse", "HEAD"]).trim());
  });

  it("an uncommitted edit in api is searchable from web after a working refresh, with web's rows unchanged", async () => {
    const { mr, web } = await setup();
    const before = hashes(web);
    appendFileSync(
      join(mr.repos.api, "apps/server/src/retry.ts"),
      "\nexport function pickJitter(): number {\n  return 1;\n}\n",
    );
    await refreshWorking(web);
    const store = openStore(web.dbPath, { repo: web.repo });
    try {
      expect(ftsSearch(store, "pickJitter")[0]).toMatchObject({ name: "pickJitter", repo: "acme/api" });
    } finally {
      store.close();
    }
    const after = hashes(web);
    expect(after.web).toBe(before.web);
    expect(after.api).not.toBe(before.api);
  });

  it("a repo that is not in the workspace is refused", async () => {
    const { web } = await setup();
    await expect(heal(web, { repo: "nope" })).rejects.toThrow(/no repo named nope/);
  });
});
