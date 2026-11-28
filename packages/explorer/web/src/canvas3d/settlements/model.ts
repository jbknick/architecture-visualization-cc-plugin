// The settlements landscape as plain data: no three.js, no DOM, no Math.random. Built from the same `Scene` the 2D
// project map draws (files level), so every count shown comes from the API's own numbers.
import { kindTier, TIER_FILE, type TreeNode } from "../../canvas/hierarchy.ts";
import { nodeTitle, type Scene } from "../../canvas/scene.ts";
import { isRootWorkspaceId, pathOfFileId } from "../../ids.ts";
import { placeSettlements } from "./placement.ts";
import { PLAN_PARAMS, type Plan, planSettlement } from "./plan.ts";
import { hash01 } from "./rng.ts";
import { buildRoads, type Road } from "./roads.ts";
import { type Role, roleOf } from "./roles.ts";
import { assignTiers, type Tier } from "./tiers.ts";

export type Archetype =
  | "cottage"
  | "house"
  | "barn"
  | "shop"
  | "hall"
  | "block"
  | "shopblock"
  | "tower"
  | "station"
  | "lab"
  | "tank"
  | "kiosk";

export const FLOOR_H = 0.42;

export interface SBuilding {
  id: string;
  path: string;
  label: string;
  fns: number;
  loc: number | null;
  role: Role;
  arch: Archetype;
  accent: Accent;
  settlement: number;
  district: string;
  x: number;
  z: number;
  rot: number;
  /** Footprint (local X, local Z) and body height. */
  w: number;
  d: number;
  h: number;
  floors: number;
  /** 0..1: size within the repo (the height scale's input). */
  size: number;
}

export interface SDistrict {
  key: string;
  title: string;
  path: string;
  fns: number;
  files: number;
  a0: number;
  a1: number;
  r0: number;
  r1: number;
}

export interface Settlement {
  id: string;
  idx: number;
  title: string;
  fullTitle: string;
  kind: string;
  tier: Tier;
  fns: number;
  files: number;
  /** Palette index: position among the workspaces sorted by id (the 2D map's colors). */
  colorIndex: number;
  x: number;
  z: number;
  plan: Plan;
  buildings: number[];
  districts: SDistrict[];
  gate: number;
  clear: number;
  path: string;
}

export interface Landscape {
  settlements: Settlement[];
  buildings: SBuilding[];
  roads: Road[];
  /** Half-size of the land (world units). */
  extent: number;
  byId: Map<string, { type: "settlement" | "building"; i: number }>;
}

const SIDE: Record<Tier, [number, number]> = {
  village: [0.95, 1.5],
  town: [0.95, 1.75],
  city: [1.3, 2.4],
  metropolis: [1.4, 3.0],
};
const FLOORS: Record<Tier, [number, number]> = {
  village: [1, 2],
  town: [1, 3],
  city: [3, 14],
  metropolis: [3, 52],
};

/** The tier's ordinary building for a file of this size: the settlement's silhouette. */
function bodyFor(tier: Tier, size: number): Archetype {
  if (tier === "village") return "cottage";
  if (tier === "town") return "house";
  if (tier === "city") return size < 0.08 ? "house" : "block";
  return size >= 0.3 ? "tower" : size < 0.1 ? "house" : "block";
}

/**
 * Picks the building type from the settlement's tier, the file's role and its size (0..1). Small special files get
 * their own shapes (lab, water tower, kiosk, station hall, shop); big ones keep the tier's body so the skyline stays
 * the tier's, and show their role as an accent instead (see `accentFor`).
 */
export function archetypeFor(tier: Tier, role: Role, size: number): Archetype {
  if (role === "test") return "lab";
  if (role === "config") return "tank";
  if (role === "entry" && size < 0.2) return "kiosk";
  if (role === "route") {
    if (tier === "village") return "barn";
    if (tier === "town") return "hall";
    if (size < 0.25) return "station";
  }
  if (role === "component") {
    if (tier === "village" || tier === "town") return "shop";
    if (size < 0.3) return "shopblock";
  }
  return bodyFor(tier, size);
}

export type Accent = "awning" | "portico" | null;

/** Role accents on the tier's body: a shop awning for components, a columned porch for routes. */
export function accentFor(arch: Archetype, role: Role): Accent {
  if (arch === "shop" || arch === "shopblock") return "awning";
  if (arch === "hall" || arch === "station") return "portico";
  if (arch === "tower" || arch === "block" || arch === "house" || arch === "cottage")
    return role === "component" ? "awning" : role === "route" ? "portico" : null;
  return null;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] as number;
}

/** Strips the folders every file of a workspace shares (`src/`), then takes the first one left: the district. */
export function districtKeys(relDirs: readonly string[]): string[] {
  const split = relDirs.map((d) => (d === "" || d === "." ? [] : d.split("/")));
  let common = 0;
  const withDirs = split.filter((s) => s.length > 0);
  if (withDirs.length === split.length && withDirs.length > 0) {
    const first = withDirs[0] as string[];
    while (common < first.length && withDirs.every((s) => s[common] === first[common])) common++;
    // Keep at least one level when every file sits in the same folder chain.
    if (withDirs.every((s) => s.length === common)) common = Math.max(0, common - 1);
  }
  return split.map((s) =>
    s.length > common ? s.slice(0, common + 1).join("/") : s.length ? s.join("/") : ".",
  );
}

export interface LandscapeOptions {
  showDeclared?: boolean;
}

export function buildLandscape(scene: Scene, opts: LandscapeOptions = {}): Landscape {
  const { tree } = scene;
  const roots = scene.roots.filter((r) => scene.nodes[r]);
  const fnsOf = new Map<string, number>();
  for (const r of roots) fnsOf.set((tree.nodes[r] as TreeNode).id, scene.functions[r] ?? 0);
  const tiers = assignTiers(fnsOf);

  // Files per workspace.
  const filesOf = new Map<number, number[]>();
  tree.nodes.forEach((n, i) => {
    if (kindTier(n.kind) !== TIER_FILE) return;
    filesOf.set(n.root, [...(filesOf.get(n.root) ?? []), i]);
  });
  const allFns = [...filesOf.values()].flat().map((i) => scene.functions[i] ?? 0);
  const allLoc = [...filesOf.values()].flat().map((i) => scene.nodes[i]?.stats?.loc ?? 0);
  const fnCap = Math.max(
    8,
    quantile(
      [...allFns].sort((a, b) => a - b),
      0.97,
    ),
  );
  const locCap = Math.max(
    60,
    quantile(
      [...allLoc].sort((a, b) => a - b),
      0.97,
    ),
  );

  const settlements: Settlement[] = [];
  const buildings: SBuilding[] = [];
  const byId = new Map<string, { type: "settlement" | "building"; i: number }>();

  for (const r of roots) {
    const node = scene.nodes[r];
    if (!node) continue;
    const id = node.id;
    const tier = tiers.get(id) ?? "village";
    const wsPath = node.path && node.path !== "." ? node.path : "";
    const files = filesOf.get(r) ?? [];
    const rel = files.map((i) => {
      const p = scene.nodes[i]?.path ?? pathOfFileId((tree.nodes[i] as TreeNode).id);
      const inWs = wsPath && p.startsWith(`${wsPath}/`) ? p.slice(wsPath.length + 1) : p;
      const cut = inWs.lastIndexOf("/");
      return { i, p, inWs, dir: cut >= 0 ? inWs.slice(0, cut) : "" };
    });
    const keys = districtKeys(rel.map((x) => x.dir));
    const [s0, s1] = SIDE[tier];
    const [f0, f1] = FLOORS[tier];
    const lotInputs: { id: string; district: string; side: number }[] = [];
    const draft = new Map<string, Omit<SBuilding, "x" | "z" | "rot" | "settlement">>();
    rel.forEach((f, k) => {
      const n = scene.nodes[f.i];
      const fileId = (tree.nodes[f.i] as TreeNode).id;
      const fns = scene.functions[f.i] ?? 0;
      const loc = n?.stats?.loc ?? null;
      const fn01 = Math.min(1, fns / fnCap);
      const loc01 = loc !== null ? Math.min(1, loc / locCap) : fn01;
      const size = Math.max(fn01, loc01 * 0.9);
      const role = roleOf(f.inWs);
      const arch = archetypeFor(tier, role, size);
      const jitter = hash01(`size:${fileId}`);
      let side = s0 + (s1 - s0) * Math.sqrt(loc01 * 0.6 + fn01 * 0.4) + (jitter - 0.5) * 0.12;
      let floors =
        (f0 + (f1 - f0) * (tier === "metropolis" ? fn01 ** 1.4 : fn01 ** 0.8)) *
        (0.88 + 0.24 * hash01(`floors:${fileId}`));
      let w = side;
      let d = side * (0.72 + 0.28 * hash01(`aspect:${fileId}`));
      switch (arch) {
        case "tank":
          w = d = Math.min(side, 1.2);
          floors = Math.max(3, Math.min(6, floors + 2));
          break;
        case "kiosk":
          w = d = side * 0.7;
          floors = 1;
          break;
        case "lab":
          w = side;
          d = side;
          floors = Math.max(1, Math.min(floors, 4));
          break;
        case "hall":
        case "barn":
          w = side * 1.15;
          d = side * 0.85;
          floors = Math.max(1.6, Math.min(3, floors + 0.6));
          break;
        case "station":
          w = side * 1.2;
          d = side * 0.8;
          floors = Math.max(1.5, Math.min(4, floors * 0.4 + 1));
          break;
        case "house":
          floors = tier === "metropolis" || tier === "city" ? 1 + fn01 * 4 : floors;
          side = Math.min(side, 1.6);
          w = Math.min(w, 1.6);
          d = Math.min(d, 1.5);
          break;
        default:
          break;
      }
      side = Math.max(w, d);
      lotInputs.push({ id: fileId, district: keys[k] as string, side });
      draft.set(fileId, {
        id: fileId,
        path: f.p,
        label: n?.label ?? f.p.slice(f.p.lastIndexOf("/") + 1),
        fns,
        loc,
        role,
        arch,
        accent: accentFor(arch, role),
        district: keys[k] as string,
        w,
        d,
        h: Math.max(0.5, floors) * FLOOR_H,
        floors,
        size,
      });
    });
    const plan = planSettlement(lotInputs, tier, id);
    const idx = settlements.length;
    const bIdx: number[] = [];
    for (const lot of plan.lots) {
      const b = draft.get(lot.id);
      if (!b) continue;
      byId.set(b.id, { type: "building", i: buildings.length });
      bIdx.push(buildings.length);
      buildings.push({ ...b, x: lot.x, z: lot.z, rot: lot.rot, settlement: idx });
    }
    // Districts: wedge geometry from the plan, counts summed over the files in them.
    const districts: SDistrict[] = plan.districts.map((da) => {
      const inIt = bIdx.map((bi) => buildings[bi] as SBuilding).filter((b) => b.district === da.id);
      return {
        key: da.id,
        title: da.id === "." ? "(root files)" : (da.id.split("/").pop() ?? da.id),
        path: wsPath ? (da.id === "." ? wsPath : `${wsPath}/${da.id}`) : da.id,
        fns: inIt.reduce((s, b) => s + b.fns, 0),
        files: inIt.length,
        a0: da.a0,
        a1: da.a1,
        r0: da.r0,
        r1: da.r1,
      };
    });
    const street = PLAN_PARAMS[tier].street;
    byId.set(id, { type: "settlement", i: idx });
    settlements.push({
      id,
      idx: r,
      title: nodeTitle(scene, r),
      fullTitle: node.label,
      kind: isRootWorkspaceId(id) ? "(repo root)" : (node.badges?.[0] ?? "package"),
      tier,
      fns: scene.functions[r] ?? 0,
      files: scene.files[r] ?? 0,
      colorIndex: scene.rootRank.get(r) ?? 0,
      x: 0,
      z: 0,
      plan,
      buildings: bIdx,
      districts,
      gate: tier === "village" ? plan.built + street * 0.2 : plan.built + street / 2,
      clear: plan.radius,
      path: node.path ?? "",
    });
  }

  // Links between workspaces, the 2D map's own (`wsEdges`): the counts on the roads are the 2D map's counts.
  const links = scene.wsEdges.map((e) => ({
    src: (tree.nodes[e.src] as TreeNode).id,
    dst: (tree.nodes[e.dst] as TreeNode).id,
    weight: e.weight,
    declaredOnly: e.declaredOnly,
  }));
  const placed = placeSettlements(
    settlements.map((s) => ({ id: s.id, radius: s.clear })),
    links.filter((l) => !l.declaredOnly).map((l) => ({ a: l.src, b: l.dst, weight: l.weight })),
  );
  const pos = new Map(placed.map((p) => [p.id, p]));
  for (const s of settlements) {
    const p = pos.get(s.id);
    if (!p) continue;
    s.x = p.x;
    s.z = p.z;
    for (const bi of s.buildings) {
      const b = buildings[bi] as SBuilding;
      b.x += s.x;
      b.z += s.z;
    }
  }
  const roads = buildRoads(
    settlements.map((s) => ({ id: s.id, x: s.x, z: s.z, gate: s.gate, clear: s.clear })),
    links,
    { showDeclared: opts.showDeclared },
  );
  let extent = 10;
  for (const s of settlements) extent = Math.max(extent, Math.abs(s.x) + s.clear, Math.abs(s.z) + s.clear);
  for (const r of roads)
    for (const p of r.pts) extent = Math.max(extent, Math.abs(p[0]) + 2, Math.abs(p[1]) + 2);
  return { settlements, buildings, roads, extent, byId };
}

/** Folder title for a building's district (kept for tooltips). */
export function districtOf(l: Landscape, b: SBuilding): SDistrict | undefined {
  return l.settlements[b.settlement]?.districts.find((d) => d.key === b.district);
}
