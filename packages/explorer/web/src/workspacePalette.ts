// The one workspace palette. The 2D filter panels colour a workspace by a hash of its id (`workspaceColor`);
// the 3D map colours islands by position in the sorted workspace list (`workspaceColorAt`), so neighbouring
// islands never share a colour. Each pair is [light-theme, dark-theme]; hues are spread so neighbours differ.
import type { Scheme } from "./theme.ts";

const PAIRS: [string, string][] = [
  ["#2f6fdb", "#6ea2ff"],
  ["#d9480f", "#ff9a5c"],
  ["#2b9348", "#5fd68a"],
  ["#b43fd0", "#e08cf5"],
  ["#c9a000", "#f2cf4a"],
  ["#0e8f9f", "#4fd6e6"],
  ["#d6336c", "#ff82ab"],
  ["#5f3dc4", "#a78bfa"],
  ["#74812b", "#b9cc5a"],
  ["#a8461f", "#e8956b"],
  ["#1c7ed6", "#74c0fc"],
  ["#8a6d3b", "#d9b779"],
];

/** Colour for the workspace at `index` in the sorted workspace list. */
export function workspaceColorAt(index: number, scheme: Scheme): string {
  const pair = PAIRS[index % PAIRS.length] as [string, string];
  return scheme === "dark" ? pair[1] : pair[0];
}

/** Stable colour for a workspace id, independent of which other workspaces are shown. */
export function workspaceColor(id: string, scheme: Scheme = "light"): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return workspaceColorAt(h % PAIRS.length, scheme);
}
