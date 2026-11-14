// Pure helpers for the duplicates view: wording, percentages, the side-by-side line alignment.
import type { DupCluster, DupMember, DupSkipInfo, DupSplit, DupTier, DupWorkspace } from "../api.ts";

/** Plain words for each tier, with one line saying what it means. */
export const TIER_WORDS: Record<DupTier, { label: string; hint: string }> = {
  exact: { label: "Identical", hint: "The same code, apart from formatting and comments." },
  near: {
    label: "Nearly identical",
    hint: "The same structure with small changes, such as renamed variables or a different constant.",
  },
  code_vector: {
    label: "Similar code",
    hint: "Written differently but reads like the same code to the embedding model.",
  },
  semantic: {
    label: "Similar meaning",
    hint: "Different code that does the same job, judged from the descriptions.",
  },
};

export const TIER_ORDER: readonly DupTier[] = ["exact", "near", "code_vector", "semantic"];

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "3 copies · 84 lines". */
export function copiesLine(c: Pick<DupCluster, "size" | "loc">): string {
  return `${plural(c.size, "copy", "copies")} · ${plural(c.loc, "line")}`;
}

/** "22 groups · 83 functions · about 1,900 duplicated lines". */
export function overviewLine(s: { clusters: number; functions: number; duplicateLines: number }): string {
  return `${plural(s.clusters, "group")} · ${plural(s.functions, "function")} · about ${plural(
    roundLines(s.duplicateLines),
    "duplicated line",
  )}`;
}

/** Rounds to two significant figures once past 100, so "about" is honest. */
export function roundLines(n: number): number {
  if (n < 100) return n;
  const digits = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / digits) * digits;
}

/** A whole-number percentage. Only identical code reads 100%; anything else tops out at 99%. */
export function percent(score: number | null, tier: DupTier | null): string | null {
  if (score === null) return null;
  if (tier === "exact") return "100%";
  return `${Math.min(99, Math.floor(score * 100))}%`;
}

/** The names of a group for its list row: up to three, then "+N more". Equal names are listed once. */
export function nameLine(c: DupCluster): string {
  const names = [...new Set(c.members.map((m) => m.name))];
  const shown = names.slice(0, 3).join(" · ");
  return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
}

export function workspaceName(id: string | null, byId: ReadonlyMap<string, DupWorkspace>): string {
  if (id === null) return "(no workspace)";
  return byId.get(id)?.shortLabel ?? id.replace(/^ws:/, "");
}

/** "utils only" or "utils ↔ web". */
export function splitLabel(s: DupSplit, byId: ReadonlyMap<string, DupWorkspace>): string {
  const names = s.workspaces.map((w) => workspaceName(w, byId));
  if (names.length === 0) return "no workspace";
  if (names.length === 1) return `${names[0]} only`;
  if (names.length <= 3) return names.join(" ↔ ");
  return `${names.slice(0, 2).join(" ↔ ")} ↔ ${names.length - 2} more`;
}

/** Banner text for tiers that could not run, or null when everything ran. */
export function skippedBanner(skipped: DupSkipInfo[] | undefined): string | null {
  const first = skipped?.find((s) => s.tier === "code_vector") ?? skipped?.[0];
  if (!first) return null;
  return `Only identical and nearly identical code was checked. ${first.message}`;
}

/** The pairs to dismiss so that `member` is no longer in the group with the keep candidate. */
export function pairsToDismiss(cluster: DupCluster, member: DupMember): [string, string][] {
  const keep = cluster.keep;
  const touches = (l: { a: string; b: string }, id: string) => l.a === id || l.b === id;
  const direct = cluster.links.some((l) => touches(l, member.id) && touches(l, keep));
  if (direct || cluster.links.length === 0) return [[keep, member.id]];
  // Linked to the keep candidate only through other copies: cut every link of this member.
  return cluster.links.filter((l) => touches(l, member.id)).map((l): [string, string] => [l.a, l.b]);
}

// ---- side-by-side alignment -------------------------------------------------------------------------------------

export interface DiffRow {
  /** Index into the left lines, or null when the right side has an extra line here. */
  left: number | null;
  /** Index into the right lines, or null when the left side has an extra line here. */
  right: number | null;
  /** True when the two lines differ (or one side has none). */
  differs: boolean;
}

/** Largest input for the LCS table; beyond it lines are paired by position. */
const MAX_DIFF_CELLS = 250_000;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Lines of two functions, aligned for a side-by-side view. Lines are compared ignoring indentation. Equal
 * lines share a row; a run of changed lines is paired up one to one, and the longer side's extra lines sit
 * beside an empty cell.
 */
export function alignLines(left: string[], right: string[]): DiffRow[] {
  const a = left.map(norm);
  const b = right.map(norm);
  const n = a.length;
  const m = b.length;
  const rows: DiffRow[] = [];
  if (n * m > MAX_DIFF_CELLS) {
    for (let i = 0; i < Math.max(n, m); i++) {
      const l = i < n ? i : null;
      const r = i < m ? i : null;
      rows.push({ left: l, right: r, differs: l === null || r === null || a[l] !== b[r] });
    }
    return rows;
  }
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const down = (lcs[i + 1] as Uint16Array)[j] as number;
      const across = (lcs[i] as Uint16Array)[j + 1] as number;
      (lcs[i] as Uint16Array)[j] =
        a[i] === b[j] ? ((lcs[i + 1] as Uint16Array)[j + 1] as number) + 1 : Math.max(down, across);
    }
  }
  let i = 0;
  let j = 0;
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    const k = Math.max(dels.length, adds.length);
    for (let x = 0; x < k; x++) rows.push({ left: dels[x] ?? null, right: adds[x] ?? null, differs: true });
    dels = [];
    adds = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      rows.push({ left: i, right: j, differs: false });
      i++;
      j++;
    } else if (
      j >= m ||
      (i < n && ((lcs[i + 1] as Uint16Array)[j] as number) >= ((lcs[i] as Uint16Array)[j + 1] as number))
    ) {
      dels.push(i++);
    } else {
      adds.push(j++);
    }
  }
  flush();
  return rows;
}
