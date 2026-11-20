// Pure helpers of the curation controls: ids made from names, and the edits a click makes to the overlay state.
import type { Group, SavedView, Selector } from "./api.ts";

/** Longest id the server accepts for a group or a saved view (`^[a-z0-9][a-z0-9-]{0,62}$`). */
const MAX_ID = 63;

/** `Web Dates!` becomes `web-dates`: lower case, `a-z0-9` and single dashes, at most 63 characters. Empty if nothing is left. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_ID)
    .replace(/-+$/, "");
}

/** The slug of `name`, or `-2`, `-3`... after it when a taken id already has it. Null when the name has no letters or digits. */
export function uniqueId(name: string, taken: readonly string[]): string | null {
  const base = slugOf(name);
  if (base === "") return null;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, MAX_ID - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.includes(id)) return id;
  }
}

/** Ids a selector names directly (`ids` selectors only). */
export function idsOf(selectors: readonly Selector[]): string[] {
  return selectors.flatMap((s) => (s.type === "ids" ? s.ids : []));
}

/** Whether a group's `ids` selectors already hold `nodeId`. */
export function groupHas(group: Group, nodeId: string): boolean {
  return idsOf(group.selectors).includes(nodeId);
}

/** The group with `nodeId` appended to its first `ids` selector (one is added when it has none). */
export function withMember(group: Group, nodeId: string): Group {
  if (groupHas(group, nodeId)) return group;
  const at = group.selectors.findIndex((s) => s.type === "ids");
  if (at < 0) return { ...group, selectors: [...group.selectors, { type: "ids", ids: [nodeId] }] };
  return {
    ...group,
    selectors: group.selectors.map((s, i) =>
      i === at && s.type === "ids" ? { ...s, ids: [...s.ids, nodeId] } : s,
    ),
  };
}

/** The hidden list with `{ type: "ids", ids: [nodeId] }` appended (unchanged if it is already there). */
export function withHidden(hidden: readonly Selector[], nodeId: string): Selector[] {
  const already = hidden.some((s) => s.type === "ids" && s.ids.length === 1 && s.ids[0] === nodeId);
  return already ? [...hidden] : [...hidden, { type: "ids", ids: [nodeId] }];
}

/** A one-line description of a selector, for the list of hidden entries. */
export function describeSelector(s: Selector): string {
  switch (s.type) {
    case "glob":
      return s.glob;
    case "kind":
      return `every ${s.kind}`;
    case "workspace":
      return s.workspace;
    case "ids":
      return s.ids.join(", ");
  }
}

/** A saved view of what the route shows now (no hidden parts and no groups of its own). */
export function viewFromRoute(
  id: string,
  name: string,
  route: {
    view: string;
    level: SavedView["spec"]["level"] | null;
    focus: string | null;
    filters: Record<string, string>;
  },
): SavedView {
  return {
    id,
    name,
    spec: {
      view: route.view,
      ...(route.level ? { level: route.level } : {}),
      ...(route.focus ? { focus: route.focus } : {}),
      hidden: [],
      groups: [],
      filters: route.filters,
    },
  };
}
