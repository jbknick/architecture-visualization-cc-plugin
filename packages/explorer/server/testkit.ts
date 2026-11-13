import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createResolver,
  detectWorkspaces,
  type EdgeRecord,
  type FileRecord,
  type GantryConfig,
  hashSymbol,
  isIndexable,
  openStore,
  type ParsedFile,
  parseSource,
  type Store,
  type SymbolRecord,
} from "@gantry/core";

/** Test helpers: load a fixture repo into a store with the core modules (stand-in until `indexRepo` lands). */
const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const config = { exclude: [] } as unknown as GantryConfig; // isIndexable only reads `exclude`

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

export function fixtureStore(name: string): { store: Store; dir: string } {
  const root = join(fixturesRoot, name);
  const workspaces = detectWorkspaces(root, { workspaces: { overrides: {} } });
  const sources = new Map<string, string>();
  const parsed = new Map<string, ParsedFile>();
  for (const rel of walk(root).sort()) {
    if (!isIndexable(rel, config) || rel.startsWith(".claude/") || rel.includes("/.claude/")) continue;
    const src = readFileSync(join(root, rel), "utf8");
    sources.set(rel, src);
    const pf = parseSource(rel, src);
    parsed.set(pf.fileId, pf);
  }
  const dir = mkdtempSync(join(tmpdir(), "gantry-views-"));
  const store = openStore(join(dir, "gantry.db"));
  store.upsertWorkspaces(workspaces);
  const resolver = createResolver({ root, workspaces, parsed });
  const wsEdges = resolver.workspaceEdges();
  let first = true;
  for (const [fileId, pf] of [...parsed].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const rel = fileId.slice(5);
    const lang = rel.endsWith("x") ? "tsx" : "ts";
    const src = sources.get(rel) as string;
    const symbols: SymbolRecord[] = pf.symbols.map((s) => {
      const range = pf.bodies.get(s.id) ?? { start: 0, end: 0 };
      return { ...s, ...hashSymbol(src, range, lang) };
    });
    const ws = workspaces.filter((w) => w.dir === "." || rel.startsWith(`${w.dir}/`));
    ws.sort((a, b) => b.dir.length - a.dir.length);
    const file: FileRecord = {
      id: fileId,
      path: rel,
      workspaceId: ws[0]?.id ?? null,
      contentHash: `h-${rel}`,
      mtimeMs: 1,
      deleted: false,
    };
    const edges: EdgeRecord[] = resolver.edgesForFile(fileId);
    // depends_on edges belong to package.json files that are not indexed: hang them off the first file.
    if (first) edges.push(...wsEdges.map((e) => ({ ...e, fileId })));
    first = false;
    store.replaceFile("main", file, symbols, edges);
  }
  return { store, dir };
}
