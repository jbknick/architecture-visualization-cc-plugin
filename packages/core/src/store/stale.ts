import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { PARSE_CACHE_FILE } from "../parse/cache.js";
import type { GantryPaths } from "../paths/index.js";
import { readMeta, readSchemaVersion, SCHEMA_VERSION } from "./db.js";

function removeStore(dbPath: string): void {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  rmSync(join(dirname(dbPath), PARSE_CACHE_FILE), { force: true });
}

/**
 * Deletes a store that was built by another version of Gantry (spec section 9): when `gantry.db` exists and its
 * `meta.schema_version` is not `SCHEMA_VERSION` (an older or a newer one), removes `gantry.db`, `gantry.db-wal`,
 * `gantry.db-shm` and `parse-cache.db`, and says why on stderr. The caller then goes on as on a repository with no
 * index. A store whose `meta.repo` is not `paths.repo` (the remote was added, changed or removed since it was built)
 * is removed the same way, because every id in it carries the old name. Every non-hook entry point calls it before it
 * opens the store; hooks never do. A missing store, or one that is current, is left untouched.
 */
export function resetStaleStore(paths: Pick<GantryPaths, "dbPath"> & { repo?: string }): {
  reset: boolean;
  found?: number;
} {
  const found = readSchemaVersion(paths.dbPath);
  if (found === undefined) return { reset: false };
  if (found !== SCHEMA_VERSION) {
    process.stderr.write(
      `gantry: the index was built by an older version of Gantry (schema ${found}, now ${SCHEMA_VERSION}); rebuilding it\n`,
    );
    removeStore(paths.dbPath);
    return { reset: true, found };
  }
  const stored = paths.repo === undefined ? undefined : readMeta(paths.dbPath, "repo");
  if (stored !== undefined && stored !== paths.repo) {
    process.stderr.write(
      `gantry: the repository name changed (${stored} -> ${paths.repo}); rebuilding the index\n`,
    );
    removeStore(paths.dbPath);
    return { reset: true, found };
  }
  return { reset: false };
}
