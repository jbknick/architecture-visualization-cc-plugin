// Colors of the landscape, by day (light theme) and by night (dark theme).
import * as THREE from "three";
import type { Scheme } from "../../theme.ts";
import { workspaceColorAt } from "../../workspacePalette.ts";
import type { Tier } from "./tiers.ts";

export interface Look {
  scheme: Scheme;
  night: boolean;
  sky: string;
  ground: string;
  plate: Record<Tier, string>;
  walls: Record<Tier, string>;
  glass: string;
  asphalt: string;
  highway: string;
  street: string;
  lane: string;
  median: string;
  marking: string;
  chevron: string;
  fields: string[];
  pine: string;
  oak: string;
  stone: string;
  people: string[];
  paints: string[];
  ambient: number;
  sun: number;
  hemiSky: string;
  hemiGround: string;
}

export function lookFor(scheme: Scheme): Look {
  if (scheme === "dark")
    return {
      scheme,
      night: true,
      sky: "#0d1420",
      ground: "#25332f",
      plate: { village: "#2c4227", town: "#443d33", city: "#3a404b", metropolis: "#343a44" },
      walls: { village: "#c9bba0", town: "#bfae95", city: "#9aa1ad", metropolis: "#8691a3" },
      glass: "#1a2333",
      asphalt: "#434a56",
      highway: "#4a5260",
      street: "#3e4550",
      lane: "#6a5d45",
      median: "#2c4527",
      marking: "#c9c39a",
      chevron: "#ffd45a",
      fields: ["#33421f", "#3d3a1d", "#2a3b22", "#43401f", "#2f3d1c"],
      pine: "#1f3b26",
      oak: "#2b4a26",
      stone: "#7d7a72",
      people: ["#ffd8a8", "#a5d8ff", "#ffc9c9", "#d0bfff"],
      paints: ["#ff6b6b", "#ffd43b", "#74c0fc", "#f8f9fa", "#63e6be", "#ffa94d", "#e599f7"],
      ambient: 0.8,
      sun: 0.9,
      hemiSky: "#7d8fbf",
      hemiGround: "#2a3028",
    };
  return {
    scheme,
    night: false,
    sky: "#dfe7ee",
    ground: "#cbd9bd",
    plate: { village: "#b7d29a", town: "#e4d8bd", city: "#cdd0d5", metropolis: "#b9bdc4" },
    walls: { village: "#f4ead6", town: "#eedfc8", city: "#e1e3e8", metropolis: "#d3d8e0" },
    glass: "#5b6b82",
    asphalt: "#6b7078",
    highway: "#5a5f68",
    street: "#8a8f97",
    lane: "#c8b48e",
    median: "#9cc07c",
    marking: "#ffffff",
    chevron: "#ffe066",
    fields: ["#d9c96a", "#a9cc72", "#e3d48a", "#93bf6a", "#cfd98a"],
    pine: "#3f7a4a",
    oak: "#5d9a4c",
    stone: "#b8b2a6",
    people: ["#c92a2a", "#1864ab", "#e67700", "#5f3dc4", "#2b8a3e"],
    paints: ["#e03131", "#1971c2", "#f8f9fa", "#343a40", "#f08c00", "#2f9e44", "#ae3ec9"],
    ambient: 0.75,
    sun: 1.9,
    hemiSky: "#ffffff",
    hemiGround: "#8d9a7c",
  };
}

export const color = (c: string): THREE.Color => new THREE.Color(c);

/** The workspace's color, as the 2D map draws it. */
export function wsColor(index: number, look: Look): THREE.Color {
  return color(workspaceColorAt(index, look.scheme));
}

export function mix(a: THREE.Color | string, b: THREE.Color | string, t: number): THREE.Color {
  const ca = typeof a === "string" ? color(a) : a.clone();
  return ca.lerp(typeof b === "string" ? color(b) : b, t);
}
