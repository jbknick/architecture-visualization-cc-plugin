// Flat things on the ground, as vertex-colored triangle soups: the land, each settlement's plate (districts tinted,
// plaza, streets, fields, the kerb in the workspace's color) and each road (asphalt, median, markings, and the
// chevrons that point from the importer to the imported settlement).
import * as THREE from "three";
import { color, type Look, mix, wsColor } from "./look.ts";
import type { Landscape, Settlement } from "./model.ts";
import { makePath, type Pt, sampleAt } from "./path.ts";
import type { Street } from "./plan.ts";
import { rngFor } from "./rng.ts";
import { LANE_OFFSETS, type Road } from "./roads.ts";

/** Heights of the ground layers (world units), so they never fight in the depth buffer. */
export const Y = {
  plate: 0.03,
  district: 0.05,
  field: 0.05,
  plaza: 0.06,
  kerb: 0.07,
  street: 0.08,
  road: 0.1,
  mark: 0.13,
};

class Painter {
  pos: number[] = [];
  col: number[] = [];
  tri(a: Pt, b: Pt, c: Pt, y: number, k: THREE.Color): void {
    // Counter-clockwise seen from above (+Y) so the face points up.
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const [p, q] = cross > 0 ? [c, b] : [b, c];
    this.pos.push(a[0], y, a[1], p[0], y, p[1], q[0], y, q[1]);
    for (let i = 0; i < 3; i++) this.col.push(k.r, k.g, k.b);
  }
  quad(a: Pt, b: Pt, c: Pt, d: Pt, y: number, k: THREE.Color): void {
    this.tri(a, b, c, y, k);
    this.tri(a, c, d, y, k);
  }
  /** A strip along `pts`, `width` wide, its center `offset` to the right of the direction of the points. */
  ribbon(pts: readonly Pt[], width: number, y: number, k: THREE.Color, offset = 0): void {
    const n = pts.length;
    if (n < 2) return;
    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)] as Pt;
      const b = pts[Math.min(n - 1, i + 1)] as Pt;
      let dx = b[0] - a[0];
      let dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const p = pts[i] as Pt;
      // Right of travel: (-dz, dx).
      const cx = p[0] - dz * offset;
      const cz = p[1] + dx * offset;
      left.push([cx + dz * (width / 2), cz - dx * (width / 2)]);
      right.push([cx - dz * (width / 2), cz + dx * (width / 2)]);
    }
    for (let i = 0; i < n - 1; i++)
      this.quad(left[i] as Pt, right[i] as Pt, right[i + 1] as Pt, left[i + 1] as Pt, y, k);
  }
  /** Dashes along a polyline. */
  dashes(
    pts: readonly Pt[],
    width: number,
    y: number,
    k: THREE.Color,
    offset: number,
    dash: number,
    gap: number,
  ): void {
    const path = makePath(pts);
    for (let s = gap / 2; s + dash < path.length; s += dash + gap) {
      const a = sampleAt(path, s, offset);
      const b = sampleAt(path, s + dash, offset);
      this.ribbon(
        [
          [a.x, a.z],
          [b.x, b.z],
        ],
        width,
        y,
        k,
      );
    }
  }
  sector(
    cx: number,
    cz: number,
    r0: number,
    r1: number,
    a0: number,
    a1: number,
    y: number,
    k: THREE.Color,
  ): void {
    const n = Math.max(3, Math.ceil(((a1 - a0) * Math.max(r1, 1)) / 0.8));
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      const p = (r: number, t: number): Pt => [cx + Math.cos(t) * r, cz + Math.sin(t) * r];
      if (r0 <= 0.001) this.tri([cx, cz], p(r1, t0), p(r1, t1), y, k);
      else this.quad(p(r0, t0), p(r1, t0), p(r1, t1), p(r0, t1), y, k);
    }
  }
  /** A closed outline filled as a fan from (cx, cz). */
  fan(cx: number, cz: number, ring: readonly Pt[], y: number, k: THREE.Color): void {
    for (let i = 0; i < ring.length; i++)
      this.tri([cx, cz], ring[i] as Pt, ring[(i + 1) % ring.length] as Pt, y, k);
  }
  mesh(material: THREE.Material): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    const normals = new Float32Array(this.pos.length);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = true;
    return m;
  }
}

/** The plate outline: a circle, ragged for a village (seeded). */
export function plateOutline(s: Settlement): Pt[] {
  const r = s.clear;
  const n = 72;
  const rnd = rngFor(`plate:${s.id}`);
  const wob = s.tier === "village" ? 0.09 : 0;
  const ph = [rnd() * 6.28, rnd() * 6.28];
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const k =
      1 + wob * (Math.sin(3 * t + (ph[0] as number)) * 0.6 + Math.sin(5 * t + (ph[1] as number)) * 0.4);
    out.push([s.x + Math.cos(t) * r * k, s.z + Math.sin(t) * r * k]);
  }
  return out;
}

function streetColor(st: Street, look: Look): THREE.Color {
  return color(st.kind === "lane" ? look.lane : look.street);
}

export function settlementGround(s: Settlement, look: Look, material: THREE.Material): THREE.Mesh {
  const p = new Painter();
  const plate = color(look.plate[s.tier]);
  const ws = wsColor(s.colorIndex, look);
  const outline = plateOutline(s);
  p.fan(s.x, s.z, outline, Y.plate, plate);
  // Kerb: a band in the workspace color round the plate.
  const kerbW = Math.max(0.45, s.clear * 0.018);
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i] as Pt;
    const b = outline[(i + 1) % outline.length] as Pt;
    const inward = (q: Pt): Pt => {
      const dx = s.x - q[0];
      const dz = s.z - q[1];
      const l = Math.hypot(dx, dz) || 1;
      return [q[0] + (dx / l) * kerbW, q[1] + (dz / l) * kerbW];
    };
    p.quad(a, b, inward(b), inward(a), Y.kerb, ws);
  }
  // Districts: alternate shades of the plate, each tinted a little towards the workspace color.
  s.districts.forEach((d, k) => {
    const shade = mix(
      plate,
      k % 2 === 0 ? (look.night ? "#000000" : "#ffffff") : ws,
      k % 2 === 0 ? 0.12 : 0.1,
    );
    p.sector(s.x, s.z, Math.max(0, d.r0 - 0.2), d.r1 + 0.2, d.a0, d.a1, Y.district, shade);
  });
  // Fields round villages and towns.
  const fieldCols = look.fields.map(color);
  for (const f of s.plan.fields) {
    const k = fieldCols[Math.floor(f.hue * fieldCols.length) % fieldCols.length] as THREE.Color;
    p.sector(s.x, s.z, f.r0, f.r1, f.a0, f.a1, Y.field, k);
    // Furrows: darker stripes across the field.
    const dark = mix(k, look.night ? "#000000" : "#5c4a1e", 0.18);
    const rows = Math.max(2, Math.floor((f.r1 - f.r0) / 0.5));
    for (let i = 1; i < rows; i += 2) {
      const r0 = f.r0 + ((f.r1 - f.r0) * i) / rows;
      p.sector(s.x, s.z, r0, r0 + 0.12, f.a0 + 0.02, f.a1 - 0.02, Y.field + 0.005, dark);
    }
  }
  // Plaza: paving, or the village green with a pond.
  const plaza = s.plan.plaza;
  if (s.tier === "village") {
    p.sector(
      s.x,
      s.z,
      0,
      plaza - 0.2,
      0,
      Math.PI * 2,
      Y.plaza,
      mix(plate, "#7fbf5f", look.night ? 0.1 : 0.35),
    );
    p.sector(
      s.x + plaza * 0.35,
      s.z - plaza * 0.3,
      0,
      plaza * 0.25,
      0,
      Math.PI * 2,
      Y.plaza + 0.005,
      color(look.night ? "#1b3550" : "#7fb7e0"),
    );
  } else p.sector(s.x, s.z, 0, plaza - 0.1, 0, Math.PI * 2, Y.plaza, mix(color(look.stone), plate, 0.3));
  for (const st of s.plan.streets) {
    const pts = st.pts.map((q) => [s.x + q[0], s.z + q[1]] as Pt);
    p.ribbon(pts, st.width, Y.street, streetColor(st, look));
    if (st.kind === "ring" && st.width >= 1)
      p.dashes(pts, 0.06, Y.street + 0.01, mix(look.marking, look.street, 0.35), 0, 0.5, 0.7);
  }
  const m = p.mesh(material);
  m.userData.settlement = s.id;
  return m;
}

export function roadGround(road: Road, look: Look, material: THREE.Material): THREE.Mesh {
  const p = new Painter();
  const pts = road.pts;
  const mark = color(look.marking);
  if (road.declaredOnly) {
    p.dashes(pts, 0.35, Y.road, color(look.stone), 0, 0.5, 0.6);
  } else if (road.cls === "lane") {
    p.ribbon(pts, road.width, Y.road, color(look.lane));
  } else if (road.cls === "road") {
    p.ribbon(pts, road.width + 0.2, Y.road - 0.005, mix(look.asphalt, look.ground, 0.5));
    p.ribbon(pts, road.width, Y.road, color(look.asphalt));
    p.dashes(pts, 0.07, Y.mark, mark, 0, 0.6, 0.6);
  } else {
    const off = ((LANE_OFFSETS.highway[0] as number) + (LANE_OFFSETS.highway[1] as number)) / 2;
    const cw = 1.45;
    p.ribbon(pts, road.width + 0.3, Y.road - 0.005, mix(look.highway, look.ground, 0.55));
    p.ribbon(pts, 2 * off - cw, Y.road, color(look.median));
    for (const side of [1, -1]) {
      p.ribbon(pts, cw, Y.road, color(look.highway), side * off);
      p.dashes(pts, 0.07, Y.mark, mark, side * off, 0.7, 0.7);
      p.ribbon(pts, 0.06, Y.mark, mix(look.marking, look.highway, 0.2), side * (off + cw / 2 - 0.08));
      p.ribbon(pts, 0.06, Y.mark, mix(look.marking, look.highway, 0.2), side * (off - cw / 2 + 0.08));
    }
  }
  // Chevrons in each flow's lane, pointing the way the traffic goes (importer -> imported).
  if (!road.declaredOnly) {
    const chev = color(look.chevron);
    const fwd = makePath(pts);
    const back = makePath([...pts].reverse());
    const spacing = road.cls === "highway" ? 6 : road.cls === "road" ? 5 : 4.5;
    const size = road.cls === "highway" ? 0.55 : road.cls === "road" ? 0.42 : 0.3;
    for (const f of road.flows) {
      const path = f.forward ? fwd : back;
      const offs = LANE_OFFSETS[road.cls];
      const o =
        road.cls === "highway" ? ((offs[0] as number) + (offs[1] as number)) / 2 : (offs[0] as number);
      for (let s = spacing * 0.75; s < path.length - spacing * 0.5; s += spacing) {
        const c = sampleAt(path, s, o);
        const nx = -c.dz;
        const nz = c.dx;
        const tip: Pt = [c.x + c.dx * size, c.z + c.dz * size];
        const l: Pt = [
          c.x - c.dx * size * 0.4 + nx * size * 0.75,
          c.z - c.dz * size * 0.4 + nz * size * 0.75,
        ];
        const r: Pt = [
          c.x - c.dx * size * 0.4 - nx * size * 0.75,
          c.z - c.dz * size * 0.4 - nz * size * 0.75,
        ];
        const notch: Pt = [c.x + c.dx * size * 0.1, c.z + c.dz * size * 0.1];
        p.tri(tip, l, notch, Y.mark + 0.005, chev);
        p.tri(tip, notch, r, Y.mark + 0.005, chev);
      }
    }
  }
  const m = p.mesh(material);
  m.userData.road = road.key;
  return m;
}

export function landGround(land: Landscape, look: Look): THREE.Mesh {
  const size = land.extent * 12;
  const g = new THREE.CircleGeometry(size, 64);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: color(look.ground) }));
  m.receiveShadow = true;
  return m;
}
