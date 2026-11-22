import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import type { SymbolRecord } from "../types.js";
import { adviseReuse } from "./index.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
interface MaterializedMultirepo {
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

async function setup(): Promise<Store> {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-advice-mr-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const web = resolvePaths(mr.repos.web, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(web, { layer: "main" });
  const store = openStore(web.dbPath, { repo: web.repo });
  cleanups.push(() => store.close());
  return store;
}

const sym = (store: Store, id: string): SymbolRecord => {
  const s = store.getSymbol(id);
  if (!s) throw new Error(`no symbol ${id}`);
  return s;
};

describe("(7) a match in another repo of the workspace", () => {
  it("says where the code is and offers no import, move or export", async () => {
    const store = await setup();
    const advice = adviseReuse(
      store,
      "src/lib/slug.ts",
      sym(store, "sym:acme/api:apps/server/src/slug.ts#toSlug"),
    );
    expect(advice).toEqual([
      {
        situation: 7,
        action:
          "It is in the acme/api repo: reuse it through a package that repo publishes, or move it to one",
        inline: false,
      },
    ]);
  });

  it("works from the other side too", async () => {
    const store = await setup();
    const advice = adviseReuse(
      store,
      "apps/server/src/slug.ts",
      sym(store, "sym:web:src/lib/slug.ts#makeSlug"),
      null,
      undefined,
      "acme/api",
    );
    expect(advice.map((a) => [a.situation, a.action])).toEqual([
      [7, "It is in the web repo: reuse it through a package that repo publishes, or move it to one"],
    ]);
  });

  it("is an import when the match is in a package of that repo that the caller's workspace depends on", async () => {
    const store = await setup();
    const advice = adviseReuse(
      store,
      "src/pages/posts.tsx",
      sym(store, "sym:acme/api:packages/contracts/src/index.ts#formatDate"),
    );
    expect(advice).toEqual([
      {
        situation: 1,
        action: "Import it: import { formatDate } from '@mr/contracts'",
        inline: true,
        importPath: "@mr/contracts",
      },
    ]);
  });

  it("keeps the advice of a match in the caller's own repo as before", async () => {
    const store = await setup();
    const advice = adviseReuse(
      store,
      "apps/server/src/posts.ts",
      sym(store, "sym:acme/api:apps/server/src/slug.ts#toSlug"),
      null,
      undefined,
      "acme/api",
    );
    expect(advice).toEqual([
      {
        situation: 1,
        action: "Import it: import { toSlug } from './slug'",
        inline: true,
        importPath: "./slug",
      },
    ]);
  });
});
