import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdapterNodeRecord,
  createResolver,
  detectTanstackRoutes,
  detectWorkspaces,
  type EdgeRecord,
  type FileRecord,
  type GantryConfig,
  hashSymbol,
  isIndexable,
  openStore,
  type ParsedFile,
  parseSource,
  pathOfFileId,
  type Store,
  type SymbolRecord,
  type WorkspaceRecord,
  workspaceId,
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

function workspaceRecordOf(workspaces: WorkspaceRecord[], rel: string): WorkspaceRecord | undefined {
  return workspaces
    .filter((w) => w.dir === "." || rel.startsWith(`${w.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}
const workspaceOf = (workspaces: WorkspaceRecord[], repo: string, rel: string): string =>
  workspaceRecordOf(workspaces, rel)?.id ?? workspaceId(repo, ".");

/** `repo` is the repo name in every id (default: the fixture's name). */
export function fixtureStore(name: string, repo: string = name): { store: Store; dir: string } {
  const root = join(fixturesRoot, name);
  const workspaces = detectWorkspaces(root, { workspaces: { overrides: {} } }, repo);
  const sources = new Map<string, string>();
  const parsed = new Map<string, ParsedFile>();
  for (const rel of walk(root).sort()) {
    if (!isIndexable(rel, config) || rel.startsWith(".claude/") || rel.includes("/.claude/")) continue;
    const src = readFileSync(join(root, rel), "utf8");
    sources.set(rel, src);
    const pf = parseSource(repo, rel, src);
    parsed.set(pf.fileId, pf);
  }
  const dir = mkdtempSync(join(tmpdir(), "gantry-views-"));
  const store = openStore(join(dir, "gantry.db"));
  store.upsertRepo(repo, root);
  store.upsertWorkspaces(workspaces);
  const resolver = createResolver({ root, repo, workspaces, parsed });
  const wsEdges = resolver.workspaceEdges();
  const routes = detectTanstackRoutes({
    root,
    repo,
    workspaces,
    files: [...parsed.keys()].map((id) => ({
      id,
      path: pathOfFileId(id),
      workspaceId: workspaceOf(workspaces, repo, pathOfFileId(id)),
      source: sources.get(pathOfFileId(id)) as string,
    })),
    parsed,
    resolver,
  });
  const routeEdges = new Map<string, EdgeRecord[]>();
  const routeNodes = new Map<string, AdapterNodeRecord[]>();
  for (const e of routes.edges) routeEdges.set(e.fileId, [...(routeEdges.get(e.fileId) ?? []), e]);
  for (const n of routes.nodes) routeNodes.set(n.fileId, [...(routeNodes.get(n.fileId) ?? []), n]);
  let first = true;
  for (const [fileId, pf] of [...parsed].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const rel = pathOfFileId(fileId);
    const src = sources.get(rel) as string;
    const symbols: SymbolRecord[] = pf.symbols.map((s) => {
      const range = pf.bodies.get(s.id) ?? { start: 0, end: 0 };
      return { ...s, lang: "typescript" as const, ...hashSymbol(src, range, rel) };
    });
    const ws = [workspaceRecordOf(workspaces, rel)];
    const file: FileRecord = {
      id: fileId,
      path: rel,
      lang: "typescript",
      workspaceId: ws[0]?.id ?? null,
      contentHash: `h-${rel}`,
      mtimeMs: 1,
      deleted: false,
    };
    const edges: EdgeRecord[] = [...resolver.edgesForFile(fileId), ...(routeEdges.get(fileId) ?? [])];
    // depends_on edges belong to package.json files that are not indexed: hang them off the first file.
    if (first) edges.push(...wsEdges.map((e) => ({ ...e, fileId })));
    first = false;
    store.replaceFile("main", file, symbols, edges, routeNodes.get(fileId) ?? []);
  }
  return { store, dir };
}
