// Turns the landscape's buildings into instanced meshes, one InstancedMesh per (part geometry, material). Each
// building is a body plus parts chosen by its type: roofs, a chimney, a crown, a dome, an awning, a porch. Every
// instance remembers which building it belongs to, so picking any part picks the file.
import * as THREE from "three";
import {
  awning,
  barrelRoof,
  church,
  cone,
  cylinder,
  dome,
  FACADES,
  type FacadeUniforms,
  facadeMaterial,
  gableRoof,
  portico,
  pyramidRoof,
  unitBox,
} from "./kit.ts";
import { color, type Look, mix, wsColor } from "./look.ts";
import type { Landscape, SBuilding } from "./model.ts";
import { hash01 } from "./rng.ts";
import type { Tier } from "./tiers.ts";

type PartKey =
  | "bodyHouse"
  | "bodyBlock"
  | "bodyTower"
  | "bodyHall"
  | "silo"
  | "gable"
  | "pyramid"
  | "barrel"
  | "cap"
  | "dome"
  | "rooftop"
  | "antenna"
  | "awning"
  | "portico"
  | "chimney";

interface Part {
  key: PartKey;
  /** Local offset (building frame: +Z is the front). */
  at: [number, number, number];
  scale: [number, number, number];
  /** Extra turn about Y in the building frame. */
  turn?: number;
  color: THREE.Color;
}

export interface Pickable {
  mesh: THREE.InstancedMesh;
  owner: Int32Array;
}

export interface BuiltBuildings {
  group: THREE.Group;
  pickables: Pickable[];
  /** World positions of chimney tops (smoke rises from some). */
  chimneys: THREE.Vector3[];
  /** World positions of the tallest tower tops (aviation lights). */
  beacons: THREE.Vector3[];
  /** Highest roof per settlement. */
  heights: number[];
  dispose(): void;
}

const CHIMNEY = "#8c5a46";

function partsFor(
  b: SBuilding,
  tier: Tier,
  look: Look,
  ws: THREE.Color,
): { parts: Part[]; top: number; chimney?: [number, number, number] } {
  const { w, d, h } = b;
  const hk = hash01(`look:${b.id}`);
  const tierWall = color(look.walls[tier]);
  // Walls: the tier's stone, a little of the workspace color, and a per-building shade so neighbors differ.
  const wall = mix(
    tierWall,
    ws,
    b.arch === "tower" ? 0.16 : b.arch === "block" || b.arch === "shopblock" ? 0.14 : 0.1,
  ).offsetHSL((hk - 0.5) * 0.04, 0, (hk - 0.5) * 0.14);
  const roof = mix(ws, look.night ? "#000000" : "#2b2b2b", 0.08 + hk * 0.3);
  const stone = color(look.stone);
  const parts: Part[] = [];
  let top = h;
  let chimney: [number, number, number] | undefined;
  const m = Math.min(w, d);
  switch (b.arch) {
    case "cottage":
    case "shop":
    case "house":
    case "barn": {
      parts.push({ key: "bodyHouse", at: [0, 0, 0], scale: [w, h, d], color: wall });
      const steep = b.arch === "barn" ? 0.85 : b.arch === "cottage" ? 0.62 : 0.5;
      const rh = m * steep;
      const pyramid = b.arch === "house" && hk > 0.55;
      parts.push({
        key: pyramid ? "pyramid" : "gable",
        at: [0, h, 0],
        scale: [w * 1.1, rh, d * 1.12],
        color: roof,
      });
      top = h + rh;
      if (b.arch !== "barn" && hk < 0.7) {
        chimney = [w * 0.27, h + rh * 0.35, -d * 0.18];
        parts.push({
          key: "chimney",
          at: chimney,
          scale: [0.16, rh * 0.75 + 0.1, 0.16],
          color: color(CHIMNEY),
        });
        chimney = [chimney[0], chimney[1] + rh * 0.75 + 0.1, chimney[2]];
      }
      break;
    }
    case "kiosk":
      parts.push({ key: "bodyHouse", at: [0, 0, 0], scale: [w, h, d], color: wall });
      parts.push({ key: "pyramid", at: [0, h, 0], scale: [w * 1.2, w * 0.75, d * 1.2], color: roof });
      top = h + w * 0.75;
      break;
    case "hall":
      parts.push({ key: "bodyHall", at: [0, 0, 0], scale: [w, h, d], color: wall });
      parts.push({
        key: "gable",
        at: [0, h, 0],
        scale: [d * 1.08, m * 0.45, w * 1.06],
        turn: Math.PI / 2,
        color: roof,
      });
      top = h + m * 0.45;
      break;
    case "station":
      parts.push({ key: "bodyBlock", at: [0, 0, 0], scale: [w, h, d], color: wall });
      parts.push({ key: "barrel", at: [0, h, 0], scale: [w, m * 0.35, d], color: roof });
      top = h + m * 0.35;
      break;
    case "block":
    case "shopblock": {
      parts.push({ key: "bodyBlock", at: [0, 0, 0], scale: [w, h, d], color: wall });
      if (b.floors > 6 && hk > 0.4) {
        parts.push({ key: "bodyBlock", at: [0, h, 0], scale: [w * 0.72, h * 0.14, d * 0.72], color: wall });
        top = h * 1.14;
      }
      parts.push({
        key: "rooftop",
        at: [w * 0.18, top, -d * 0.12],
        scale: [w * 0.3, 0.28, d * 0.28],
        color: roof,
      });
      top += 0.28;
      break;
    }
    case "tower": {
      parts.push({ key: "bodyTower", at: [0, 0, 0], scale: [w, h, d], color: wall });
      const ch = Math.max(0.6, h * 0.1);
      parts.push({ key: "bodyTower", at: [0, h, 0], scale: [w * 0.7, ch, d * 0.7], color: wall });
      top = h + ch;
      if (hk > 0.6) {
        parts.push({ key: "pyramid", at: [0, top, 0], scale: [w * 0.72, m * 0.5, d * 0.72], color: roof });
        top += m * 0.5;
      } else {
        parts.push({ key: "rooftop", at: [0, top, 0], scale: [w * 0.4, 0.3, d * 0.4], color: roof });
        top += 0.3;
      }
      if (b.size > 0.55) {
        const ah = Math.max(1, h * 0.16);
        parts.push({ key: "antenna", at: [0, top, 0], scale: [0.08, ah, 0.08], color: stone });
        top += ah;
      }
      break;
    }
    case "lab":
      parts.push({ key: "bodyHall", at: [0, 0, 0], scale: [w, h, d], color: wall });
      parts.push({
        key: "dome",
        at: [0, h, 0],
        scale: [m * 0.82, m * 0.82, m * 0.82],
        color: mix(ws, "#ffffff", 0.35),
      });
      top = h + m * 0.41;
      break;
    case "tank":
      parts.push({ key: "silo", at: [0, 0, 0], scale: [w, h, d], color: mix(ws, look.walls[tier], 0.55) });
      parts.push({ key: "cap", at: [0, h, 0], scale: [w * 1.08, w * 0.45, d * 1.08], color: roof });
      top = h + w * 0.45;
      break;
  }
  if (b.accent === "awning")
    parts.push({
      key: "awning",
      at: [0, Math.min(h, 0.42) * 0.82, d / 2],
      scale: [w, 1, 1],
      color: mix(ws, "#ffffff", look.night ? 0.1 : 0.15),
    });
  if (b.accent === "portico")
    parts.push({ key: "portico", at: [0, 0, d / 2], scale: [w * 0.92, Math.min(h, 1.4), 1], color: stone });
  return { parts, top, chimney };
}

export function buildBuildings(land: Landscape, look: Look, u: FacadeUniforms): BuiltBuildings {
  const group = new THREE.Group();
  const glass = color(look.glass);
  const lambert = () => new THREE.MeshLambertMaterial({ color: 0xffffff });
  const geos: Record<PartKey, () => THREE.BufferGeometry> = {
    bodyHouse: unitBox,
    bodyBlock: unitBox,
    bodyTower: unitBox,
    bodyHall: unitBox,
    silo: () => cylinder(14),
    gable: gableRoof,
    pyramid: pyramidRoof,
    barrel: barrelRoof,
    cap: () => cone(14),
    dome,
    rooftop: unitBox,
    antenna: () => cylinder(5),
    awning,
    portico,
    chimney: unitBox,
  };
  const mats: Record<PartKey, () => THREE.Material> = {
    bodyHouse: () => facadeMaterial(FACADES.house, u, glass),
    bodyBlock: () => facadeMaterial(FACADES.block, u, glass),
    bodyTower: () => facadeMaterial(FACADES.tower, u, mix(glass, "#9ec5ff", look.night ? 0.05 : 0.25)),
    bodyHall: () => facadeMaterial(FACADES.hall, u, glass),
    silo: lambert,
    gable: lambert,
    pyramid: lambert,
    barrel: lambert,
    cap: lambert,
    dome: lambert,
    rooftop: lambert,
    antenna: lambert,
    awning: lambert,
    portico: lambert,
    chimney: lambert,
  };
  const buckets = new Map<PartKey, { m: THREE.Matrix4; c: THREE.Color; owner: number }[]>();
  const chimneys: THREE.Vector3[] = [];
  const towers: { p: THREE.Vector3; h: number }[] = [];
  const heights = land.settlements.map(() => 0);
  const base = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  land.buildings.forEach((b, bi) => {
    const s = land.settlements[b.settlement];
    if (!s) return;
    const ws = wsColor(s.colorIndex, look);
    const { parts, top, chimney } = partsFor(b, s.tier, look, ws);
    heights[b.settlement] = Math.max(heights[b.settlement] as number, top);
    base.makeRotationY(b.rot).setPosition(b.x, 0, b.z);
    for (const p of parts) {
      q.setFromAxisAngle(up, p.turn ?? 0);
      local.compose(
        new THREE.Vector3(...p.at),
        q,
        new THREE.Vector3(...(p.scale.map((v) => Math.max(v, 0.01)) as [number, number, number])),
      );
      const m = base.clone().multiply(local);
      const list = buckets.get(p.key) ?? [];
      list.push({ m, c: p.color, owner: bi });
      buckets.set(p.key, list);
    }
    if (chimney && hash01(`smoke:${b.id}`) < 0.55)
      chimneys.push(new THREE.Vector3(...chimney).applyMatrix4(base));
    if (b.arch === "tower") towers.push({ p: new THREE.Vector3(0, top, 0).applyMatrix4(base), h: top });
  });

  const pickables: Pickable[] = [];
  const disposables: { dispose(): void }[] = [];
  for (const [key, list] of buckets) {
    const geo = geos[key]();
    const mat = mats[key]();
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const owner = new Int32Array(list.length);
    list.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      mesh.setColorAt(i, it.c);
      owner[i] = it.owner;
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Bounds from the instances, now that every matrix is set (a sphere computed earlier would cull them wrongly).
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.castShadow = key !== "awning" && key !== "antenna";
    mesh.receiveShadow = true;
    mesh.userData.part = key;
    group.add(mesh);
    pickables.push({ mesh, owner });
    disposables.push(geo, mat);
  }

  // Decor that is not a file: a church on each town's plaza (the town's landmark, named in the legend).
  const ch = church();
  const towns = land.settlements.filter((s) => s.tier === "town");
  if (towns.length > 0) {
    const walls = new THREE.InstancedMesh(ch.walls, facadeMaterial(FACADES.hall, u, glass), towns.length);
    const roofs = new THREE.InstancedMesh(ch.roof, lambert(), towns.length);
    towns.forEach((s, i) => {
      const k = Math.min(1, s.plan.plaza / 3.2) * 0.8;
      const m = new THREE.Matrix4().makeRotationY(hash01(`church:${s.id}`) * Math.PI * 2);
      m.scale(new THREE.Vector3(k, k, k)).setPosition(s.x, 0, s.z);
      walls.setMatrixAt(i, m);
      roofs.setMatrixAt(i, m);
      walls.setColorAt(i, color(look.walls.town));
      roofs.setColorAt(i, mix(wsColor(s.colorIndex, look), "#000000", 0.15));
      heights[land.settlements.indexOf(s)] = Math.max(
        heights[land.settlements.indexOf(s)] as number,
        5.9 * k,
      );
    });
    for (const im of [walls, roofs]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      im.userData.decor = "church";
      group.add(im);
      disposables.push(im.geometry, im.material as THREE.Material);
    }
  }

  // A low stone wall with round towers round each town, open where the roads come in.
  const wallSegs: THREE.Matrix4[] = [];
  const wallTowers: THREE.Matrix4[] = [];
  for (const s of towns) {
    const r = s.plan.radius - 0.55;
    const gates = land.roads
      .filter((rd) => rd.a === s.id || rd.b === s.id)
      .map((rd) => {
        const p = (rd.a === s.id ? rd.pts[0] : rd.pts[rd.pts.length - 1]) as [number, number];
        const q = (
          rd.a === s.id ? rd.pts[Math.min(3, rd.pts.length - 1)] : rd.pts[Math.max(0, rd.pts.length - 4)]
        ) as [number, number];
        // Where the road crosses the wall: walk out from the gate along the road.
        const ang = Math.atan2((p[1] + q[1]) / 2 - s.z, (p[0] + q[0]) / 2 - s.x);
        return { ang, half: (rd.width / 2 + 0.7) / r };
      });
    const nSeg = Math.max(24, Math.round((Math.PI * 2 * r) / 0.9));
    for (let k = 0; k < nSeg; k++) {
      const a = (k / nSeg) * Math.PI * 2;
      const open = gates.some((g) => Math.abs(Math.atan2(Math.sin(a - g.ang), Math.cos(a - g.ang))) < g.half);
      if (open) continue;
      const len = ((Math.PI * 2 * r) / nSeg) * 1.04;
      wallSegs.push(
        new THREE.Matrix4()
          .makeRotationY(-a)
          .scale(new THREE.Vector3(0.28, 0.55, len))
          .setPosition(s.x + Math.cos(a) * r, 0, s.z + Math.sin(a) * r),
      );
      if (k % Math.max(3, Math.round(nSeg / 8)) === 0)
        wallTowers.push(
          new THREE.Matrix4()
            .makeScale(0.6, 0.95, 0.6)
            .setPosition(s.x + Math.cos(a) * r, 0, s.z + Math.sin(a) * r),
        );
    }
  }
  if (wallSegs.length > 0) {
    const segGeo = unitBox();
    const towGeo = cylinder(10);
    const mat = lambert();
    for (const [geo, list] of [
      [segGeo, wallSegs],
      [towGeo, wallTowers],
    ] as const) {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      im.count = list.length;
      list.forEach((m, i) => {
        im.setMatrixAt(i, m);
        im.setColorAt(i, color(look.stone));
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      im.userData.decor = "wall";
      group.add(im);
      disposables.push(geo, im);
    }
    disposables.push(mat);
  }

  towers.sort((a, b) => b.h - a.h);
  const beacons = towers.slice(0, Math.max(3, Math.ceil(towers.length * 0.25))).map((t) => t.p);
  return {
    group,
    pickables,
    chimneys,
    beacons,
    heights,
    dispose: () => {
      for (const d of disposables) d.dispose();
      for (const p of pickables) p.mesh.dispose();
    },
  };
}
