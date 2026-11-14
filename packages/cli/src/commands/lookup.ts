import {
  ensureDataDir,
  type GantryPaths,
  heal,
  openStore,
  refreshWorking,
  resolvePaths,
  type Store,
} from "@gantry/core";

/** Resolves paths, brings the main graph to HEAD and the working layer to the tree, then opens the store. */
export async function openFresh(cwd: string): Promise<{ paths: GantryPaths; store: Store }> {
  const paths = resolvePaths(cwd);
  ensureDataDir(paths);
  await heal(paths);
  await refreshWorking(paths);
  return { paths, store: openStore(paths.dbPath) };
}

/** Fixed-width, left-aligned table without colors (identical on a TTY and in a pipe). */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return `${[line(headers), ...rows.map(line)].join("\n")}\n`;
}
