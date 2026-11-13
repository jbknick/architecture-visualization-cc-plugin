// Workspace colours for the 3D map. Index = position in the sorted workspace list, so a repo always gets the
// same colours. Each pair is [light-theme, dark-theme]; hues are spread so neighbours stay distinguishable.
import type { Scheme } from "../theme.ts";

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

export function workspaceColor(index: number, scheme: Scheme): string {
  const pair = PAIRS[index % PAIRS.length] as [string, string];
  return scheme === "dark" ? pair[1] : pair[0];
}

export interface SceneTheme {
  background: string;
  labelText: string;
  labelBg: string;
  faintLink: string;
}

export function sceneTheme(scheme: Scheme): SceneTheme {
  return scheme === "dark"
    ? { background: "#0b0e14", labelText: "#f3f5f9", labelBg: "rgba(11,14,20,0.72)", faintLink: "#9aa5b8" }
    : {
        background: "#eef0f5",
        labelText: "#12151c",
        labelBg: "rgba(238,240,245,0.78)",
        faintLink: "#5b6578",
      };
}
