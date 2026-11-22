import fs from "node:fs";
import path from "node:path";
import { pathOfFileId } from "../ids.js";
import { parseFile } from "../lang/index.js";
import type { ParsedFile } from "../parse/index.js";
import type { WorkspaceRecord } from "../types.js";

/** Another repo of the workspace, as the resolver of the repo being indexed sees it. */
export interface SiblingRepo {
  repo: string;
  root: string;
  workspaces: WorkspaceRecord[];
  /** The parsed files of that repo, read from its work tree when first asked for. */
  parsed: Map<string, ParsedFile>;
}

/**
 * The files of a sibling repo, parsed on demand: a resolver of another repo needs the few files an import of one of its
 * packages leads to (the entry file and the files it re-exports from), not the whole repo. A path that is not an
 * file that the repo's own index pass keeps (`discovered`: git ignore, nested repos, size and exclude rules), or cannot
 * be read, is not in the map.
 */
export class SiblingFiles extends Map<string, ParsedFile> {
  private readonly missing = new Set<string>();

  constructor(
    private readonly repo: string,
    private readonly root: string,
    private readonly discovered: () => ReadonlySet<string>,
  ) {
    super();
  }

  override has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  override get(key: string): ParsedFile | undefined {
    const known = super.get(key);
    if (known || this.missing.has(key)) return known;
    const rel = pathOfFileId(key);
    let pf: ParsedFile | undefined;
    if (this.discovered().has(rel)) {
      try {
        pf = parseFile(this.repo, rel, fs.readFileSync(path.join(this.root, rel), "utf8"));
      } catch {
        pf = undefined;
      }
    }
    if (pf) super.set(key, pf);
    else this.missing.add(key);
    return pf;
  }
}
