// Pure helpers of the Team layer: the person filter, the counts by tier, the area markers and the review layer a
// picked change set paints on the map.
import type { ReviewLayer, ReviewLink, ReviewMark, TeamChangeSet, TeamLayerData } from "../api.ts";
import { fileIdOfSymId, kindOfId, nameOfSymId, pathOfFileId, pathOfSymId } from "../ids.ts";
import type { LayerPaint, LayerTree } from "./reviewModel.ts";

/** Data older than this (24 hours) gets the freshness line in the muted warning color. */
export const STALE_AFTER_S = 24 * 3600;

/** Seconds since the pull: the age the server gave when the data was read, plus the time since then. */
export function currentAge(ageS: number | null, loadedAt: number | null, now: number): number | null {
  if (ageS === null) return null;
  return ageS + (loadedAt === null ? 0 : Math.max(0, Math.round((now - loadedAt) / 1000)));
}

/** "12 min", "3 h", "2 days": how long ago the cache was pulled, for `Team data pulled <age> ago`. */
export function ageWords(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(seconds / 86400)} days`;
}

/** The change sets of the ticked people (all of them when nobody is ticked), in the server's order (by id). */
export function visibleSets(data: TeamLayerData | null, people: readonly string[]): TeamChangeSet[] {
  if (!data) return [];
  return people.length === 0 ? data.change_sets : data.change_sets.filter((c) => people.includes(c.owner));
}

/** How many open change sets a person owns. */
export const countFor = (data: TeamLayerData, person: string): number =>
  data.change_sets.filter((c) => c.owner === person).length;

export type Tier = "direct" | "potential" | "reachable";
const TIERS: readonly Tier[] = ["direct", "potential", "reachable"];

export interface TierCounts {
  /** Changed code: the rows of the changed list (see `changedRows`). */
  changed: number;
  /** The node list was cut at the server's cap: `changed` is a floor. */
  changedFloor: boolean;
  direct: number;
  potential: number;
  reachable: number;
  /** Tiers whose count is a floor because the radius was cut at the server's cap. */
  floor: Record<Tier, boolean>;
}

/**
 * Counts of changed code and of the radius by tier. The server cuts the radius lowest hop first, so the kept entries
 * are every entry below some hop and part of that hop: the tier of the last kept entry and every tier after it may be
 * short (the later ones show 0 or more), the tiers before it are whole.
 */
export function tierCounts(cs: TeamChangeSet): TierCounts {
  const n = { direct: 0, potential: 0, reachable: 0 };
  for (const r of cs.radius) n[r.tier]++;
  const floor = { direct: false, potential: false, reachable: false };
  if (cs.radius_total > cs.radius.length) {
    const last = [...TIERS].reverse().find((t) => n[t] > 0) ?? "direct";
    for (const t of TIERS.slice(TIERS.indexOf(last))) floor[t] = true;
  }
  return {
    changed: changedRows(cs).length,
    changedFloor: cs.nodes_total > cs.nodes.length,
    ...n,
    floor,
  };
}

/** The files that a changed symbol of the list already stands for: the change set names a file and its symbols both. */
function coveredFiles(cs: TeamChangeSet): Set<string> {
  const out = new Set<string>();
  for (const id of cs.nodes) {
    const file = fileIdOfSymId(id);
    if (file !== undefined) out.add(file);
  }
  return out;
}

/**
 * The changed code as rows: every changed symbol, and the files that changed without a listed symbol. This is the one
 * definition of "changed" in the panel: the header count, the hint under the list and the list itself all use it.
 */
export function changedRows(cs: TeamChangeSet): NodeRow[] {
  const covered = coveredFiles(cs);
  return cs.nodes.filter((id) => !covered.has(id)).map(nodeRow);
}

/** A tier's count as shown: the number, with a `+` when it is a floor. */
export const countText = (n: number, floor: boolean): string =>
  `${n.toLocaleString("en-US")}${floor ? "+" : ""}`;

export interface AreaMarker {
  /** The workspace id. */
  id: string;
  /** Open change sets touching the area. */
  count: number;
  /** Their owners, sorted and unique. */
  owners: string[];
}

/** One marker per workspace holding a changed node of the given change sets. Sorted by id. */
export function areaMarkers(sets: readonly TeamChangeSet[]): AreaMarker[] {
  const out = new Map<string, { count: number; owners: Set<string> }>();
  for (const cs of sets) {
    for (const ws of cs.map_nodes) {
      const m = out.get(ws) ?? { count: 0, owners: new Set<string>() };
      m.count++;
      m.owners.add(cs.owner);
      out.set(ws, m);
    }
  }
  return [...out.entries()]
    .map(([id, m]) => ({ id, count: m.count, owners: [...m.owners].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The name of a change set: its title, else its id. */
export const titleOf = (cs: TeamChangeSet): string => (cs.title && cs.title.trim() !== "" ? cs.title : cs.id);

export const STATE_WORDS: Record<TeamChangeSet["state"], string> = {
  proposed: "Proposed",
  in_progress: "In progress",
  in_review: "In review",
  merged: "Merged",
};

export interface NodeRow {
  id: string;
  /** The symbol's name, or the file's last path segment. */
  name: string;
  path: string;
  isFile: boolean;
}

/** A changed node as a list row. */
export function nodeRow(id: string): NodeRow {
  if (kindOfId(id) === "file") {
    const path = pathOfFileId(id);
    return { id, name: path.split("/").at(-1) ?? path, path, isFile: true };
  }
  return { id, name: nameOfSymId(id) ?? id, path: pathOfSymId(id) ?? "", isFile: false };
}

/** The most solid lines drawn from directly affected nodes to the change. */
export const MAX_TEAM_LINKS = 100;

/**
 * The review layer of a change set, for the map: its changed nodes as `modified` marks, its radius as hop marks and a
 * solid line from each directly affected node to the changed nodes it uses (`direct_uses`). A symbol also marks its
 * file, so the layer shows at the Files level too; `known` says which ids the map has a tile for, and a line goes
 * between the tiles that exist (the symbols', else their files'). A node the change set changes never takes a hop tint. Reachable entries (hop 4 and over)
 * carry their hop and are not tinted by the review paint (see `teamReach`).
 */
export function teamReviewLayer(cs: TeamChangeSet, known?: (id: string) => boolean): ReviewLayer {
  const changed = new Set<string>();
  for (const id of cs.nodes) {
    changed.add(id);
    const file = fileIdOfSymId(id);
    if (file !== undefined) changed.add(file);
  }
  const marks: ReviewMark[] = [...changed].sort().map((id) => ({ id, change: "modified" as const }));
  const hops = new Map<string, number>();
  const lower = (id: string, hop: number) => {
    if (changed.has(id)) return;
    const had = hops.get(id);
    if (had === undefined || hop < had) hops.set(id, hop);
  };
  for (const r of cs.radius) {
    lower(r.id, r.hop);
    const file = fileIdOfSymId(r.id);
    if (file !== undefined) lower(file, r.hop);
  }
  for (const [id, hop] of [...hops].sort((a, b) => (a[0] < b[0] ? -1 : 1))) marks.push({ id, hop });

  // The tile that shows an id: the id itself, else its file's.
  const place = (id: string): string | undefined => {
    if (known === undefined || known(id)) return id;
    const file = fileIdOfSymId(id);
    return file !== undefined && known(file) ? file : undefined;
  };
  // One line per (user, changed node) pair the local graph knows, between the tiles the map has. A user with no local
  // edge to a changed node gets none.
  const links = new Map<string, ReviewLink>();
  for (const use of cs.direct_uses ?? []) {
    const src = place(use.id);
    if (src === undefined) continue;
    for (const changedId of use.changed) {
      const dst = place(changedId);
      if (dst === undefined || dst === src) continue;
      const key = `${src}>${dst}`;
      const had = links.get(key);
      if (had) had.weight += 1;
      else links.set(key, { id: key, src, dst, change: "modified", weight: 1, tier: "direct", hop: 1 });
    }
  }
  const all = [...links.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { marks, links: all.slice(0, MAX_TEAM_LINKS), linksTotal: all.length, placed: [], unplaced: [] };
}

/** How the map marks a node beyond the review paint: `reach` is 1 for the reachable tier, 2 for a through-hub node of a nearer tier. */
export interface TeamReach {
  /** Per tree index: 1 reachable (tint and dashed outline), 2 reached through a hub in a nearer tier (outline only). */
  reach: Uint8Array;
  /** The line printed on a node reached through a hub: `through hub <name>` or `through a hub`. */
  hubLabel: Map<number, string>;
}

/** The short name of the node an id stands for: a symbol's name, or a file's last path segment. */
const nameOfId = (id: string): string => nodeRow(id).name;

/**
 * The hub an entry at `hop` was reached through. The data does not name it; the hub is listed as an ordinary entry one
 * hop nearer. Name it only when exactly one such entry exists, otherwise say `through a hub`.
 */
export function hubLabelFor(cs: TeamChangeSet, hop: number): string {
  const nearer = cs.radius.filter((r) => !r.via_hub && r.hop === hop - 1);
  return nearer.length === 1 && nearer[0] ? `through hub ${nameOfId(nearer[0].id)}` : "through a hub";
}

/**
 * The reachable entries and the through-hub entries (any tier) of a change set as tree indices, with their ancestors
 * lit in `paint.lit`. A node the paint already marked as changed keeps that. A reachable node gets a faint tint and a
 * dashed outline; a through-hub node of a nearer tier keeps its tier's tint and gets the dashed outline. Any node
 * reached only through hubs carries the `through hub` line.
 */
export function teamReach(cs: TeamChangeSet, tree: LayerTree, paint: LayerPaint): TeamReach {
  const index = new Map<string, number>();
  tree.ids.forEach((id, i) => {
    index.set(id, i);
  });
  const reach = new Uint8Array(tree.ids.length);
  const light = (i: number) => {
    for (let k = i; k !== -1 && !paint.lit[k]; k = tree.parents[k] ?? -1) paint.lit[k] = 1;
  };
  const hubLabel = new Map<number, string>();
  const plain = new Set<number>();
  for (const r of cs.radius) {
    const file = fileIdOfSymId(r.id);
    for (const id of file === undefined ? [r.id] : [r.id, file]) {
      const i = index.get(id);
      if (i === undefined || paint.change[i]) continue;
      if (!r.via_hub) plain.add(i);
      if (r.tier !== "reachable" && !r.via_hub) continue;
      // A node a nearer entry already tints keeps that tint; the reachable tier adds nothing there.
      if (r.tier === "reachable" && (paint.hop[i] ?? 0) === 0) reach[i] = 1;
      else if (reach[i] === 0) reach[i] = 2;
      light(i);
      if (r.via_hub && !hubLabel.has(i)) hubLabel.set(i, hubLabelFor(cs, r.hop));
    }
  }
  // A node some entry reaches without a hub is not "through a hub".
  for (const i of plain) hubLabel.delete(i);
  // A nearer-tier node that only a plain entry marked keeps no outline.
  for (let i = 0; i < reach.length; i++) if (reach[i] === 2 && !hubLabel.has(i)) reach[i] = 0;
  return { reach, hubLabel };
}
