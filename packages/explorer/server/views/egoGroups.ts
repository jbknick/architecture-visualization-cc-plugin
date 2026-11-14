import { cmp, getOrInit } from "./options.js";

/** A bucket (one side, one hop) with more nodes than 24 is grouped. */
export const GROUP_BUCKET_MIN = 25;
/** A group with more members than this is split one level further (workspace, folder, file). */
export const GROUP_SPLIT_OVER = 12;
/** Groups with at most this many members stay individual nodes. */
export const GROUP_SINGLE_MAX = 3;

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

export interface GroupPlan {
  id: string;
  level: "workspace" | "dir" | "file";
  ws: string | null;
  /** Folder or file path the group stands for (repo-relative); the workspace directory for workspace groups. */
  path: string;
  label: string;
  members: GroupItem[];
}

export interface Grouping {
  groups: GroupPlan[];
  /** Items that stay individual nodes (small groups, or a bucket that is small enough as it is). */
  singles: GroupItem[];
}

const NO_WS = "ws:(none)";

function relTo(dir: string, path: string): string {
  return dir === "." || dir === "" ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

/** Longest shared leading run of directory segments. */
function commonDirs(lists: string[][]): string[] {
  const first = lists[0] ?? [];
  let n = first.length;
  for (const l of lists) {
    let i = 0;
    while (i < n && l[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n);
}

/**
 * Groups one bucket of the ego graph: by workspace; a workspace group with more than 12 members by top-level
 * folder (chains of single folders are collapsed, like the project map); a folder group with more than 12 by
 * file. Groups of 3 or fewer members stay individual. Buckets of 24 or fewer are not grouped at all.
 */
export function planGroups(
  side: "in" | "out",
  hop: number,
  items: GroupItem[],
  workspaces: ReadonlyMap<string, WorkspaceInfo>,
): Grouping {
  if (items.length < GROUP_BUCKET_MIN) return { groups: [], singles: items };
  const groups: GroupPlan[] = [];
  const singles: GroupItem[] = [];
  const prefix = `group:${side}:${hop}:`;
  const emit = (g: Omit<GroupPlan, "id"> & { key: string }): void => {
    if (g.members.length <= GROUP_SINGLE_MAX) singles.push(...g.members);
    else {
      const { key, ...rest } = g;
      groups.push({ ...rest, id: `${prefix}${key}` });
    }
  };

  const byWs = new Map<string, GroupItem[]>();
  for (const it of items) getOrInit(byWs, it.ws ?? NO_WS, () => []).push(it);
  for (const [wsKey, wsItems] of [...byWs].sort((a, b) => cmp(a[0], b[0]))) {
    const info = workspaces.get(wsKey);
    const short = info?.short ?? "(root)";
    const dir = info?.dir ?? ".";
    const ws = wsKey === NO_WS ? null : wsKey;
    const wsGroup = {
      level: "workspace" as const,
      ws,
      path: dir,
      label: short,
      members: wsItems,
      key: wsKey,
    };
    if (wsItems.length <= GROUP_SPLIT_OVER) {
      emit(wsGroup);
      continue;
    }
    // Folder level: shared leading folders are collapsed, then one group per next folder.
    const dirsOf = (it: GroupItem): string[] => relTo(dir, it.path).split("/").slice(0, -1);
    const shared = commonDirs(wsItems.map(dirsOf));
    const byFolder = new Map<string, GroupItem[]>();
    for (const it of wsItems) {
      const d = dirsOf(it);
      const key = d.slice(0, shared.length + (d.length > shared.length ? 1 : 0)).join("/");
      getOrInit(byFolder, key, () => []).push(it);
    }
    for (const [, folderItems] of [...byFolder].sort((a, b) => cmp(a[0], b[0]))) {
      const own = commonDirs(folderItems.map(dirsOf)).join("/");
      const folderPath = dir === "." ? own : own ? `${dir}/${own}` : dir;
      const folder = {
        level: "dir" as const,
        ws,
        path: folderPath,
        label: own ? `${short} · ${own}` : short,
        members: folderItems,
        key: `dir:${folderPath}`,
      };
      if (folderItems.length <= GROUP_SPLIT_OVER) {
        emit(folder);
        continue;
      }
      const byFile = new Map<string, GroupItem[]>();
      for (const it of folderItems) getOrInit(byFile, it.path, () => []).push(it);
      for (const [filePath, fileItems] of [...byFile].sort((a, b) => cmp(a[0], b[0]))) {
        emit({
          level: "file",
          ws,
          path: filePath,
          label: `${short} · ${relTo(dir, filePath)}`,
          members: fileItems,
          key: `file:${filePath}`,
        });
      }
    }
  }
  return { groups, singles };
}
