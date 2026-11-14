// The three.js side of the code city. Districts, plinths and buildings are InstancedMeshes (about a thousand boxes
// stay smooth); import arches are tubes; text is DOM in an overlay placed in screen space after every camera change
// (district titles, folder captions, count pills, numbered flags), so it stays crisp and a constant size.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { RankedFile } from "../../rankedFiles/rank.ts";
import type { Scheme } from "../../theme.ts";
import { workspaceColorAt } from "../../workspacePalette.ts";
import {
  convexHull,
  FLAG_R,
  type Pt2,
  placeFlags,
  quadHitsRect,
  rectInsideHull,
  rectQuadDistance,
  rectsOverlap,
  type ScreenRect,
} from "./labels.ts";
import type { City, CityArch, CityBuilding, CityDistrict, CityFolder, V3 } from "./model.ts";

export interface CityTip {
  title: string;
  lines: string[];
}

export interface CityCallbacks {
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
  onTip(tip: CityTip | null, x: number, y: number): void;
}

export interface CityOptions3D {
  scheme: Scheme;
  reducedMotion: boolean;
}

export type CityView = "angled" | "top" | "small";

type Hit =
  | { type: "district"; i: number }
  | { type: "folder"; i: number }
  | { type: "building"; i: number }
  | { type: "arch"; i: number };

const FOV = 30;
const ELEVATION = (50 * Math.PI) / 180;
const AZIMUTH = (-22 * Math.PI) / 180; // camera to the left of the front: the 2D map's left-to-right flow reads left to right
const SVG_NS = "http://www.w3.org/2000/svg";
/** A tiny district's title touches its slab or sits at most this far (screen px) from its projected rectangle. */
export const TITLE_GAP_PX = 24;

const mid = (a: Pt2, b: Pt2): Pt2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const hex = (c: string): THREE.Color => new THREE.Color(c);

function mix(a: string, b: string, t: number): THREE.Color {
  return hex(a).lerp(hex(b), t);
}

interface Theme {
  bg: string;
  grid: string;
  gridCenter: string;
  white: string;
  /** Text colours for count pills. */
  scheme: Scheme;
}

function themeFor(scheme: Scheme): Theme {
  return scheme === "dark"
    ? { bg: "#0b0e14", grid: "#1b2230", gridCenter: "#263044", white: "#0b0e14", scheme }
    : { bg: "#eef0f5", grid: "#d7dbe6", gridCenter: "#c3c9d8", white: "#ffffff", scheme };
}

interface DistrictLbl {
  el: HTMLElement;
  d: CityDistrict;
  /** Width of the compact variant. */
  cw: number;
  w: number;
  h: number;
  leader: SVGLineElement;
  dot: SVGCircleElement;
}
interface FolderLbl {
  el: HTMLElement;
  f: CityFolder;
  fullW: number;
  shortW: number;
  h: number;
}
interface ArchLbl {
  el: HTMLElement;
  text: HTMLElement;
  a: CityArch;
  shortW: number;
  fullW: number;
  h: number;
  color: string;
}
interface FlagEl {
  el: HTMLElement;
  pole: SVGLineElement;
  rank: number;
  b: number;
}

interface ArchObj {
  a: CityArch;
  meshes: THREE.Mesh[];
  mat: THREE.MeshBasicMaterial;
  shadow: THREE.Line;
}

/** Hook for the e2e tests and the perf script. */
export interface CityStats {
  frames: number;
  avgMs: number;
}

export class CityScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10000);
  private readonly controls: OrbitControls;
  private readonly content = new THREE.Group();
  private readonly overlay: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly ray = new THREE.Raycaster();
  private readonly ro: ResizeObserver;
  private theme: Theme;
  private city: City | null = null;
  private w = 1;
  private h = 1;
  private raf = 0;
  private dirty = true;
  private disposed = false;
  private tween: {
    t0: number;
    ms: number;
    p0: THREE.Vector3;
    p1: THREE.Vector3;
    t0v: THREE.Vector3;
    t1v: THREE.Vector3;
  } | null = null;
  private autoFit = true;
  private view: CityView = "angled";
  private mouse: { x: number; y: number } | null = null;
  private down: { x: number; y: number } | null = null;
  private hover: Hit | null = null;
  private selectedId: string | null = null;
  private panelHover: string | null = null;
  private ranked: RankedFile[] = [];
  private hoverFile: string | null = null;
  private frames = 0;
  private frameMs = 0;
  readonly stats: CityStats = { frames: 0, avgMs: 0 };

  // Per-city objects (disposed on every setCity).
  private meshes: THREE.InstancedMesh[] = [];
  private pickables: {
    mesh: THREE.InstancedMesh;
    kind: "district" | "folder" | "building";
    map: number[];
  }[] = [];
  private archObjs: ArchObj[] = [];
  private lines: THREE.LineSegments[] = [];
  private grid: THREE.GridHelper | null = null;
  private outline: THREE.LineSegments;
  private hoverOutline: THREE.LineSegments;
  private districtLbls: DistrictLbl[] = [];
  private folderLbls: FolderLbl[] = [];
  private archLbls: ArchLbl[] = [];
  private flagEls: FlagEl[] = [];
  private buildingMesh: { mesh: THREE.InstancedMesh; base: THREE.Matrix4[] } | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: CityCallbacks,
    private readonly opts: CityOptions3D,
  ) {
    this.theme = themeFor(opts.scheme);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = "none";
    this.scene.add(this.content);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-0.55, 1, 0.85);
    this.scene.add(sun);

    const unit = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.outline = new THREE.LineSegments(
      unit,
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    this.hoverOutline = new THREE.LineSegments(
      unit,
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    for (const o of [this.outline, this.hoverOutline]) {
      o.visible = false;
      o.renderOrder = 10;
      this.scene.add(o);
    }

    this.overlay = document.createElement("div");
    this.overlay.className = "c3-overlay";
    this.overlay.dataset.testid = "map3d-labels";
    this.overlay.setAttribute("data-testid", "map3d-labels");
    this.svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.svg.setAttribute("class", "c3-svg");
    this.overlay.appendChild(this.svg);
    host.appendChild(this.overlay);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minPolarAngle = 0.0005;
    this.controls.addEventListener("change", () => this.invalidate());
    this.controls.addEventListener("start", () => {
      this.autoFit = false;
      this.tween = null;
    });

    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerleave", this.onLeave);
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("dblclick", this.onDbl);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.applyBackground();
    this.loop();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Public API

  setScheme(scheme: Scheme): void {
    if (scheme === this.theme.scheme) return;
    this.theme = themeFor(scheme);
    this.applyBackground();
    if (this.city) this.rebuild(this.city, false);
  }

  setCity(city: City, keepCamera = false): void {
    const first = this.city === null;
    const t0 = performance.now();
    this.rebuild(city, true);
    this.host.dataset.buildMs = (performance.now() - t0).toFixed(0);
    if (first || !keepCamera) this.goto(this.view, false);
  }

  setSelected(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.updateOutline(this.outline, id);
    this.applyEmphasis();
    this.invalidate();
  }

  setPanelHover(districtId: string | null): void {
    this.panelHover = districtId;
    this.applyEmphasis();
    this.invalidate();
  }

  setRanked(files: RankedFile[]): void {
    this.ranked = files;
    this.buildFlags();
    this.invalidate();
  }

  setHoverFile(id: string | null): void {
    if (id === this.hoverFile) return;
    this.hoverFile = id;
    this.updateOutline(this.hoverOutline, id, true);
    // Hovering a row of the "Largest files" list raises that building a little.
    this.raiseBuildings();
    this.invalidate();
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on && !this.opts.reducedMotion;
    this.controls.autoRotateSpeed = 1.2;
    this.invalidate();
  }

  setView(view: CityView | "reset"): void {
    this.autoFit = true;
    this.view = view === "reset" ? "angled" : view;
    this.goto(this.view, !this.opts.reducedMotion);
  }

  /** Fly to a building, folder or district. */
  flyTo(id: string): void {
    const c = this.city;
    const e = c?.byId.get(id);
    if (!c || !e) return;
    const box =
      e.type === "district"
        ? c.districts[e.i]?.box
        : e.type === "folder"
          ? c.folders[e.i]?.box
          : c.buildings[e.i]?.box;
    if (!box) return;
    const target = new THREE.Vector3(box.cx, box.cy + box.sy / 2, box.cz);
    const size = Math.max(box.sx, box.sz);
    const dist = Math.max(
      c.extent * (e.type === "building" ? 0.1 : 0.28),
      size * (e.type === "building" ? 7 : 2.8),
    );
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.autoFit = false;
    this.animateTo(target.clone().add(dir.multiplyScalar(dist)), target, !this.opts.reducedMotion);
  }

  /** Number of tiny districts (the "Focus small workspaces" button is off when there are none). */
  smallCount(): number {
    return this.city?.districts.filter((d) => d.tiny).length ?? 0;
  }

  hasId(id: string): boolean {
    return Boolean(this.city?.byId.has(id));
  }

  /** The district an id belongs to (a district itself, or the district of a folder or building). */
  districtOf(id: string | null): string | null {
    const c = this.city;
    const e = id ? c?.byId.get(id) : undefined;
    if (!c || !e) return null;
    return e.type === "district"
      ? (c.districts[e.i]?.id ?? null)
      : e.type === "folder"
        ? (c.districts[c.folders[e.i]?.district ?? -1]?.id ?? null)
        : (c.districts[c.buildings[e.i]?.district ?? -1]?.id ?? null);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerleave", this.onLeave);
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("dblclick", this.onDbl);
    this.controls.dispose();
    this.clearCity();
    for (const o of [this.outline, this.hoverOutline]) {
      (o.material as THREE.Material).dispose();
    }
    this.outline.geometry.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Building the city

  private applyBackground(): void {
    this.scene.background = hex(this.theme.bg);
  }

  private clearCity(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    for (const l of this.lines) {
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    for (const o of this.archObjs) {
      for (const m of o.meshes) m.geometry.dispose();
      o.mat.dispose();
      o.shadow.geometry.dispose();
      (o.shadow.material as THREE.Material).dispose();
    }
    if (this.grid) {
      this.grid.geometry.dispose();
      for (const m of Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material])
        m.dispose();
    }
    this.content.clear();
    this.meshes = [];
    this.lines = [];
    this.pickables = [];
    this.archObjs = [];
    this.grid = null;
    this.buildingMesh = null;
    for (const l of [...this.districtLbls, ...this.folderLbls, ...this.archLbls, ...this.flagEls])
      l.el.remove();
    for (const l of this.districtLbls) {
      l.leader.remove();
      l.dot.remove();
    }
    for (const f of this.flagEls) f.pole.remove();
    this.districtLbls = [];
    this.folderLbls = [];
    this.archLbls = [];
    this.flagEls = [];
  }

  private rebuild(city: City, _fresh: boolean): void {
    this.clearCity();
    this.city = city;
    const th = this.theme;
    const dark = th.scheme === "dark";
    const cols = (d: CityDistrict): string => workspaceColorAt(d.colorIndex, th.scheme);
    const unit = new THREE.BoxGeometry(1, 1, 1);
    unit.translate(0, 0.5, 0);
    const lineParts: {
      box: { cx: number; cy: number; cz: number; sx: number; sy: number; sz: number };
      c: THREE.Color;
    }[] = [];

    const make = (
      kind: "district" | "folder" | "building" | "frame",
      items: {
        box: { cx: number; cy: number; cz: number; sx: number; sy: number; sz: number };
        color: THREE.Color;
        ref: number;
      }[],
      pickKind: "district" | "folder" | "building" | null,
      edge: ((i: number) => THREE.Color | null) | null,
    ): THREE.InstancedMesh | null => {
      if (items.length === 0) return null;
      const mesh = new THREE.InstancedMesh(
        unit.clone(),
        new THREE.MeshLambertMaterial({ color: 0xffffff }),
        items.length,
      );
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      items.forEach((it, i) => {
        const b = it.box;
        m4.compose(
          new THREE.Vector3(b.cx, b.cy - b.sy / 2, b.cz),
          q,
          new THREE.Vector3(Math.max(b.sx, 0.01), Math.max(b.sy, 0.01), Math.max(b.sz, 0.01)),
        );
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, it.color);
        const ec = edge?.(i);
        if (ec) lineParts.push({ box: b, c: ec });
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.userData.kind = kind;
      this.content.add(mesh);
      this.meshes.push(mesh);
      if (pickKind) this.pickables.push({ mesh, kind: pickKind, map: items.map((x) => x.ref) });
      return mesh;
    };

    // Districts: a saturated frame under a tinted slab (the solid coloured border), then the block at Workspaces level.
    const bw = Math.max(1.8, city.extent * 0.0032);
    make(
      "frame",
      city.districts.map((d, i) => ({
        box: { ...d.box, sy: d.slabTop * 0.8, cy: (d.slabTop * 0.8) / 2 },
        color: hex(cols(d)),
        ref: i,
      })),
      "district",
      null,
    );
    make(
      "district",
      city.districts.map((d, i) => ({
        box: { ...d.box, sx: Math.max(1, d.box.sx - 2 * bw), sz: Math.max(1, d.box.sz - 2 * bw) },
        color: mix(cols(d), dark ? th.bg : "#ffffff", dark ? 0.78 : 0.8),
        ref: i,
      })),
      "district",
      null,
    );
    const blocks = city.districts.flatMap((d, i) => (d.block ? [{ d, i }] : []));
    make(
      "building",
      blocks.map(({ d, i }) => ({
        box: d.block as NonNullable<CityDistrict["block"]>,
        color: mix(cols(d), th.white, dark ? 0.05 : 0.2),
        ref: i,
      })),
      "district",
      () => (dark ? hex("#000000") : hex("#1d2433")),
    );
    // Folder plinths (and extruded folders at the Folders level).
    make(
      "folder",
      city.folders.map((f, i) => {
        const d = city.districts[f.district] as CityDistrict;
        const depth = Math.min(f.depth, 3);
        const t = dark ? 0.62 - 0.1 * depth : 0.7 - 0.12 * depth;
        const c = f.extruded
          ? mix(cols(d), th.white, dark ? 0.1 + 0.08 * (i % 2) : 0.2 + 0.1 * (i % 2))
          : mix(cols(d), dark ? th.bg : "#ffffff", t);
        return { box: f.box, color: c, ref: i };
      }),
      "folder",
      (i) => (city.folders[i]?.extruded ? (dark ? hex("#000000") : mix("#1d2433", "#ffffff", 0.1)) : null),
    );
    // Buildings.
    const bm = make(
      "building",
      city.buildings.map((b, i) => {
        const d = city.districts[b.district] as CityDistrict;
        return { box: b.box, color: mix(cols(d), th.white, (dark ? 0.04 : 0.16) + 0.1 * b.alt), ref: i };
      }),
      "building",
      () => (dark ? hex("#000000") : hex("#1d2433")),
    );
    if (bm) {
      const base: THREE.Matrix4[] = [];
      for (let i = 0; i < city.buildings.length; i++) {
        const m = new THREE.Matrix4();
        bm.getMatrixAt(i, m);
        base.push(m);
      }
      this.buildingMesh = { mesh: bm, base };
    }

    // Edge lines (the darker roof edges): one merged LineSegments for every box that asked for one.
    if (lineParts.length > 0) {
      const pos = new Float32Array(lineParts.length * 24 * 3);
      const col = new Float32Array(lineParts.length * 24 * 3);
      lineParts.forEach(({ box: b, c }, n) => {
        const x0 = b.cx - b.sx / 2;
        const x1 = b.cx + b.sx / 2;
        const y0 = b.cy - b.sy / 2;
        const y1 = b.cy + b.sy / 2;
        const z0 = b.cz - b.sz / 2;
        const z1 = b.cz + b.sz / 2;
        const v: number[][] = [
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y0, z0],
          [x1, y0, z1],
          [x1, y0, z1],
          [x0, y0, z1],
          [x0, y0, z1],
          [x0, y0, z0],
          [x0, y1, z0],
          [x1, y1, z0],
          [x1, y1, z0],
          [x1, y1, z1],
          [x1, y1, z1],
          [x0, y1, z1],
          [x0, y1, z1],
          [x0, y1, z0],
          [x0, y0, z0],
          [x0, y1, z0],
          [x1, y0, z0],
          [x1, y1, z0],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y0, z1],
          [x0, y1, z1],
        ];
        v.forEach((p, k) => {
          const at = (n * 24 + k) * 3;
          pos.set(p as [number, number, number], at);
          col[at] = c.r;
          col[at + 1] = c.g;
          col[at + 2] = c.b;
        });
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const ls = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: dark ? 0.55 : 0.5 }),
      );
      this.lines.push(ls);
      this.content.add(ls);
    }

    // Ground grid.
    const span = Math.ceil((city.extent * 2.6) / 50) * 50;
    this.grid = new THREE.GridHelper(span, Math.round(span / 50), hex(th.gridCenter), hex(th.grid));
    this.grid.position.y = -0.2;
    this.content.add(this.grid);

    // Arches.
    for (const a of city.arches) this.addArch(a, city);

    // Labels.
    this.buildLabels(city);
    this.buildFlags();
    this.camera.near = city.extent * 0.01;
    this.camera.far = city.extent * 24;
    this.camera.updateProjectionMatrix();
    this.updateOutline(this.outline, this.selectedId);
    this.updateOutline(this.hoverOutline, this.hoverFile, true);
    this.applyEmphasis();
    this.invalidate();
  }

  private addArch(a: CityArch, city: City): void {
    const d = city.districts.find((x) => x.idx === a.srcIdx);
    const color = d ? workspaceColorAt(d.colorIndex, this.theme.scheme) : "#888888";
    const mat = new THREE.MeshBasicMaterial({ color: hex(color), transparent: true, opacity: 0.92 });
    // Smaller heads where an arch ends on a tiny district, so the several heads there stay apart.
    const toTiny = city.districts.some((x) => x.tiny && x.idx === a.dstIdx);
    const headR = Math.max(a.radius * 2.8, city.extent * 0.0115) * (toTiny ? 0.7 : 1);
    const headH = headR * 3.2;
    const pts = a.pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const end = pts[pts.length - 1] as THREE.Vector3;
    const tangent = end
      .clone()
      .sub(pts[Math.max(0, pts.length - 3)] as THREE.Vector3)
      .normalize();
    // The tube stops at the base of the head.
    const cut: THREE.Vector3[] = [];
    for (const p of pts) {
      if (p.distanceTo(end) >= headH * 0.9) cut.push(p);
      else break;
    }
    cut.push(end.clone().addScaledVector(tangent, -headH * 0.9));
    const curve = new THREE.CatmullRomCurve3(cut, false, "centripetal");
    const segs = Math.max(24, Math.min(200, cut.length * 3));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, a.radius, 8, false), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headH, 16), mat);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    head.position.copy(end).addScaledVector(tangent, -headH / 2);
    const start = pts[0] as THREE.Vector3;
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(a.radius * 2.2, city.extent * 0.0075), 14, 10),
      mat,
    );
    dot.position.copy(start);
    const shadow = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(a.ground.map((p) => new THREE.Vector3(p.x, p.y, p.z))),
      new THREE.LineBasicMaterial({ color: hex(color), transparent: true, opacity: 0.35 }),
    );
    for (const m of [tube, head, dot]) {
      m.userData.arch = a.key;
      this.content.add(m);
    }
    this.content.add(shadow);
    this.archObjs.push({ a, meshes: [tube, head, dot], mat, shadow });
  }

  private buildLabels(city: City): void {
    const make = (cls: string): HTMLElement => {
      const el = document.createElement("div");
      el.className = `c3-label ${cls}`;
      el.style.visibility = "hidden";
      this.overlay.appendChild(el);
      return el;
    };
    const leaderDot = (color: string): SVGCircleElement => {
      const c = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
      c.setAttribute("r", "3.5");
      c.style.fill = color;
      c.style.visibility = "hidden";
      this.svg.appendChild(c);
      return c;
    };
    const leaderLine = (color: string): SVGLineElement => {
      const l = document.createElementNS(SVG_NS, "line") as SVGLineElement;
      l.setAttribute("class", "c3-leader");
      l.style.stroke = color;
      l.style.visibility = "hidden";
      this.svg.appendChild(l);
      return l;
    };
    for (const d of city.districts) {
      const el = make("c3-title");
      el.dataset.district = d.id;
      el.style.borderLeftColor = workspaceColorAt(d.colorIndex, this.theme.scheme);
      const name = document.createElement("strong");
      name.className = "c3-name";
      name.textContent = d.title;
      const sub = document.createElement("span");
      sub.className = "c3-sub";
      sub.textContent = d.detail;
      const subc = document.createElement("span");
      subc.className = "c3-subc";
      subc.textContent = `${d.kind} · ${d.fns.toLocaleString("en-US")} fn · ${d.files.toLocaleString("en-US")} ${d.files === 1 ? "file" : "files"}`;
      el.append(name, sub, subc);
      this.districtLbls.push({
        el,
        d,
        cw: 0,
        w: 0,
        h: 0,
        leader: leaderLine(workspaceColorAt(d.colorIndex, this.theme.scheme)),
        dot: leaderDot(workspaceColorAt(d.colorIndex, this.theme.scheme)),
      });
    }
    for (const f of city.folders) {
      if (f.depth > 3) continue;
      const el = make("c3-cap");
      el.dataset.folder = f.id;
      const color = workspaceColorAt(
        (city.districts[f.district] as CityDistrict).colorIndex,
        this.theme.scheme,
      );
      el.style.setProperty("--ws", color);
      const glyph = document.createElement("span");
      glyph.className = "c3-fg";
      glyph.textContent = "▣";
      const name = document.createElement("span");
      name.className = "c3-cn";
      name.textContent = f.title;
      const fn = document.createElement("span");
      fn.className = "c3-cf";
      fn.textContent = ` · ${f.fns.toLocaleString("en-US")} fn`;
      el.append(glyph, name, fn);
      this.folderLbls.push({ el, f, fullW: 0, shortW: 0, h: 0 });
    }
    const showAll = city.arches.filter((a) => !a.declaredOnly).length <= 40;
    city.arches.forEach((a, rank) => {
      if (a.declaredOnly || (!showAll && rank >= 8)) return;
      const d = city.districts.find((x) => x.idx === a.srcIdx);
      const color = d ? workspaceColorAt(d.colorIndex, this.theme.scheme) : "#888";
      const el = make("c3-pill");
      el.dataset.arc = a.key;
      el.style.setProperty("--ws", color);
      const t = document.createElement("span");
      t.textContent = a.weight.toLocaleString("en-US");
      el.appendChild(t);
      this.archLbls.push({ el, text: t, a, shortW: 0, fullW: 0, h: 0, color });
    });
    // Measure once, in passes of writes and then reads, so the browser lays the overlay out a few times, not per label.
    for (const l of this.archLbls) {
      const names = this.archNames(l.a);
      l.el.dataset.full = `${names[0]} → ${names[1]}: ${l.a.weight.toLocaleString("en-US")} imports`;
      l.text.textContent = l.el.dataset.full;
    }
    for (const l of this.archLbls) l.fullW = Math.ceil(l.el.getBoundingClientRect().width);
    for (const l of this.archLbls) l.text.textContent = l.a.weight.toLocaleString("en-US");
    for (const l of this.archLbls) {
      const r = l.el.getBoundingClientRect();
      l.shortW = Math.ceil(r.width);
      l.h = Math.ceil(r.height);
    }
    for (const l of this.districtLbls) {
      const r = l.el.getBoundingClientRect();
      l.w = Math.ceil(r.width);
      l.h = Math.ceil(r.height);
      // The compact variant's real width: measure it as drawn.
      l.el.classList.add("is-compact");
      l.cw = Math.ceil(l.el.getBoundingClientRect().width);
      l.el.classList.remove("is-compact");
    }
    for (const l of this.folderLbls) {
      const r = l.el.getBoundingClientRect();
      l.shortW = Math.ceil(r.width);
      l.h = Math.ceil(r.height);
      l.fullW = Math.ceil(r.width + 3 + (l.el.children[2] as HTMLElement).scrollWidth);
    }
  }

  private archNames(a: CityArch): [string, string] {
    const c = this.city;
    const nm = (idx: number): string => c?.districts.find((d) => d.idx === idx)?.title ?? "";
    return [nm(a.srcIdx), nm(a.dstIdx)];
  }

  private buildFlags(): void {
    for (const f of this.flagEls) {
      f.el.remove();
      f.pole.remove();
    }
    this.flagEls = [];
    const c = this.city;
    if (!c) return;
    for (const r of this.ranked) {
      const e = c.byId.get(r.id);
      if (e?.type !== "building") continue;
      const el = document.createElement("div");
      el.className = "c3-label c3-flag";
      el.dataset.file = r.id;
      el.dataset.rank = String(r.rank);
      el.textContent = String(r.rank);
      el.style.visibility = "hidden";
      const b = c.buildings[e.i] as CityBuilding;
      const d = c.districts[b.district] as CityDistrict;
      el.style.setProperty("--ws", workspaceColorAt(d.colorIndex, this.theme.scheme));
      this.overlay.appendChild(el);
      const pole = document.createElementNS(SVG_NS, "line") as SVGLineElement;
      pole.setAttribute("class", "c3-pole");
      pole.style.visibility = "hidden";
      this.svg.appendChild(pole);
      this.flagEls.push({ el, pole, rank: r.rank, b: e.i });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Selection, emphasis

  private focusDistrict(): string | null {
    if (this.panelHover) return this.panelHover;
    const c = this.city;
    if (c && this.selectedId) {
      const e = c.byId.get(this.selectedId);
      if (e?.type === "district") return this.selectedId;
    }
    if (this.hover && c) {
      if (this.hover.type === "district") return c.districts[this.hover.i]?.id ?? null;
      if (this.hover.type === "folder")
        return c.districts[c.folders[this.hover.i]?.district ?? -1]?.id ?? null;
      if (this.hover.type === "building")
        return c.districts[c.buildings[this.hover.i]?.district ?? -1]?.id ?? null;
    }
    return null;
  }

  private applyEmphasis(): void {
    const focus = this.focusDistrict();
    const c = this.city;
    for (const o of this.archObjs) {
      const d = c?.districts.find((x) => x.idx === o.a.srcIdx);
      const e = c?.districts.find((x) => x.idx === o.a.dstIdx);
      const on = !focus || d?.id === focus || e?.id === focus;
      o.mat.opacity = on ? 0.95 : 0.1;
      o.shadow.visible = on;
    }
  }

  private boxOf(
    id: string,
  ): { cx: number; cy: number; cz: number; sx: number; sy: number; sz: number } | null {
    const c = this.city;
    const e = c?.byId.get(id);
    if (!c || !e) return null;
    if (e.type === "district") {
      const d = c.districts[e.i] as CityDistrict;
      return d.block ?? d.box;
    }
    if (e.type === "folder") return (c.folders[e.i] as CityFolder).box;
    return (c.buildings[e.i] as CityBuilding).box;
  }

  private updateOutline(o: THREE.LineSegments, id: string | null, hover = false): void {
    const b = id ? this.boxOf(id) : null;
    if (!b) {
      o.visible = false;
      return;
    }
    o.visible = true;
    const pad = 0.6;
    o.position.set(b.cx, b.cy, b.cz);
    o.scale.set(b.sx + pad, b.sy + pad, b.sz + pad);
    (o.material as THREE.LineBasicMaterial).color.set(
      hover
        ? this.theme.scheme === "dark"
          ? "#ffd43b"
          : "#e8590c"
        : this.theme.scheme === "dark"
          ? "#ffffff"
          : "#0b0e14",
    );
  }

  private raiseBuildings(): void {
    const bm = this.buildingMesh;
    const c = this.city;
    if (!bm || !c) return;
    const lift = c.extent * 0.03;
    const m4 = new THREE.Matrix4();
    let touched = false;
    c.buildings.forEach((b, i) => {
      const up = b.id === this.hoverFile;
      m4.copy(bm.base[i] as THREE.Matrix4);
      if (up) {
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        m4.decompose(p, q, s);
        s.y += lift;
        m4.compose(p, q, s);
      }
      bm.mesh.setMatrixAt(i, m4);
      touched = true;
    });
    if (touched) bm.mesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Camera

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    if (w === this.w && h === this.h && this.renderer.domElement.width > 0) return;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.city && this.autoFit) this.goto(this.view, false);
    this.invalidate();
  }

  /** Camera position and target that fit the whole city in the free area of the canvas for a direction. */
  private fit(view: CityView): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const c = this.city;
    const E = c?.extent ?? 100;
    // What has to be on screen: every district's floor and a fixed allowance for its buildings (so the framing does
    // not depend on the level), a strip in front of each floor for its title, and every arch.
    const corners: THREE.Vector3[] = [];
    const h = E * 0.07;
    const front = E * 0.035;
    // "small": only the tiny districts, their title strips and the ends of the arches that reach them.
    const small = view === "small" && (c?.districts ?? []).some((d) => d.tiny);
    for (const d of c?.districts ?? []) {
      if (small && !d.tiny) continue;
      const b = d.box;
      for (const x of [b.cx - b.sx / 2, b.cx + b.sx / 2])
        for (const z of [b.cz - b.sz / 2, b.cz + b.sz / 2]) {
          corners.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, h, z));
        }
      corners.push(new THREE.Vector3(b.cx - b.sx / 2, 0, b.cz + b.sz / 2 + front));
    }
    for (const a of c?.arches ?? []) {
      const tinyEnd = (i: number): boolean => Boolean(c?.districts.some((d) => d.tiny && d.idx === i));
      const n = a.pts.length;
      a.pts.forEach((p, i) => {
        if (small) {
          // The part of the arch near its tiny end(s), so the arrowheads and a bit of the approach are in frame.
          const near = (tinyEnd(a.srcIdx) && i <= n * 0.25) || (tinyEnd(a.dstIdx) && i >= n * 0.75);
          if (!near || i % 2 !== 0) return;
        } else if (i % 3 !== 0 && i !== n - 1) return;
        corners.push(new THREE.Vector3(p.x, p.y, p.z));
      });
    }
    if (corners.length === 0) corners.push(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 0, 50));
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (const p of corners) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z);
      z1 = Math.max(z1, p.z);
    }
    const target = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const dir =
      view === "top"
        ? new THREE.Vector3(0, 1, 0.00001).normalize()
        : new THREE.Vector3(
            Math.sin(AZIMUTH) * Math.cos(ELEVATION),
            Math.sin(ELEVATION),
            Math.cos(AZIMUTH) * Math.cos(ELEVATION),
          ).normalize();
    // Margins as shares of the half-size in NDC: room for labels above, the key below, a little at the sides.
    const mx = 0.03;
    const mTop = 0.11;
    const mBottom = 0.27;
    const cam = new THREE.PerspectiveCamera(FOV, this.w / this.h, E * 0.01, E * 40);
    const ok = (dist: number): boolean => {
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      for (const p of corners) {
        const q = p.clone().project(cam);
        if (q.z > 1 || Math.abs(q.x) > 1 - mx || q.y > 1 - mTop || q.y < -1 + mBottom) return false;
      }
      return true;
    };
    // Smallest distance that fits, then slide the target so the content is centred in the free band; repeat.
    let hi = E * 30;
    const tanH = Math.tan((FOV * Math.PI) / 360);
    for (let round = 0; round < 3; round++) {
      let lo = E * 0.2;
      hi = E * 30;
      for (let i = 0; i < 28; i++) {
        const mid = (lo + hi) / 2;
        if (ok(mid)) hi = mid;
        else lo = mid;
      }
      ok(hi);
      let xMin = Number.POSITIVE_INFINITY;
      let xMax = Number.NEGATIVE_INFINITY;
      let yMin = Number.POSITIVE_INFINITY;
      let yMax = Number.NEGATIVE_INFINITY;
      for (const p of corners) {
        const q = p.clone().project(cam);
        xMin = Math.min(xMin, q.x);
        xMax = Math.max(xMax, q.x);
        yMin = Math.min(yMin, q.y);
        yMax = Math.max(yMax, q.y);
      }
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const upH = Math.max(0.2, Math.hypot(up.x, up.z));
      const dx = ((xMin + xMax) / 2) * hi * tanH * (this.w / this.h);
      const dy = ((yMin + yMax) / 2 - (mBottom - mTop) / 2) * hi * tanH;
      target.x += right.x * dx + (up.x / upH / upH) * dy;
      target.z += right.z * dx + (up.z / upH / upH) * dy;
    }
    return { pos: target.clone().addScaledVector(dir, hi), target };
  }

  private goto(view: CityView, animate: boolean): void {
    const { pos, target } = this.fit(view);
    this.animateTo(pos, target, animate);
    this.autoFit = true;
  }

  private animateTo(pos: THREE.Vector3, target: THREE.Vector3, animate: boolean): void {
    if (!animate) {
      this.tween = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      this.controls.update();
      this.invalidate();
      return;
    }
    this.tween = {
      t0: performance.now(),
      ms: 650,
      p0: this.camera.position.clone(),
      p1: pos,
      t0v: this.controls.target.clone(),
      t1v: target,
    };
    this.invalidate();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Pointer

  private ndc(x: number, y: number): THREE.Vector2 {
    return new THREE.Vector2((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1);
  }

  private pick(x: number, y: number): { hit: Hit; dist: number } | null {
    this.ray.setFromCamera(this.ndc(x, y), this.camera);
    let best: { hit: Hit; dist: number } | null = null;
    for (const p of this.pickables) {
      const hits = this.ray.intersectObject(p.mesh, false);
      const h = hits[0];
      if (h && h.instanceId !== undefined && (!best || h.distance < best.dist))
        best = { hit: { type: p.kind, i: p.map[h.instanceId] as number }, dist: h.distance };
    }
    for (const [i, o] of this.archObjs.entries()) {
      if (o.mat.opacity < 0.5) continue;
      const hits = this.ray.intersectObjects(o.meshes, false);
      const h = hits[0];
      if (h && (!best || h.distance < best.dist - 0.01))
        best = { hit: { type: "arch", i }, dist: h.distance };
    }
    return best;
  }

  private idOf(hit: Hit): string | null {
    const c = this.city;
    if (!c) return null;
    if (hit.type === "district") return c.districts[hit.i]?.id ?? null;
    if (hit.type === "folder") return c.folders[hit.i]?.id ?? null;
    if (hit.type === "building") return c.buildings[hit.i]?.id ?? null;
    return null;
  }

  private tipFor(hit: Hit): CityTip | null {
    const c = this.city;
    if (!c) return null;
    const n = (v: number): string => v.toLocaleString("en-US");
    if (hit.type === "district") {
      const d = c.districts[hit.i] as CityDistrict;
      return { title: d.title, lines: [`${d.kind} · ${n(d.fns)} functions · ${n(d.files)} files`, d.path] };
    }
    if (hit.type === "folder") {
      const f = c.folders[hit.i] as CityFolder;
      return { title: f.path || f.title, lines: [`folder · ${n(f.fns)} functions · ${n(f.files)} files`] };
    }
    if (hit.type === "building") {
      const b = c.buildings[hit.i] as CityBuilding;
      return {
        title: b.path,
        lines: [`file · ${n(b.fns)} functions${b.loc !== null ? ` · ${n(b.loc)} lines` : ""}`],
      };
    }
    const o = this.archObjs[hit.i];
    if (!o) return null;
    const [a, b] = this.archNames(o.a);
    return {
      title: `${a} → ${b}: ${n(o.a.weight)} imports`,
      lines: [o.a.declaredOnly ? "declared in package.json only" : `${a} imports from ${b}`],
    };
  }

  private readonly onMove = (e: PointerEvent): void => {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (e.buttons !== 0) {
      this.cb.onTip(null, 0, 0);
      return;
    }
    const p = this.pick(this.mouse.x, this.mouse.y);
    const hit = p?.hit ?? null;
    const same = hit && this.hover && hit.type === this.hover.type && hit.i === this.hover.i;
    if (!same) {
      this.hover = hit;
      this.cb.onHover(hit ? this.idOf(hit) : null);
      this.applyEmphasis();
      this.invalidate();
    }
    const tip = hit ? this.tipFor(hit) : null;
    this.cb.onTip(tip, this.mouse.x, this.mouse.y);
    this.renderer.domElement.style.cursor = hit ? "pointer" : "grab";
  };

  private readonly onLeave = (): void => {
    this.mouse = null;
    if (this.hover) {
      this.hover = null;
      this.cb.onHover(null);
      this.applyEmphasis();
      this.invalidate();
    }
    this.cb.onTip(null, 0, 0);
  };

  private readonly onDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private readonly onUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = this.pick(e.clientX - r.left, e.clientY - r.top);
    if (!p) {
      this.cb.onSelect(null);
      return;
    }
    const id = this.idOf(p.hit);
    if (id) this.cb.onSelect(id);
    else if (p.hit.type === "arch") {
      const o = this.archObjs[p.hit.i];
      if (o) this.cb.onSelect(o.a.src);
    }
  };

  private readonly onDbl = (e: MouseEvent): void => {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = this.pick(e.clientX - r.left, e.clientY - r.top);
    if (!p) return;
    const id = this.idOf(p.hit);
    if (id) {
      this.cb.onSelect(id);
      // A tiny district is hard to read from afar and a close fly-in would lose its neighbours: frame them all.
      const e = this.city?.byId.get(id);
      if (e?.type === "district" && this.city?.districts[e.i]?.tiny) this.setView("small");
      else this.flyTo(id);
    }
  };

  // ---------------------------------------------------------------------------------------------------------
  // Frame loop and labels

  private invalidate(): void {
    this.dirty = true;
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.t0) / this.tween.ms);
      const k = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, k);
      this.controls.target.lerpVectors(this.tween.t0v, this.tween.t1v, k);
      this.camera.lookAt(this.controls.target);
      if (t >= 1) this.tween = null;
      this.dirty = true;
    }
    if (this.controls.autoRotate) this.dirty = true;
    this.controls.update();
    if (!this.dirty) return;
    this.dirty = false;
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    const ms = performance.now() - t0;
    this.frames++;
    this.frameMs += ms;
    this.stats.frames = this.frames;
    this.stats.avgMs = this.frameMs / this.frames;
    this.host.dataset.frameMs = this.stats.avgMs.toFixed(2);
    this.host.dataset.frames = String(this.frames);
  };

  private px(x: number, y: number, z: number): [number, number, boolean] {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.w, (-v.y * 0.5 + 0.5) * this.h, v.z < 1];
  }

  private placeLabels(): void {
    const c = this.city;
    if (!c) return;
    this.camera.updateMatrixWorld();
    const placed: ScreenRect[] = [];
    const keyEl = this.host.parentElement?.querySelector(".map3d-key");
    if (keyEl) {
      const kr = keyEl.getBoundingClientRect();
      const hr = this.host.getBoundingClientRect();
      placed.push({ l: kr.left - hr.left, t: kr.top - hr.top, r: kr.right - hr.left, b: kr.bottom - hr.top });
    }
    const W = this.w;
    const H = this.h;
    const inside = (r: ScreenRect): boolean => r.l >= 2 && r.t >= 2 && r.r <= W - 2 && r.b <= H - 2;
    const show = (el: HTMLElement, l: number, t: number): void => {
      el.style.visibility = "visible";
      el.style.transform = `translate(${Math.round(l)}px, ${Math.round(t)}px)`;
    };
    const hide = (el: HTMLElement): void => {
      el.style.visibility = "hidden";
    };

    // District hulls (screen) as obstacles.
    const hulls = new Map<string, Pt2[]>();
    const quads = new Map<string, { fl: Pt2; fr: Pt2; bl: Pt2; br: Pt2 }>();
    for (const d of c.districts) {
      const b = d.box;
      const x0 = b.cx - b.sx / 2;
      const x1 = b.cx + b.sx / 2;
      const z0 = b.cz - b.sz / 2;
      const z1 = b.cz + b.sz / 2;
      const pts: Pt2[] = [];
      for (const y of [0, d.reach])
        for (const [x, z] of [
          [x0, z0],
          [x1, z0],
          [x1, z1],
          [x0, z1],
        ] as const) {
          const p = this.px(x, y, z);
          pts.push([p[0], p[1]]);
        }
      hulls.set(d.id, convexHull(pts));
      const at = (x: number, z: number): Pt2 => {
        const p = this.px(x, d.slabTop, z);
        return [p[0], p[1]];
      };
      quads.set(d.id, { fl: at(x0, z1), fr: at(x1, z1), bl: at(x0, z0), br: at(x1, z0) });
    }

    // 1. District titles: always shown. Candidates around the front-left corner, the camera side first.
    // Tiny districts first: their titles must sit right next to their slab, so they get first pick of the spots.
    const order = [...this.districtLbls].sort(
      (p, q) => Number(q.d.tiny) - Number(p.d.tiny) || q.d.fns - p.d.fns || (p.d.id < q.d.id ? -1 : 1),
    );
    const titleRects = new Map<string, ScreenRect>();
    for (const l of order) {
      const q = quads.get(l.d.id) as { fl: Pt2; fr: Pt2; bl: Pt2; br: Pt2 };
      const ownHull = hulls.get(l.d.id) as Pt2[];
      const g = 5;
      type Spot = { l: number; t: number; ax: number; ay: number };
      const free = (cd: { l: number; t: number }, w: number, h: number, inOwn: boolean): boolean => {
        const r: ScreenRect = { l: cd.l, t: cd.t, r: cd.l + w, b: cd.t + h };
        if (!inside(r)) return false;
        for (const [id, hull] of hulls) if (id !== l.d.id && quadHitsRect(hull, r, 2)) return false;
        if (inOwn ? !rectInsideHull(ownHull, r) : quadHitsRect(ownHull, r, 1)) return false;
        return !placed.some((p) => rectsOverlap(p, r, 2));
      };
      const hb = {
        l: Math.min(...ownHull.map((p) => p[0])),
        r: Math.max(...ownHull.map((p) => p[0])),
        t: Math.min(...ownHull.map((p) => p[1])),
        b: Math.max(...ownHull.map((p) => p[1])),
      };
      const near = (w: number, h: number): { outside: Spot[]; own: Spot[] } => ({
        outside: [
          { l: q.fl[0], t: q.fl[1] + g, ax: q.fl[0], ay: q.fl[1] },
          { l: q.bl[0], t: q.bl[1] - h - g, ax: q.bl[0], ay: q.bl[1] },
          { l: q.fl[0] - w - g, t: q.fl[1] - h * 0.5, ax: q.fl[0], ay: q.fl[1] },
          { l: q.fr[0] - w, t: q.fr[1] + g, ax: q.fr[0], ay: q.fr[1] },
          { l: q.br[0] + g, t: q.br[1] - h, ax: q.br[0], ay: q.br[1] },
          { l: q.fr[0] + g, t: q.fr[1] - h * 0.5, ax: q.fr[0], ay: q.fr[1] },
          { l: q.bl[0] - w - g, t: q.bl[1] - h, ax: q.bl[0], ay: q.bl[1] },
          // Around the whole outline of the district.
          { l: hb.l, t: hb.t - h - g, ax: hb.l, ay: hb.t },
          { l: hb.r - w, t: hb.t - h - g, ax: hb.r, ay: hb.t },
          { l: (hb.l + hb.r) / 2 - w / 2, t: hb.t - h - g, ax: hb.l, ay: hb.t },
          { l: hb.r + g, t: hb.t, ax: hb.r, ay: hb.t },
          { l: hb.r + g, t: hb.b - h, ax: hb.r, ay: hb.b },
          { l: hb.r + g, t: (hb.t + hb.b) / 2 - h / 2, ax: hb.r, ay: hb.t },
          { l: hb.l, t: hb.b + g, ax: hb.l, ay: hb.b },
          { l: hb.r - w, t: hb.b + g, ax: hb.r, ay: hb.b },
          { l: hb.l - w - g, t: hb.t, ax: hb.l, ay: hb.t },
          { l: hb.l - w - g, t: hb.b - h, ax: hb.l, ay: hb.b },
        ],
        own: [
          { l: q.fl[0] + 8, t: q.fl[1] - h - 8, ax: q.fl[0], ay: q.fl[1] },
          { l: q.bl[0] + 8, t: q.bl[1] + 8, ax: q.bl[0], ay: q.bl[1] },
          {
            l: (q.fl[0] + q.br[0]) / 2 - w / 2,
            t: (q.fl[1] + q.br[1]) / 2 - h / 2,
            ax: q.fl[0],
            ay: q.fl[1],
          },
        ],
      });
      // The full title for districts that are big on screen, the compact one (kind, fn, files) for the small ones.
      const tiny = Math.max(q.fr[0], q.br[0]) - Math.min(q.fl[0], q.bl[0]) < l.w * 0.8;
      const variants = tiny ? [true] : [false, true];
      let chosen: Spot | undefined;
      let adjacent = false;
      let compact = variants[variants.length - 1] as boolean;
      for (const c of variants) {
        const w = c ? l.cw : l.w;
        const sets = near(w, l.h);
        if (l.d.tiny) {
          // Next to the slab (touching or within TITLE_GAP_PX of its projected quad), the same side for every tiny
          // district so neighbours form a tidy column: under the front-left corner first.
          const quad: Pt2[] = [q.bl, q.br, q.fr, q.fl];
          const near = (cd: Spot): boolean =>
            rectQuadDistance({ l: cd.l, t: cd.t, r: cd.l + w, b: cd.t + l.h }, quad) <= TITLE_GAP_PX - 3;
          const sl = Math.min(q.fl[0], q.bl[0]);
          const sr = Math.max(q.fr[0], q.br[0]);
          const st = Math.min(q.bl[1], q.br[1]);
          const adj: Spot[] = [];
          for (const mk of [
            (gp: number): Spot => ({ l: q.fl[0], t: q.fl[1] + gp, ax: q.fl[0], ay: q.fl[1] }),
            (gp: number): Spot => ({ l: q.fl[0] - w * 0.5, t: q.fl[1] + gp, ax: q.fl[0], ay: q.fl[1] }),
            (gp: number): Spot => ({ l: q.fr[0] - w, t: q.fr[1] + gp, ax: q.fr[0], ay: q.fr[1] }),
            (gp: number): Spot => ({ l: q.fr[0] + gp, t: q.fr[1] - l.h * 0.5, ax: q.fr[0], ay: q.fr[1] }),
            (gp: number): Spot => ({ l: q.fl[0] - w - gp, t: q.fl[1] - l.h, ax: q.fl[0], ay: q.fl[1] }),
            (gp: number): Spot => ({ l: q.bl[0], t: q.bl[1] - l.h - gp, ax: q.bl[0], ay: q.bl[1] }),
            (gp: number): Spot => ({ l: q.br[0] - w, t: q.br[1] - l.h - gp, ax: q.br[0], ay: q.br[1] }),
            (gp: number): Spot => ({ l: q.br[0] + gp, t: q.br[1] - l.h * 0.5, ax: q.br[0], ay: q.br[1] }),
            (gp: number): Spot => ({ l: q.bl[0] - w - gp, t: q.bl[1], ax: q.bl[0], ay: q.bl[1] }),
          ])
            for (const gp of [0, 4, 10, 16]) adj.push(mk(gp));
          let hit = adj.find((cd) => near(cd) && free(cd, w, l.h, false));
          if (!hit) {
            // Any free spot around the slab, the nearest first.
            const dense: (Spot & { d: number })[] = [];
            for (let ty = st - l.h - 20; ty <= Math.max(q.fl[1], q.fr[1]) + 20; ty += 6)
              for (let lx = sl - w - 20; lx <= sr + 20; lx += 8) {
                const cd: Spot = { l: lx, t: ty, ax: q.fl[0], ay: q.fl[1] };
                const d = rectQuadDistance({ l: lx, t: ty, r: lx + w, b: ty + l.h }, quad);
                if (d <= TITLE_GAP_PX - 3) dense.push({ ...cd, d });
              }
            dense.sort((p, r2) => p.d - r2.d || p.t - r2.t || p.l - r2.l);
            hit = dense.find((cd) => free(cd, w, l.h, false));
          }
          if (hit) {
            chosen = hit;
            adjacent = true;
          }
        }
        chosen ??=
          sets.outside.find((cd) => free(cd, w, l.h, false)) ?? sets.own.find((cd) => free(cd, w, l.h, true));
        if (chosen) {
          compact = c;
          break;
        }
      }
      const w = compact ? l.cw : l.w;
      const h = l.h;
      if (!chosen) {
        // Further away, with a leader to the district.
        const far: Spot[] = [];
        for (const k of [0.5, 1, 1.5, 2, 3, 4])
          for (const [dx, dy] of [
            [0, 1],
            [-1, 0],
            [1, 0],
            [0, -1],
            [-1, 1],
            [1, 1],
            [-1, -1],
            [1, -1],
          ] as const)
            far.push({
              l: q.fl[0] + dx * (w + 14) * k * 0.6 - (dx < 0 ? w * 0.4 : 0),
              t: q.fl[1] + dy * (h + 10) * k,
              ax: q.fl[0],
              ay: q.fl[1],
            });
        far.sort((p, q2) => Math.hypot(p.l - p.ax, p.t - p.ay) - Math.hypot(q2.l - q2.ax, q2.t - q2.ay));
        chosen = far.find((cd) => free(cd, w, h, false));
      }
      chosen ??= near(w, h).outside[0] as Spot;
      const r: ScreenRect = { l: chosen.l, t: chosen.t, r: chosen.l + w, b: chosen.t + h };
      placed.push(r);
      titleRects.set(l.d.id, r);
      l.el.classList.toggle("is-compact", compact);
      show(l.el, chosen.l, chosen.t);
      // A short leader when the title is not touching its district's corner.
      // The district point nearest to the title (a corner or an edge midpoint of its floor).
      const pts: Pt2[] = [
        q.fl,
        q.fr,
        q.bl,
        q.br,
        mid(q.fl, q.fr),
        mid(q.bl, q.br),
        mid(q.fl, q.bl),
        mid(q.fr, q.br),
      ];
      let nearPt = pts[0] as Pt2;
      let best = Number.POSITIVE_INFINITY;
      for (const p of pts) {
        const d = Math.hypot(
          Math.min(Math.max(p[0], r.l), r.r) - p[0],
          Math.min(Math.max(p[1], r.t), r.b) - p[1],
        );
        if (d < best) {
          best = d;
          nearPt = p;
        }
      }
      const nx = Math.min(Math.max(nearPt[0], r.l), r.r);
      const ny = Math.min(Math.max(nearPt[1], r.t), r.b);
      if (best > 7 && !adjacent) {
        l.leader.setAttribute("x1", String(nearPt[0]));
        l.leader.setAttribute("y1", String(nearPt[1]));
        l.leader.setAttribute("x2", String(nx));
        l.leader.setAttribute("y2", String(ny));
        l.leader.style.visibility = "visible";
        l.dot.setAttribute("cx", String(nearPt[0]));
        l.dot.setAttribute("cy", String(nearPt[1]));
        l.dot.style.visibility = "visible";
      } else {
        l.leader.style.visibility = "hidden";
        l.dot.style.visibility = "hidden";
      }
    }

    // 2. Flags: numbered discs above the largest buildings, never hidden, never overlapping.
    const anchors = this.flagEls.map((f) => {
      const b = c.buildings[f.b] as CityBuilding;
      const p = this.px(b.box.cx, b.top, b.box.cz);
      return { id: String(f.rank), x: p[0], y: p[1] };
    });
    const flags = placeFlags(anchors, { w: W, h: H }, [...titleRects.values()]);
    const flagInfo: unknown[] = [];
    this.flagEls.forEach((f, i) => {
      const p = flags[i];
      if (!p) return;
      f.el.style.visibility = "visible";
      f.el.style.transform = `translate(${Math.round(p.x - FLAG_R)}px, ${Math.round(p.y - FLAG_R)}px)`;
      f.pole.setAttribute("x1", String(p.ax));
      f.pole.setAttribute("y1", String(p.ay));
      f.pole.setAttribute("x2", String(p.x));
      f.pole.setAttribute("y2", String(p.y));
      f.pole.style.visibility = "visible";
      f.el.classList.toggle("is-hover", (c.buildings[f.b] as CityBuilding).id === this.hoverFile);
      placed.push({ l: p.x - FLAG_R, t: p.y - FLAG_R, r: p.x + FLAG_R, b: p.y + FLAG_R });
      flagInfo.push({
        rank: f.rank,
        id: (c.buildings[f.b] as CityBuilding).id,
        x: p.x,
        y: p.y,
        ax: p.ax,
        ay: p.ay,
      });
    });

    // Where the arches meet a tiny district (screen px): arrowheads at the target end, dots at the source. Count pills keep
    // off them, and the tests read them.
    const ends: unknown[] = [];
    for (const a of c.arches) {
      const sd = c.districts.find((d) => d.idx === a.srcIdx);
      const dd = c.districts.find((d) => d.idx === a.dstIdx);
      if (dd?.tiny) {
        const t = a.pts[a.pts.length - 1] as V3;
        const p = this.px(t.x, t.y, t.z);
        ends.push({ key: a.key, district: dd.id, kind: "head", x: p[0], y: p[1] });
        placed.push({ l: p[0] - 9, t: p[1] - 9, r: p[0] + 9, b: p[1] + 9 });
      }
      if (sd?.tiny) {
        const t = a.pts[0] as V3;
        const p = this.px(t.x, t.y, t.z);
        ends.push({ key: a.key, district: sd.id, kind: "tail", x: p[0], y: p[1] });
        placed.push({ l: p[0] - 6, t: p[1] - 6, r: p[0] + 6, b: p[1] + 6 });
      }
    }
    // Obstacles a count pill must never cover, whatever else is crowded: titles, flags and the key.
    const hard = [...placed];

    // 3. Count pills at the apex nearest the source third; the long form for the arches of the focused district.
    const focus = this.focusDistrict();
    const pillInfo: unknown[] = [];
    const sorted = [...this.archLbls].sort((p, q) => {
      const fp = focus && this.involves(p.a, focus) ? 1 : 0;
      const fq = focus && this.involves(q.a, focus) ? 1 : 0;
      return fq - fp || q.a.weight - p.a.weight;
    });
    for (const l of sorted) {
      const on = !focus || this.involves(l.a, focus);
      const full = Boolean(focus) && on;
      l.el.classList.toggle("is-dim", !on);
      l.el.classList.toggle("is-full", full);
      let w = l.shortW;
      if (full) {
        l.text.textContent = l.el.dataset.full ?? "";
        w = l.fullW;
      } else l.text.textContent = l.a.weight.toLocaleString("en-US");
      const h = l.h;
      let pos: [number, number] | null = null;
      const spots: [number, number][] = [];
      for (const dy of [0, -(h + 3), h + 3, -2 * (h + 3), 2 * (h + 3)])
        for (const at of l.a.pillAt) {
          const pt = l.a.pts[at];
          if (!pt) continue;
          const p = this.px(pt.x, pt.y, pt.z);
          spots.push([p[0], p[1] + dy]);
        }
      for (const p of spots) {
        const r: ScreenRect = { l: p[0] - w / 2, t: p[1] - h / 2, r: p[0] + w / 2, b: p[1] + h / 2 };
        if (inside(r) && !placed.some((q) => rectsOverlap(q, r, 2))) {
          pos = p;
          break;
        }
      }
      if (!pos) {
        // Crowded: any spot along the arch clear of the titles and flags (a pill may then touch another pill).
        for (const [dx, dy] of [
          [0, 0],
          [0, -(h + 3)],
          [0, h + 3],
          [w + 3, 0],
          [-(w + 3), 0],
          [0, -2 * (h + 3)],
          [0, 2 * (h + 3)],
        ] as const)
          for (let i = 0; i < l.a.pts.length && !pos; i += 2) {
            const pt = l.a.pts[i] as V3;
            const p = this.px(pt.x, pt.y, pt.z);
            const r: ScreenRect = {
              l: p[0] + dx - w / 2,
              t: p[1] + dy - h / 2,
              r: p[0] + dx + w / 2,
              b: p[1] + dy + h / 2,
            };
            if (inside(r) && !hard.some((q) => rectsOverlap(q, r, 2))) pos = [p[0] + dx, p[1] + dy];
          }
      }
      if (!pos) {
        const pt = l.a.pts[l.a.pillAt[0] ?? 0] as V3;
        const p = this.px(pt.x, pt.y, pt.z);
        pos = [
          Math.min(Math.max(p[0], w / 2 + 2), W - w / 2 - 2),
          Math.min(Math.max(p[1], h / 2 + 2), H - h / 2 - 2),
        ];
      }
      placed.push({ l: pos[0] - w / 2, t: pos[1] - h / 2, r: pos[0] + w / 2, b: pos[1] + h / 2 });
      show(l.el, pos[0] - w / 2, pos[1] - h / 2);
      pillInfo.push({ key: l.a.key, text: l.el.textContent, x: pos[0], y: pos[1], w, h });
    }

    // 4. Folder captions: bold strip at the front edge of a plinth, by size, only where the whole text fits.
    const capOrder = [...this.folderLbls].sort((p, q) => q.f.fns - p.f.fns || (p.f.id < q.f.id ? -1 : 1));
    let shownCaps = 0;
    for (const l of capOrder) {
      const f = l.f;
      const b = f.box;
      const x0 = b.cx - b.sx / 2;
      const x1 = b.cx + b.sx / 2;
      const z0 = b.cz - b.sz / 2;
      const z1 = b.cz + b.sz / 2;
      const fl = this.px(x0, f.top, z1);
      const fr = this.px(x1, f.top, z1);
      const bl = this.px(x0, f.top, z0);
      if (!fl[2] || !fr[2]) {
        hide(l.el);
        continue;
      }
      const br = this.px(x1, f.top, z0);
      const edgeW = Math.hypot(fr[0] - fl[0], fr[1] - fl[1]);
      const faceH = fl[1] - bl[1];
      const slope = (fr[1] - fl[1]) / Math.max(1, fr[0] - fl[0]);
      let done = false;
      if (faceH >= l.h) {
        // The whole text on the front edge (left, then right), else on the back edge; the longer form first.
        for (const v of ["full", "short"] as const) {
          const w = v === "full" ? l.fullW : l.shortW;
          if (edgeW < w * 0.78) continue;
          const spots: [number, number][] = [
            [fl[0] + 3, fl[1] + slope * (w / 2 + 3) - l.h - 3],
            [fr[0] - w - 3, fr[1] - slope * (w / 2 + 3) - l.h - 3],
            [bl[0] + 3, bl[1] + 3],
            [br[0] - w - 3, br[1] + 3],
          ];
          for (const [left, top] of spots) {
            const r: ScreenRect = { l: left, t: top, r: left + w, b: top + l.h };
            if (!inside(r) || placed.some((q) => rectsOverlap(q, r, 1))) continue;
            l.el.classList.toggle("is-full", v === "full");
            placed.push(r);
            show(l.el, left, top);
            shownCaps++;
            done = true;
            break;
          }
          if (done) break;
        }
      }
      if (!done) hide(l.el);
    }

    this.overlay.dataset.ends = JSON.stringify(ends);
    this.overlay.dataset.captions = String(shownCaps);
    this.overlay.dataset.flags = JSON.stringify(flagInfo);
    this.overlay.dataset.pills = JSON.stringify(pillInfo);
    this.overlay.dataset.districts = JSON.stringify(
      c.districts.map((d) => {
        const q = quads.get(d.id) as { fl: Pt2; fr: Pt2; bl: Pt2; br: Pt2 };
        const r = titleRects.get(d.id);
        return {
          id: d.id,
          wx: d.box.cx - d.box.sx / 2,
          wz: d.box.cz - d.box.sz / 2,
          ww: d.box.sx,
          wh: d.box.sz,
          tiny: d.tiny,
          quad: [q.bl, q.br, q.fr, q.fl],
          title: r ? [r.l, r.t, r.r, r.b] : null,
        };
      }),
    );
  }

  private involves(a: CityArch, districtId: string): boolean {
    const c = this.city;
    if (!c) return false;
    return c.districts.some((d) => d.id === districtId && (d.idx === a.srcIdx || d.idx === a.dstIdx));
  }
}
