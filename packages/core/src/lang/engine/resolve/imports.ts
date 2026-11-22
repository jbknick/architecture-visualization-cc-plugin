import { pathOfFileId } from "../../../ids.js";
import type { ParsedFile } from "../../../parse/index.js";
import type { ResolveContext } from "../../../resolve/index.js";
import type { WorkspaceRecord } from "../../../types.js";
import type { LanguagePack } from "../pack.js";

/** A parsed file of the pack's language with the workspace that holds it. */
export interface FileEntry {
  fileId: string;
  /** Repo-relative path. */
  rel: string;
  /** Repo-relative folder of the file; `.` for the repo root. */
  dir: string;
  parsed: ParsedFile;
  workspace: WorkspaceRecord | undefined;
}

/**
 * Where an import path leads (spec section 7): a folder of the same workspace, a folder of a sibling workspace of the
 * repo, or outside the repo.
 */
export type ImportResolution =
  | { kind: "same-workspace"; workspace: WorkspaceRecord; files: FileEntry[] }
  | { kind: "sibling-workspace"; workspace: WorkspaceRecord; files: FileEntry[] }
  | { kind: "external"; specifier: string };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const depth = (w: WorkspaceRecord): number => (w.dir === "." ? 0 : w.dir.length);

/** The workspace of the pack's language that holds `rel`: the one with the longest folder. */
export function workspaceOfPath(
  pack: LanguagePack,
  workspaces: readonly WorkspaceRecord[],
  rel: string,
): WorkspaceRecord | undefined {
  let best: WorkspaceRecord | undefined;
  for (const w of workspaces) {
    if (w.lang !== pack.id) continue;
    if ((w.dir === "." || rel.startsWith(`${w.dir}/`)) && (!best || depth(w) > depth(best))) best = w;
  }
  return best;
}

/**
 * The files of a pack's language in a repo and the resolution of their imports. An import path is a workspace name
 * followed by the folder below the workspace's own, with the pack's separator between the segments; the files of that
 * folder are what the import names. A path that matches no workspace of the language, or a folder without an indexed file,
 * is external.
 */
export class ImportIndex {
  /** Files of the language in path order. */
  readonly files: FileEntry[] = [];
  readonly byFileId = new Map<string, FileEntry>();
  private readonly byDir = new Map<string, FileEntry[]>();
  private readonly workspaces: WorkspaceRecord[];

  constructor(
    private readonly pack: LanguagePack,
    ctx: ResolveContext,
  ) {
    this.workspaces = ctx.workspaces.filter((w) => w.lang === pack.id);
    for (const [fileId, parsed] of ctx.parsed) {
      const rel = pathOfFileId(fileId);
      if (!pack.extensions.some((x) => rel.endsWith(x))) continue;
      const slash = rel.lastIndexOf("/");
      this.files.push({
        fileId,
        rel,
        dir: slash < 0 ? "." : rel.slice(0, slash),
        parsed,
        workspace: workspaceOfPath(pack, this.workspaces, rel),
      });
    }
    this.files.sort((a, b) => cmp(a.rel, b.rel));
    for (const f of this.files) {
      this.byFileId.set(f.fileId, f);
      const list = this.byDir.get(f.dir) ?? [];
      list.push(f);
      this.byDir.set(f.dir, list);
    }
  }

  /** The files an import path in `from` names. */
  resolve(from: FileEntry, specifier: string): ImportResolution {
    const sep = this.pack.nodes.import.separator;
    let best: WorkspaceRecord | undefined;
    for (const w of this.workspaces) {
      if (
        (specifier === w.name || specifier.startsWith(`${w.name}${sep}`)) &&
        (!best || w.name.length > best.name.length)
      )
        best = w;
    }
    if (!best) return { kind: "external", specifier };
    const below = specifier
      .slice(best.name.length + sep.length)
      .split(sep)
      .filter((s) => s !== "")
      .join("/");
    const dir = below === "" ? best.dir : best.dir === "." ? below : `${best.dir}/${below}`;
    const files = this.byDir.get(dir) ?? [];
    if (files.length === 0) return { kind: "external", specifier };
    return from.workspace?.id === best.id
      ? { kind: "same-workspace", workspace: best, files }
      : { kind: "sibling-workspace", workspace: best, files };
  }
}
