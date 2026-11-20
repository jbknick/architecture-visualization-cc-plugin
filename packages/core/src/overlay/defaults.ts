import type { FileRecord } from "../types.js";
import { dirGlobMatcher } from "../workspace/globs.js";
import type { Group } from "./types.js";

/** Directories that become default groups (spec section 7). Computed from the index, never stored. */
export const DEFAULT_GROUP_GLOBS = ["apps/*/src/features/*", "apps/*/src/modules/*", "packages/*"];

/** Id prefix of a default group. Reserved: `GroupIdSchema` rejects `:`, so a person cannot write one. */
export const DEFAULT_GROUP_PREFIX = "default:";

/**
 * One group per directory that matches a default glob and holds at least one of `files`. `id` is `default:<dir>`,
 * `name` is the directory, the one selector is `<dir>/**`, `mayUse` is null. Sorted by id.
 */
export function defaultGroups(files: readonly FileRecord[]): Group[] {
  const match = dirGlobMatcher(DEFAULT_GROUP_GLOBS);
  const dirs = new Set<string>();
  for (const f of files) {
    const segs = f.path.split("/").slice(0, -1);
    for (let i = segs.length; i >= 1; i--) {
      const dir = segs.slice(0, i).join("/");
      if (match(dir)) dirs.add(dir);
    }
  }
  return [...dirs]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      (dir): Group => ({
        id: `${DEFAULT_GROUP_PREFIX}${dir}`,
        name: dir,
        selectors: [{ type: "glob", glob: `${dir}/**` }],
        mayUse: null,
      }),
    );
}
