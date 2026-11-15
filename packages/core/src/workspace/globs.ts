import picomatch from "picomatch";

/**
 * A predicate over repo-relative posix directory paths for a list of globs (`apps/*\/src/features/*`, `packages/*`).
 * Dot directories match, like file discovery. An empty list matches nothing.
 */
export function dirGlobMatcher(globs: readonly string[]): (dir: string) => boolean {
  const ms = globs.map((g) => picomatch(g.replace(/\/+$/, ""), { dot: true }));
  return (dir) => ms.some((m) => m(dir));
}
