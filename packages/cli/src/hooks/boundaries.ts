import {
  type EdgeKind,
  fileId,
  type Group,
  isFileId,
  isSymId,
  matchAny,
  pathOfFileId,
  readOverlay,
  type SelectableNode,
  type Store,
  type SymbolRecord,
  workspaceForPath,
} from "@gantry/core";
import { type CrossingFinding, cleanGroupName } from "./findings.js";

const SYMBOL_EDGES: EdgeKind[] = ["calls", "renders", "uses_hook"];

/**
 * Crossings of group boundaries added by an edit (spec section 14). A group whose `mayUse` is not null is a
 * boundary. A crossing is an `imports` (file to file), `calls`, `renders` or `uses_hook` edge whose source is a member
 * of a boundary group G and whose target is a member of a group H, with H not G, H not listed in G's `mayUse` and
 * the source not also a member of H. A symbol is a member of a group when it or its file matches a selector.
 * Only edges the main layer does not have are reported: those from `changed` (the batch's new or changed symbols)
 * and, for `imports`, from `files` (repo-relative paths). The overlay is read once, with `readOverlay`; nothing is
 * written. Lines: per source file, import-only crossings (line 0) first, then by source line, then target id.
 * Fails open: an unreadable overlay gives no findings.
 *
 * `opts.groups` replaces the groups read from the overlay (the team call passes the team's groups, read from the
 * team cache). `opts.allEdges: true` keeps the edges the main layer already has (the pull request check, where the
 * index is the head checkout). Without `opts` the behavior is the one above.
 */
export function crossingFindings(
  store: Store,
  changed: SymbolRecord[],
  files: string[],
  opts: { groups?: Group[]; allEdges?: boolean } = {},
): CrossingFinding[] {
  let groups: Group[];
  if (opts.groups !== undefined) groups = opts.groups;
  else {
    try {
      groups = readOverlay(store).groups;
    } catch {
      return [];
    }
  }
  const boundaries = groups.filter((g) => g.mayUse !== null);
  if (boundaries.length === 0) return [];

  const workspaces = store.listWorkspaces();
  const info = new Map<string, { node: SelectableNode[]; sym?: SymbolRecord; path: string } | null>();
  const describe = (id: string) => {
    let v = info.get(id);
    if (v !== undefined) return v;
    v = null;
    if (isSymId(id)) {
      const sym = store.getSymbol(id);
      if (sym) v = { node: [], sym, path: pathOfFileId(sym.fileId) };
    } else if (isFileId(id)) {
      v = { node: [], path: pathOfFileId(id) };
    }
    if (v) {
      const ws = workspaces.length > 0 ? workspaceForPath(workspaces, v.path).id : undefined;
      const base = { ...(ws ? { workspace: ws } : {}), path: v.path };
      v.node = [
        ...(v.sym ? [{ id, kind: v.sym.kind as string, ...base }] : []),
        { id: v.sym ? v.sym.fileId : id, kind: "file", ...base },
      ];
    }
    info.set(id, v);
    return v;
  };
  const memberOf = new Map<string, Set<string>>();
  const groupsOf = (id: string): Set<string> => {
    let s = memberOf.get(id);
    if (s) return s;
    s = new Set();
    const d = describe(id);
    if (d) for (const g of groups) if (d.node.some((n) => matchAny(g.selectors, n))) s.add(g.id);
    memberOf.set(id, s);
    return s;
  };

  const inMain = store.db.prepare(
    "SELECT 1 FROM edges WHERE layer = 'main' AND src = ? AND dst = ? AND kind = ?",
  );
  const candidates = [
    ...changed.flatMap((s) => store.effectiveEdges({ src: s.id, kind: SYMBOL_EDGES })),
    ...files.flatMap((p) => store.effectiveEdges({ src: fileId(store.repo(), p), kind: ["imports"] })),
  ].filter(
    (e) => e.src !== e.dst && (opts.allEdges === true || inMain.get(e.src, e.dst, e.kind) === undefined),
  );

  type Row = { path: string; line: number; dstId: string; f: CrossingFinding };
  const rows: Row[] = [];
  const symbolPairs = new Set<string>();
  const crossing = (srcId: string, dstId: string): [string, string][] => {
    const mine = groupsOf(srcId);
    const theirs = groupsOf(dstId);
    const out: [string, string][] = [];
    for (const g of boundaries) {
      if (!mine.has(g.id)) continue;
      for (const h of groups) {
        if (h.id !== g.id && theirs.has(h.id) && !mine.has(h.id) && !(g.mayUse ?? []).includes(h.id))
          out.push([g.id, h.id]);
      }
    }
    return out.sort();
  };
  const name = (id: string): string => cleanGroupName(groups.find((g) => g.id === id)?.name ?? id);

  const imports = candidates.filter((e) => e.kind === "imports");
  for (const e of candidates) {
    if (e.kind === "imports") continue;
    const s = describe(e.src);
    const d = describe(e.dst);
    if (!s?.sym || !d) continue;
    for (const [g, h] of crossing(e.src, e.dst)) {
      symbolPairs.add(`${s.path}\0${d.path}\0${g}\0${h}`);
      rows.push({
        path: s.path,
        line: s.sym.startLine,
        dstId: e.dst,
        f: {
          kind: "crossing",
          srcName: s.sym.name,
          srcPath: s.path,
          srcLine: s.sym.startLine,
          srcGroup: name(g),
          dstName: d.sym ? d.sym.name : d.path,
          dstPath: d.path,
          dstLine: d.sym ? d.sym.startLine : 0,
          dstGroup: name(h),
        },
      });
    }
  }
  for (const e of imports) {
    const s = describe(e.src);
    const d = describe(e.dst);
    if (!s || !d || s.sym || d.sym) continue;
    for (const [g, h] of crossing(e.src, e.dst)) {
      if (symbolPairs.has(`${s.path}\0${d.path}\0${g}\0${h}`)) continue;
      rows.push({
        path: s.path,
        line: 0,
        dstId: e.dst,
        f: {
          kind: "crossing",
          srcName: s.path,
          srcPath: s.path,
          srcLine: 0,
          srcGroup: name(g),
          dstName: d.path,
          dstPath: d.path,
          dstLine: 0,
          dstGroup: name(h),
        },
      });
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.dstId, b.dstId)).map((r) => r.f);
}
