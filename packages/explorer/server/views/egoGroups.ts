import { cmp, getOrInit } from "./options.js";

/** Rows one side of one hop may have when nothing is expanded (option `maxRows`, 8-40). */
export const EGO_ROWS_DEFAULT = 18;
export const EGO_ROWS_MIN = 8;
export const EGO_ROWS_MAX = 40;
/** Rows one expanded group shows before the rest moves to a "+N more" row (option `pageRows`, 4-40). */
export const EGO_PAGE_DEFAULT = 14;
export const EGO_PAGE_MIN = 4;
export const EGO_PAGE_MAX = 40;
/** Groups with at most this many members are small: siblings that small are merged into one "other callers" row. */
export const GROUP_SMALL_MAX = 3;
/** Folder paths longer than this are middle-ellipsized in labels. */
export const PATH_LABEL_MAX = 40;

export interface GroupItem {
  id: string;
  /** Repo-relative path of the file the item lives in (or is). */
  path: string;
  /** Workspace id, or null for files outside every workspace. */
  ws: string | null;
}

export interface WorkspaceInfo {
  /** Repo-relative workspace directory ("." for the repo root). */
  dir: string;
  /** Short display name (see labels.ts). */
  short: string;
}

export type GroupLevel = "workspace" | "dir" | "file" | "rest" | "more";

/** A group row: what it stands for and how to label it. */
export interface GroupPlan {
  id: string;
  level: GroupLevel;
  ws: string | null;
  /** Folder or file path the group stands for (repo-relative); the workspace directory for workspace groups. */
  path: string;
  label: string;
  members: GroupItem[];
  /** Distinct files among the members. */
  files: number;
}

/** One row of a side: an individual caller (callee) or a group, with its rows when the group is expanded. */
export type Row = { item: GroupItem } | { group: GroupPlan; expanded: boolean; rows: Row[] };

export interface RowOptions {
  maxRows: number;
  pageRows: number;
  /** Group ids to expand (ids that are not among the rows are ignored). */
  expand: ReadonlySet<string>;
  /** Most nodes the expansions may add in this bucket; an expansion that would pass it is skipped. */
  nodeBudget: number;
}

export interface RowPlan {
  rows: Row[];
  /** Nodes the expansions added (rows under expanded groups, at any depth). */
  added: number;
}

const NO_WS = "ws:(none)";
const LEAF_WORDS = (side: "in" | "out", n: number): string =>
  side === "in" ? (n === 1 ? "caller" : "callers") : n === 1 ? "callee" : "callees";
const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Clamps an option to a range, falling back to `dflt` when it is not a number. */
export function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  return v === undefined || !Number.isFinite(v) ? dflt : Math.max(lo, Math.min(hi, Math.round(v)));
}

function relTo(dir: string, path: string): string {
  return dir === "." || dir === "" ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

/** A folder path for a label: leading `src/` dropped, a path over 40 characters shortened in the middle (last two folders kept). */
export function folderLabel(rel: string): string {
  let p = rel.startsWith("src/") ? rel.slice(4) : rel;
  if (p === "") p = rel;
  if (p.length <= PATH_LABEL_MAX) return p;
  const segs = p.split("/");
  if (segs.length <= 3) return p;
  const tail = segs.slice(-2).join("/");
  const withHead = `${segs[0]}/…/${tail}`;
  return withHead.length <= PATH_LABEL_MAX ? withHead : `…/${tail}`;
}

// ---- the tree: workspace -> folder (single-folder chains collapsed) -> file -> symbol --------------------------

interface TNode {
  /** Group id suffix; the full id is `group:<side>:<hop>:<key>`. */
  key: string;
  level: "root" | "workspace" | "dir" | "file" | "item" | "rest" | "more";
  ws: string | null;
  path: string;
  /** Text before the counts in the label. */
  title: string;
  members: GroupItem[];
  files: number;
  kids: TNode[];
  item?: GroupItem;
  /** "+N more" rows: the key of the group they page and the index of their first child. */
  base?: string;
  offset?: number;
}

interface Dir {
  dirs: Map<string, Dir>;
  files: Map<string, GroupItem[]>;
}

const bySize = (a: TNode, b: TNode): number => b.members.length - a.members.length || cmp(a.key, b.key);

function mk(t: Omit<TNode, "files"> & { files?: number }): TNode {
  return { ...t, files: t.files ?? new Set(t.members.map((m) => m.path)).size };
}

function itemLeaves(members: GroupItem[]): TNode[] {
  return [...members]
    .sort((a, b) => cmp(a.path, b.path) || cmp(a.id, b.id))
    .map((it) =>
      mk({
        key: `item:${it.id}`,
        level: "item",
        ws: it.ws,
        path: it.path,
        title: it.id,
        members: [it],
        kids: [],
        item: it,
      }),
    );
}

function buildWorkspace(wsKey: string, items: GroupItem[], info: WorkspaceInfo | undefined): TNode {
  const short = info?.short ?? "(root)";
  const dir = info?.dir ?? ".";
  const ws = wsKey === NO_WS ? null : wsKey;
  const abs = (rel: string): string => (dir === "." || dir === "" ? rel : rel ? `${dir}/${rel}` : dir);
  const root: Dir = { dirs: new Map(), files: new Map() };
  for (const it of items) {
    const segs = relTo(dir, it.path).split("/");
    segs.pop();
    let d = root;
    for (const s of segs) d = getOrInit(d.dirs, s, () => ({ dirs: new Map(), files: new Map() }));
    getOrInit(d.files, it.path, () => []).push(it);
  }
  const members = (d: Dir): GroupItem[] => [...d.files.values(), ...[...d.dirs.values()].map(members)].flat();
  const fileNode = (path: string, its: GroupItem[]): TNode =>
    mk({
      key: `file:${path}`,
      level: "file",
      ws,
      path,
      title: path.slice(path.lastIndexOf("/") + 1),
      members: its,
      kids: [],
    });
  // A folder node: shared single-folder chains collapse into one node; a folder holding a single file is that file.
  const dirNode = (start: Dir, prefix: string[]): TNode => {
    let d = start;
    const segs = [...prefix];
    while (d.files.size === 0 && d.dirs.size === 1) {
      const [seg, sub] = [...d.dirs][0] as [string, Dir];
      segs.push(seg);
      d = sub;
    }
    if (d.dirs.size === 0 && d.files.size === 1) {
      const [path, its] = [...d.files][0] as [string, GroupItem[]];
      return fileNode(path, its);
    }
    const rel = segs.join("/");
    const kids = childrenOf(d, segs);
    const ms = members(d);
    return mk({
      key: `dir:${abs(rel)}`,
      level: "dir",
      ws,
      path: abs(rel),
      title: `${short} › ${folderLabel(rel)}`,
      members: ms,
      kids,
    });
  };
  const childrenOf = (d: Dir, segs: string[]): TNode[] =>
    [
      ...[...d.dirs].map(([seg, sub]) => dirNode(sub, [...segs, seg])),
      ...[...d.files].map(([path, its]) => fileNode(path, its)),
    ].sort(bySize);
  // The workspace's own shared leading folders are collapsed: its children start where the paths diverge.
  let top = root;
  const topSegs: string[] = [];
  while (top.files.size === 0 && top.dirs.size === 1) {
    const [seg, sub] = [...top.dirs][0] as [string, Dir];
    topSegs.push(seg);
    top = sub;
  }
  return mk({
    key: wsKey,
    level: "workspace",
    ws,
    path: dir,
    title: short,
    members: items,
    kids: childrenOf(top, topSegs),
  });
}

const smallCount = (kids: TNode[]): number => kids.filter((k) => k.members.length <= GROUP_SMALL_MAX).length;
const isSplittable = (t: TNode): boolean =>
  (t.level === "workspace" || t.level === "dir") && t.members.length > GROUP_SMALL_MAX && t.kids.length > 0;

/**
 * Plans the rows of one bucket (one side, one hop). Deterministic.
 *
 * Unexpanded, a bucket never has more than `maxRows` rows. A bucket of `maxRows` nodes or fewer is shown node by
 * node. Otherwise it starts with one row per workspace and the largest group is split into its children
 * (workspace -> folder -> file) as long as the row count stays within the budget. Small children (3 members or
 * fewer) that share a parent are merged into one "other callers" row per parent. When a group has more children
 * than the budget allows, its two largest children are peeled off and the remaining children stay behind one
 * "other callers" row, which can be split again. Symbols appear as rows only inside an expanded group.
 *
 * Expanding a group replaces its row by its children, at most `pageRows` rows: the largest ones, and a
 * "+N more callers" row that expands to the next page.
 */
export function planRows(
  side: "in" | "out",
  hop: number,
  items: GroupItem[],
  workspaces: ReadonlyMap<string, WorkspaceInfo>,
  opts: RowOptions,
): RowPlan {
  const prefix = `group:${side}:${hop}:`;
  const words = (n: number): string => LEAF_WORDS(side, n);
  const counts = (m: GroupItem[], files: number, withFiles = true): string =>
    `${plural(m.length, words(1), words(2))}${withFiles ? ` in ${plural(files, "file", "files")}` : ""}`;
  items = [...items].sort((a, b) => cmp(a.id, b.id));
  if (items.length <= opts.maxRows) return { rows: items.map((item) => ({ item })).sort(byItemId), added: 0 };

  const byWs = new Map<string, GroupItem[]>();
  for (const it of items) getOrInit(byWs, it.ws ?? NO_WS, () => []).push(it);
  const wsNodes = [...byWs].map(([k, its]) => buildWorkspace(k, its, workspaces.get(k))).sort(bySize);
  const root = mk({
    key: "root",
    level: "root",
    ws: null,
    path: ".",
    title: "",
    members: items,
    kids: wsNodes,
  });

  // opened: node -> how many of its children are shown (the rest sit behind one "other" row).
  const opened = new Map<TNode, number>();
  const rowsOf = (t: TNode): number => {
    const j = opened.get(t);
    if (j === undefined) return 1;
    let n = j < t.kids.length ? 1 : 0;
    for (let i = 0; i < j; i++) n += rowsOf(t.kids[i] as TNode);
    return n;
  };
  opened.set(root, wsNodes.length <= opts.maxRows ? wsNodes.length : opts.maxRows - 1);

  interface Entry {
    t: TNode;
    /** For an "other" entry: the parent and the index of its first hidden child. */
    from?: number;
    size: number;
  }
  const entries = (t: TNode, out: Entry[]): void => {
    const j = opened.get(t) as number;
    for (let i = 0; i < j; i++) {
      const k = t.kids[i] as TNode;
      if (opened.has(k)) entries(k, out);
      else if (isSplittable(k)) out.push({ t: k, size: k.members.length });
    }
    if (j < t.kids.length && t.level !== "root") {
      const tail = t.kids.slice(j);
      if ((tail[0] as TNode).members.length > GROUP_SMALL_MAX && isSplittable(t))
        out.push({ t, from: j, size: tail.reduce((s, k) => s + k.members.length, 0) });
    }
  };
  const tryOpen = (t: TNode, from: number): boolean => {
    const n = t.kids.length;
    const nonSmall = n - smallCount(t.kids);
    if (nonSmall === 0) return false;
    const full = smallCount(t.kids) >= 2 ? nonSmall : n;
    const prev = opened.get(t);
    for (const raw of [full, from + 2, from + 1]) {
      let j = Math.min(raw, n);
      if (j <= from) continue;
      if (n - j === 1) j = n; // one hidden child is just that child
      opened.set(t, j);
      if (rowsOf(root) <= opts.maxRows) return true;
    }
    if (prev === undefined) opened.delete(t);
    else opened.set(t, prev);
    return false;
  };
  for (;;) {
    const list: Entry[] = [];
    entries(root, list);
    list.sort((a, b) => b.size - a.size || cmp(a.t.key, b.t.key) || (a.from ?? -1) - (b.from ?? -1));
    if (!list.some((e) => tryOpen(e.t, e.from ?? 0))) break;
  }

  // Rows from the final state.
  const restNode = (parent: TNode, from: number): TNode => {
    const kids = parent.kids.slice(from);
    const members = kids.flatMap((k) => k.members);
    return mk({
      key: `rest:${parent.key}`,
      level: "rest",
      ws: parent.ws,
      path: parent.path,
      title: parent.level === "root" ? "" : parent.title,
      members,
      kids,
    });
  };
  const rootRest = (t: TNode): string =>
    `${plural(t.kids.length, "other workspace", "other workspaces")} · ${counts(t.members, t.files)}`;
  const labelOf = (t: TNode): string => {
    if (t.level === "item") return t.title;
    if (t.level === "workspace" || t.level === "dir") return `${t.title} — ${counts(t.members, t.files)}`;
    if (t.level === "file") return `${t.title} — ${counts(t.members, t.files, false)}`;
    if (t.level === "more")
      return `+${plural(t.members.length, `more ${words(1)}`, `more ${words(2)}`)} in ${plural(t.files, "file", "files")}`;
    // rest
    if (t.title === "") return rootRest(t);
    return `${t.title} · ${plural(t.members.length, `other ${words(1)}`, `other ${words(2)}`)} in ${plural(t.files, "file", "files")}`;
  };
  const planOf = (t: TNode): GroupPlan => ({
    id: `${prefix}${t.key}`,
    level: t.level as GroupLevel,
    ws: t.ws,
    path: t.path,
    label: labelOf(t),
    members: t.members,
    files: t.files,
  });
  const collect = (t: TNode): TNode[] => {
    const j = opened.get(t);
    if (j === undefined) return [t];
    const out = t.kids.slice(0, j).flatMap(collect);
    if (j < t.kids.length) out.push(restNode(t, j));
    return out;
  };
  const top = collect(root);

  // Expansion: the group's children, one page at a time.
  let added = 0;
  const moreNode = (parent: TNode, kids: TNode[], offset: number): TNode =>
    mk({
      key: `more:${parent.base ?? parent.key}:${offset}`,
      base: parent.base ?? parent.key,
      offset,
      level: "more",
      ws: parent.ws,
      path: parent.path,
      title: "",
      members: kids.flatMap((k) => k.members),
      kids,
    });
  const childRows = (t: TNode, kids: TNode[], offset: number): TNode[] => {
    if (kids.length <= opts.pageRows) return kids;
    const shown = kids.slice(0, opts.pageRows - 1);
    return [...shown, moreNode(t, kids.slice(opts.pageRows - 1), offset + opts.pageRows - 1)];
  };
  const rowOf = (t: TNode): Row => {
    if (t.level === "item") return { item: t.item as GroupItem };
    const g = planOf(t);
    if (!opts.expand.has(g.id)) return { group: g, expanded: false, rows: [] };
    const kids = t.level === "file" ? itemLeaves(t.members) : t.kids;
    const page = childRows(t, kids, t.offset ?? 0);
    if (added + page.length > opts.nodeBudget) return { group: g, expanded: false, rows: [] };
    added += page.length;
    return { group: g, expanded: true, rows: page.map((k) => rowOf(k)) };
  };
  return { rows: top.map((t) => rowOf(t)), added };
}

const itemId = (r: Row): string => ("item" in r ? r.item.id : "");
const byItemId = (a: Row, b: Row): number => cmp(itemId(a), itemId(b));
