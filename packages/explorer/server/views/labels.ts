/**
 * Short display names for workspaces. When most scoped npm names share one scope (`@org/api`, `@org/web`),
 * the scope is noise on a map, so those names lose it (`api`, `web`). Unscoped names and names with a
 * minority scope keep their full name. If stripping would make two labels equal, the full names are kept.
 * The result is keyed by input name; callers compute it once over every workspace so filters never change it.
 */
export function shortWorkspaceLabels(names: readonly string[]): Map<string, string> {
  const scopeOf = (n: string): string | null => {
    const m = /^(@[^/]+)\/(.+)$/.exec(n);
    return m ? (m[1] as string) : null;
  };
  const counts = new Map<string, number>();
  let scoped = 0;
  for (const n of names) {
    const s = scopeOf(n);
    if (s) {
      scoped += 1;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  let shared: string | null = null;
  let best = 0;
  for (const [s, c] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (c > best) {
      best = c;
      shared = s;
    }
  }
  const strip = shared !== null && best >= 2 && best * 2 > scoped;
  const out = new Map<string, string>();
  for (const n of names) {
    out.set(n, strip && scopeOf(n) === shared ? n.slice((shared as string).length + 1) : n);
  }
  // Collisions (`@a/x` stripped next to an unscoped `x`) fall back to the full names.
  const seen = new Map<string, number>();
  for (const v of out.values()) seen.set(v, (seen.get(v) ?? 0) + 1);
  for (const n of names) if ((seen.get(out.get(n) as string) ?? 0) > 1) out.set(n, n);
  return out;
}
