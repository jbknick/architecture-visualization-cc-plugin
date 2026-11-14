import { posix } from "node:path";
import type { GantryConfig } from "../config/index.js";
import { USE_CLIENT_EVIDENCE } from "../resolve/index.js";
import type { Store } from "../store/index.js";
import type { Description, SymbolRecord, WorkspaceRecord } from "../types.js";
import { workspaceForPath } from "../workspace/index.js";
import { cmp, entryPoints, normPath, packageJsonPath, SCRIPT_EXTS, targetCandidates } from "./util.js";

/**
 * Reuse advice (spec section 18). Pure, synchronous and store-based: reads the index only (no model,
 * no network, no disk) and returns the same answer for the same store contents.
 *
 *   adviseReuse(store: Store, callerPath: string, match: SymbolRecord,
 *               description?: Description | null, config?: GantryConfig): Advice[]
 *   importPathFor(ws: WorkspaceRecord, match: SymbolRecord, store?: Store): string | null
 *
 *   interface Advice { situation: 1 | 2 | 3 | 4 | 5 | 6; action: string; inline: boolean; importPath?: string }
 *
 * `callerPath` is repo-relative (posix); the caller need not be indexed. The result is ordered: the
 * primary advice (situation 1, 2, 3 or 4) first, then the rename suggestion (5) when it applies. It is
 * empty when the match is in the caller's own file. `inline: true` is only set for situation 1 (import
 * it) and 6 (see `checkImports`); everything else belongs in the suggestions list.
 *
 * importPathFor: `<pkg name><subpath without leading .>` of the first exports-map entry (the package
 * entry points when there is no map: `types`, `main`, `src/index`) whose file exports the match, directly
 * or through re-exports (read from the stored `exports` edges); null if no entry reaches it. Without
 * `store` only a direct export from the entry file is recognised.
 */
export interface Advice {
  situation: 1 | 2 | 3 | 4 | 5 | 6;
  action: string;
  inline: boolean;
  importPath?: string;
}

interface Reach {
  /** Import path, e.g. `@acme/ui/button`. */
  path: string;
  /** File whose `exports` expose the symbol (the entry file, or the matched file for a wildcard entry). */
  entryFileId: string;
}

/** The symbol an import statement names: methods are reached through their class. */
function importable(match: SymbolRecord): { id: string; name: string; isDefault: boolean } {
  const dot = match.name.indexOf(".");
  if (match.kind === "method" && dot > 0) {
    const name = match.name.slice(0, dot);
    return { id: `${match.fileId.replace(/^file:/, "sym:")}#${name}`, name, isDefault: false };
  }
  return { id: match.id, name: match.name, isDefault: match.id.endsWith("#default") };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rank(subpath: string): number {
  return subpath === "." ? 0 : subpath.includes("*") ? 2 : 1;
}

function reach(ws: WorkspaceRecord, match: SymbolRecord, store?: Store): Reach | null {
  const sym = importable(match);
  const matchRel = match.fileId.replace(/^file:/, "");
  const exportsIt = (fileId: string): boolean =>
    store
      ? store.effectiveEdges({ src: fileId, kind: ["exports"] }).some((e) => e.dst === sym.id)
      : fileId === match.fileId && match.exported;
  const entries = [...entryPoints(ws)].sort(
    (a, b) =>
      rank(a.subpath) - rank(b.subpath) || a.subpath.length - b.subpath.length || cmp(a.subpath, b.subpath),
  );
  const done = new Set<string>();
  for (const entry of entries) {
    const base = ws.dir === "." ? "" : ws.dir;
    if (entry.target.includes("*") && entry.subpath.includes("*")) {
      // Wildcard entry: the matched file itself is the module behind `./sub/*`.
      const pattern = new RegExp(
        `^${escapeRe(normPath(posix.join(base, entry.target))).replace("\\*", "(.*)")}$`,
      );
      const stem = matchRel.replace(/\.[cm]?[jt]sx?$/, "");
      const variants = [matchRel, stem, ...SCRIPT_EXTS.map((e) => stem + e)];
      for (const v of variants) {
        const m = pattern.exec(v);
        if (!m || m[1] === undefined) continue;
        if (!exportsIt(match.fileId)) break;
        return { path: ws.name + entry.subpath.slice(1).replace("*", m[1]), entryFileId: match.fileId };
      }
      continue;
    }
    for (const cand of targetCandidates(ws, entry.target)) {
      const fileId = `file:${cand}`;
      if (done.has(fileId + entry.subpath)) continue;
      done.add(fileId + entry.subpath);
      const present = store
        ? store.effectiveEdges({ src: fileId, kind: ["exports"] }).length > 0
        : cand === matchRel;
      if (!present) continue;
      if (exportsIt(fileId)) return { path: ws.name + entry.subpath.slice(1), entryFileId: fileId };
      break; // The entry file exists and does not expose the symbol.
    }
  }
  return null;
}

export function importPathFor(ws: WorkspaceRecord, match: SymbolRecord, store?: Store): string | null {
  return reach(ws, match, store)?.path ?? null;
}

function isClientFile(store: Store, fileId: string): boolean {
  return store
    .effectiveEdges({ src: fileId, dst: fileId, kind: ["imports"] })
    .some((e) => e.evidence.includes(USE_CLIENT_EVIDENCE));
}

function isServerOnlyFile(store: Store, fileId: string): boolean {
  if (/\.server\.[cm]?[jt]sx?$/.test(fileId)) return true;
  return store.effectiveEdges({ src: fileId, dst: "ext:server-only", kind: ["imports"] }).length > 0;
}

/** Every workspace id reachable from `from` through `depends_on` edges. */
function dependsOnClosure(store: Store, from: string): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of store.effectiveEdges({ kind: ["depends_on"] })) {
    const a = next.get(e.src) ?? [];
    a.push(e.dst);
    next.set(e.src, a);
  }
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const n of next.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen;
}

function relativeImport(callerPath: string, matchPath: string): string {
  const rel = posix.relative(posix.dirname(callerPath), matchPath).replace(/\.[cm]?[jt]sx?$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function importLine(match: SymbolRecord, from: string): string {
  const sym = importable(match);
  const type = match.kind === "type" || match.kind === "interface";
  const binding = sym.isDefault ? sym.name : `{ ${sym.name} }`;
  return `import ${type ? "type " : ""}${binding} from '${from}'`;
}

export function adviseReuse(
  store: Store,
  callerPath: string,
  match: SymbolRecord,
  description?: Description | null,
  config?: GantryConfig,
): Advice[] {
  const out: Advice[] = [];
  const caller = normPath(callerPath);
  const matchRel = match.fileId.replace(/^file:/, "");
  if (matchRel !== caller) {
    const all = store.listWorkspaces();
    const callerWs = all.length > 0 ? workspaceForPath(all, caller) : undefined;
    const matchWs = all.length > 0 ? workspaceForPath(all, matchRel) : undefined;
    if (callerWs && matchWs) out.push(...primary(store, all, caller, callerWs, match, matchRel, matchWs));
  }
  if (config?.renameSuggestions === true && description?.nameFits === false && description.suggestedName) {
    out.push({
      situation: 5,
      action: `Consider renaming ${match.name} to ${description.suggestedName}`,
      inline: false,
    });
  }
  return out;
}

function primary(
  store: Store,
  all: WorkspaceRecord[],
  caller: string,
  callerWs: WorkspaceRecord,
  match: SymbolRecord,
  matchRel: string,
  matchWs: WorkspaceRecord,
): Advice[] {
  const sym = importable(match);
  // Same workspace: a relative import, if the file exposes the symbol.
  if (callerWs.id === matchWs.id) {
    if (match.exported || sym.id !== match.id) {
      const path = relativeImport(caller, matchRel);
      return [
        { situation: 1, action: `Import it: ${importLine(match, path)}`, inline: true, importPath: path },
      ];
    }
    return [{ situation: 3, action: `Export it from ${matchRel}, then import it`, inline: false }];
  }
  // Another app: apps are not importable.
  if (matchWs.kind === "app") {
    return [
      {
        situation: 4,
        action: `Move it to a shared package (it lives in app ${matchWs.name})`,
        inline: false,
      },
    ];
  }
  const r = reach(matchWs, match, store);
  if (!r) {
    return [
      {
        situation: 3,
        action: `Export it from ${matchWs.name} (add to exports map) or move it to a shared package`,
        inline: false,
      },
    ];
  }
  const dependent =
    callerWs.deps.includes(matchWs.name) ||
    (all.find((w) => w.dir === ".")?.deps.includes(matchWs.name) ?? false);
  if (dependent) {
    return [
      { situation: 1, action: `Import it: ${importLine(match, r.path)}`, inline: true, importPath: r.path },
    ];
  }
  if (dependsOnClosure(store, matchWs.id).has(callerWs.id)) {
    return [
      {
        situation: 4,
        action: `Move it to a shared package (adding ${matchWs.name} would make a dependency cycle)`,
        inline: false,
      },
    ];
  }
  const callerClient = isClientFile(store, `file:${caller}`);
  const serverOnly = isServerOnlyFile(store, match.fileId) || isServerOnlyFile(store, r.entryFileId);
  if (callerClient && serverOnly) {
    return [
      {
        situation: 4,
        action: "Move it to a shared package (it is server-only, the caller is a client file)",
        inline: false,
      },
    ];
  }
  return [
    {
      situation: 2,
      action: `Add "${matchWs.name}" to ${packageJsonPath(callerWs)}, then import it`,
      inline: false,
      importPath: r.path,
    },
  ];
}
