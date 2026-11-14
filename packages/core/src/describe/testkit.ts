import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import type { EdgeRecord, FileRecord, SymbolRecord } from "../types.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

export interface Indexed {
  fx: MaterializedFixture;
  paths: GantryPaths;
  store: Store;
  close(): Promise<void>;
}

const dataDirs: string[] = [];
export function cleanupData(): void {
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Materialises a fixture (optionally overriding/adding files), indexes it into a fresh store. */
export async function indexedFixture(
  name: "pnpm-turbo" | "single-pkg" | "nx" = "pnpm-turbo",
  files: Record<string, string> = {},
): Promise<Indexed> {
  const fx = await materializeFixture(name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fx.dir, rel)), { recursive: true });
    writeFileSync(join(fx.dir, rel), text);
  }
  const data = mkdtempSync(join(tmpdir(), "gantry-describe-data-"));
  dataDirs.push(data);
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  return {
    fx,
    paths,
    store,
    async close() {
      store.close();
      await fx.cleanup();
    },
  };
}

/** A hand-made function-like symbol record for stores that are not built from source. */
export function fakeSymbol(path: string, name: string, over: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: `sym:${path}#${name}`,
    fileId: `file:${path}`,
    name,
    kind: "function",
    exported: true,
    signature: "()",
    startLine: 1,
    endLine: 1,
    loc: 1,
    complexity: 1,
    stmtCount: 2,
    exactHash: `h-${path}-${name}`,
    shapeHash: "s",
    minhash: new Uint32Array(64),
    ...over,
  };
}

export function putFile(store: Store, path: string, symbols: SymbolRecord[], edges: EdgeRecord[] = []): void {
  const file: FileRecord = {
    id: `file:${path}`,
    path,
    workspaceId: null,
    contentHash: "c",
    mtimeMs: 1,
    deleted: false,
  };
  store.replaceFile("main", file, symbols, edges);
}
