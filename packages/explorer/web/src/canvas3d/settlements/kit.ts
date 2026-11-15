// The procedural building kit: unit geometries (base at y = 0, footprint 1 x 1, height 1) that every building is
// assembled from, and the materials, including the facade shader that draws windows and lights some of them.
// Everything is generated here: no models, no textures.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes))
    if (name !== "position" && name !== "normal") out.deleteAttribute(name);
  return out;
}

/** Merges geometries of any kind into one non-indexed geometry with positions and normals. */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(geos.map(plain), false);
  if (!g) throw new Error("merge failed");
  return g;
}

/** Box with its base at y = 0. */
export function unitBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return plain(g);
}

/** Gable roof: a triangular prism, ridge along X, base 1 x 1 at y = 0, apex at y = 1. */
export function gableRoof(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0);
  s.lineTo(0.5, 0);
  s.lineTo(0, 1);
  s.lineTo(-0.5, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  // The shape lies in XY (x across, y up), extruded along +Z: turn it so the ridge runs along X.
  g.translate(0, 0, -0.5);
  g.rotateY(Math.PI / 2);
  return plain(g);
}

/** Four-sided pyramid with a 1 x 1 base. */
export function pyramidRoof(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, 0.5, 0);
  return plain(g);
}

export function cylinder(segments = 12): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, segments);
  g.translate(0, 0.5, 0);
  return plain(g);
}

export function cone(segments = 12): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.5, 1, segments);
  g.translate(0, 0.5, 0);
  return plain(g);
}

export function dome(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.5, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  return plain(g);
}

/** Barrel roof (half cylinder), axis along X, base 1 x 1, height 1. */
export function barrelRoof(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, false, 0, Math.PI);
  // theta 0..PI is the x >= 0 half; turning about Z stands it up (y >= 0) with the axis along X.
  g.rotateZ(Math.PI / 2);
  g.scale(1, 2, 1);
  return plain(g);
}

/** A columned porch in front of the +Z face: four columns and a slab, 1 wide, 0.32 deep, 1 high. */
export function portico(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [-0.38, -0.13, 0.13, 0.38]) {
    const c = new THREE.CylinderGeometry(0.035, 0.035, 0.92, 6);
    c.translate(x, 0.46, 0.24);
    parts.push(c);
  }
  const slab = new THREE.BoxGeometry(1, 0.08, 0.34);
  slab.translate(0, 0.96, 0.17);
  parts.push(slab);
  return merge(parts);
}

/** Shop awning on the +Z face: a slanted strip. */
export function awning(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.92, 0.05, 0.34);
  g.rotateX(0.32);
  g.translate(0, 0, 0.17);
  return plain(g);
}

/** Car: body and cabin, 1 long (along +Z, the direction of travel), about 0.5 wide. */
export function carGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.5, 0.2, 1);
  body.translate(0, 0.16, 0);
  const cabin = new THREE.BoxGeometry(0.42, 0.17, 0.5);
  cabin.translate(0, 0.34, -0.06);
  return merge([body, cabin]);
}

export function truckGeometry(): THREE.BufferGeometry {
  const cab = new THREE.BoxGeometry(0.55, 0.42, 0.5);
  cab.translate(0, 0.27, 0.78);
  const box = new THREE.BoxGeometry(0.6, 0.6, 1.5);
  box.translate(0, 0.38, -0.25);
  return merge([cab, box]);
}

/** Head lights in front, tail lights behind (vertex colours), for the night scene. */
export function carLightsGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const colors: number[] = [];
  const add = (x: number, z: number, c: [number, number, number]) => {
    const g = plain(new THREE.BoxGeometry(0.1, 0.07, 0.04));
    g.translate(x, 0.18, z);
    parts.push(g);
    for (let i = 0; i < (g.getAttribute("position")?.count ?? 0); i++) colors.push(...c);
  };
  add(-0.17, 0.51, [1, 0.95, 0.7]);
  add(0.17, 0.51, [1, 0.95, 0.7]);
  add(-0.17, -0.51, [1, 0.15, 0.1]);
  add(0.17, -0.51, [1, 0.15, 0.1]);
  const g = merge(parts);
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

export function pineGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.06, 0.08, 0.35, 5);
  trunk.translate(0, 0.17, 0);
  const crown = new THREE.ConeGeometry(0.38, 1.0, 7);
  crown.translate(0, 0.8, 0);
  return merge([trunk, crown]);
}

export function oakGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.06, 0.08, 0.4, 5);
  trunk.translate(0, 0.2, 0);
  const crown = new THREE.IcosahedronGeometry(0.42, 0);
  crown.translate(0, 0.75, 0);
  return merge([trunk, crown]);
}

/** Windmill tower (static part): a tapered tower and a cap. */
export function windmillTower(): THREE.BufferGeometry {
  const tower = new THREE.CylinderGeometry(0.32, 0.55, 2.2, 8);
  tower.translate(0, 1.1, 0);
  const cap = new THREE.ConeGeometry(0.42, 0.6, 8);
  cap.translate(0, 2.5, 0);
  return merge([tower, cap]);
}

/** Four sails round the Z axis (they turn about Z), centred at the origin. */
export function windmillSails(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const s = new THREE.BoxGeometry(0.28, 1.5, 0.04);
    s.translate(0.06, 0.8, 0);
    s.rotateZ((k * Math.PI) / 2);
    parts.push(s);
  }
  return merge(parts);
}

/** Church: nave with a gable roof and a tower with a spire, about 3 long, 1.5 wide; spire top at about 5. */
export function church(): { walls: THREE.BufferGeometry; roof: THREE.BufferGeometry } {
  const nave = new THREE.BoxGeometry(1.4, 1.2, 2.6);
  nave.translate(0, 0.6, 0.2);
  const tower = new THREE.BoxGeometry(0.9, 2.6, 0.9);
  tower.translate(0, 1.3, -1.4);
  const roof = gableRoof();
  roof.rotateY(Math.PI / 2);
  roof.scale(1.55, 0.8, 2.75);
  roof.translate(0, 1.2, 0.2);
  const spire = new THREE.ConeGeometry(0.62, 2.2, 4);
  spire.rotateY(Math.PI / 4);
  spire.translate(0, 3.7, -1.4);
  return { walls: merge([nave, tower]), roof: merge([roof, spire]) };
}

/** Tower crane mast (static) and jib (turns about Y), unit-free: about 7 high. */
export function craneMast(): THREE.BufferGeometry {
  const mast = new THREE.BoxGeometry(0.3, 7, 0.3);
  mast.translate(0, 3.5, 0);
  const base = new THREE.BoxGeometry(0.9, 0.3, 0.9);
  base.translate(0, 0.15, 0);
  return merge([mast, base]);
}

export function craneJib(): THREE.BufferGeometry {
  const jib = new THREE.BoxGeometry(5.2, 0.22, 0.22);
  jib.translate(1.6, 0, 0);
  const counter = new THREE.BoxGeometry(0.7, 0.45, 0.45);
  counter.translate(-0.95, -0.1, 0);
  const cable = new THREE.BoxGeometry(0.03, 1.6, 0.03);
  cable.translate(3.4, -0.8, 0);
  const cab = new THREE.BoxGeometry(0.4, 0.35, 0.4);
  cab.translate(0, -0.25, 0);
  return merge([jib, counter, cable, cab]);
}

// ---------------------------------------------------------------------------------------------------------------
// Facade shader: windows on the side faces of instanced bodies, in floors, some lit. The lit set changes slowly over
// time (one window at a time, not a flicker). Windows read the instance's own scale so they keep their size.

export interface FacadeUniforms {
  uTime: { value: number };
  uNight: { value: number };
}

export interface FacadeStyle {
  /** Window spacing along the facade and per floor (world units). */
  cellW: number;
  cellH: number;
  /** Share of the cell that is glass, across and up. */
  glassW: number;
  glassH: number;
  /** How strongly the glass shows by day (0 = no windows). */
  amount: number;
  /** Share of windows lit at night. */
  lit: number;
  /** Height of the ground floor band without windows. */
  base: number;
}

export function facadeMaterial(
  style: FacadeStyle,
  u: FacadeUniforms,
  glass: THREE.Color,
): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uNight = u.uNight;
    shader.uniforms.uGlass = { value: glass };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec4 vWin;\nvarying vec3 vWinN;\nvarying float vWinH;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 wsc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vWin = vec4(position * wsc, float(gl_InstanceID));
  vWinH = wsc.y;
#else
  vWin = vec4(position, 0.0);
  vWinH = 1.0;
#endif
  vWinN = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec4 vWin;
varying vec3 vWinN;
varying float vWinH;
uniform float uTime;
uniform float uNight;
uniform vec3 uGlass;
float winHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  {
    float side = 1.0 - step(0.5, abs(vWinN.y));
    float u = abs(vWinN.x) > 0.5 ? vWin.z : vWin.x;
    vec2 cell = vec2(u / ${style.cellW.toFixed(3)}, (vWin.y - ${style.base.toFixed(3)}) / ${style.cellH.toFixed(3)});
    vec2 f = fract(cell);
    float gw = ${((1 - style.glassW) / 2).toFixed(3)};
    float gh = ${((1 - style.glassH) / 2).toFixed(3)};
    float win = step(gw, f.x) * step(f.x, 1.0 - gw) * step(gh, f.y) * step(f.y, 1.0 - gh);
    win *= step(0.0, cell.y) * step(vWin.y, vWinH - 0.12) * side;
    vec3 id = vec3(floor(cell), floor(vWin.w + 0.5) + floor(vWinN.x * 2.0 + vWinN.z * 3.0 + 0.5) * 17.0);
    float slot = floor(uTime / 7.0 + winHash(id) * 9.0);
    float lit = step(1.0 - ${style.lit.toFixed(3)}, winHash(id + vec3(slot * 0.37, slot * 1.13, 0.0)));
    float amt = ${style.amount.toFixed(3)};
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(uGlass, vec3(1.0, 0.86, 0.55), lit * uNight * 0.6), win * amt);
    totalEmissiveRadiance += win * lit * uNight * vec3(1.0, 0.78, 0.42) * 0.85 * max(amt, 0.6);
  }`,
      );
  };
  // Every facade style compiles its own program.
  m.customProgramCacheKey = () =>
    `facade:${style.cellW}:${style.cellH}:${style.glassW}:${style.glassH}:${style.amount}:${style.lit}:${style.base}`;
  return m;
}

export const FACADES: Record<"house" | "block" | "tower" | "hall", FacadeStyle> = {
  house: { cellW: 0.55, cellH: 0.42, glassW: 0.38, glassH: 0.42, amount: 0.75, lit: 0.45, base: 0.08 },
  block: { cellW: 0.42, cellH: 0.42, glassW: 0.5, glassH: 0.5, amount: 0.8, lit: 0.4, base: 0.3 },
  tower: { cellW: 0.3, cellH: 0.42, glassW: 0.72, glassH: 0.62, amount: 0.9, lit: 0.35, base: 0.42 },
  hall: { cellW: 0.5, cellH: 0.7, glassW: 0.34, glassH: 0.6, amount: 0.65, lit: 0.5, base: 0.15 },
};

/**
 * Dashes along a curve: pieces `dash` long with `gap` between them (world units), each a short curve of its own. At
 * least one piece, so a very short arc still shows.
 */
export function dashesOf(
  curve: THREE.Curve<THREE.Vector3>,
  dash: number,
  gap: number,
): THREE.Curve<THREE.Vector3>[] {
  const len = curve.getLength();
  const step = dash + gap;
  const n = Math.max(1, Math.floor((len + gap) / step));
  const out: THREE.Curve<THREE.Vector3>[] = [];
  for (let k = 0; k < n; k++) {
    const u0 = (k * step) / len;
    const u1 = Math.min(1, (k * step + dash) / len);
    const pts = [0, 0.5, 1].map((t) => curve.getPointAt(Math.min(1, u0 + (u1 - u0) * t)));
    out.push(new THREE.CatmullRomCurve3(pts));
  }
  return out;
}
