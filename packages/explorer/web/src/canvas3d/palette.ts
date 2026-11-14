// Scene colours for the 3D map. Workspace colours come from the shared ../workspacePalette.ts.
import type { Scheme } from "../theme.ts";

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
