// The three.js side of the settlements view: renderer, camera, frame loop, picking and the DOM labels.
//
// The disappearing-geometry fix lives here (see the PR for #114): the city scene used a fixed far plane (24 x the
// diagram's size) with unbounded zoom, so zooming out past it clipped every mesh while the DOM labels, placed by
// projection, stayed on screen; and it only rendered when something marked it dirty, so after the canvas lost its
// drawing buffer (a WebGL context loss and restore) it stayed blank until a pointer move happened to change the
// hover. Here the near and far planes follow the camera every frame, zoom is bounded, the scene renders every frame
// while it is alive (and on every camera change, resize or context restore while paused), and every instanced mesh
// either has bounds computed after its matrices are set or is not culled.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Scheme } from "../../theme.ts";
import { capPaintLinks, type LayerPaint, MARK_COLOURS, reviewTipLines } from "../../views/reviewModel.ts";
import { workspaceColorAt } from "../../workspacePalette.ts";
import { rectsOverlap, type ScreenRect } from "../city/labels.ts";
import { type BuiltBuildings, buildBuildings } from "./buildings3d.ts";
import { landGround, roadGround, settlementGround } from "./ground.ts";
import { tierIcon } from "./icons.ts";
import { dashesOf, type FacadeUniforms, oakGeometry, pineGeometry } from "./kit.ts";
import { buildLife, type Life } from "./life.ts";
import { color, type Look, lookFor } from "./look.ts";
import { districtOf, type Landscape, type SBuilding, type Settlement } from "./model.ts";
import { makePath, type Pt, sampleAt, segPoint } from "./path.ts";
import { rngFor } from "./rng.ts";
import type { Road } from "./roads.ts";
import { TIER_LABEL } from "./tiers.ts";

/** The review layer draws at most this many arcs (the panel lists every change). */
const MAX_ARCS = 600;

export interface SettlementTip {
  title: string;
  lines: string[];
}

export interface SettlementCallbacks {
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
  onTip(tip: SettlementTip | null, x: number, y: number): void;
  /** The animation started or stopped (pause button, reduced motion, hidden tab). */
  onPlaying?(playing: boolean): void;
}

export interface SettlementOptions {
  scheme: Scheme;
  reducedMotion: boolean;
}

export type SettlementView = "overview" | "top" | "street";

type Hit = { type: "building"; i: number } | { type: "settlement"; i: number } | { type: "road"; i: number };

const FOV = 34;
const ELEVATION = (46 * Math.PI) / 180;
const AZIMUTH = (-24 * Math.PI) / 180;

const n = (v: number): string => v.toLocaleString("en-US");

interface TitleLbl {
  el: HTMLElement;
  s: Settlement;
  w: number;
  h: number;
}
interface PillLbl {
  el: HTMLElement;
  road: Road;
  w: number;
  h: number;
}
interface DistrictLbl {
  el: HTMLElement;
  s: Settlement;
  key: string;
  w: number;
  h: number;
}

export class SettlementScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
  private readonly controls: OrbitControls;
  private readonly content = new THREE.Group();
  private readonly overlay: HTMLElement;
  private readonly ray = new THREE.Raycaster();
  private readonly ro: ResizeObserver;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly uniforms: FacadeUniforms = { uTime: { value: 0 }, uNight: { value: 0 } };
  private readonly outline: THREE.LineSegments;
  private readonly hoverOutline: THREE.LineSegments;
  private readonly ringSel: THREE.Mesh;
  private look: Look;
  private review: LayerPaint | null = null;
  private reviewGroup: THREE.Group | null = null;
  private reviewDisposables: { dispose(): void }[] = [];
  private land: Landscape | null = null;
  private built: BuiltBuildings | null = null;
  private life: Life | null = null;
  private plates: THREE.Mesh[] = [];
  private roadMeshes: THREE.Mesh[] = [];
  private statics: THREE.Object3D[] = [];
  private disposables: { dispose(): void }[] = [];
  private titles: TitleLbl[] = [];
  private pills: PillLbl[] = [];
  private districtLbls: DistrictLbl[] = [];
  private w = 1;
  private h = 1;
  private raf = 0;
  private dirty = true;
  private disposed = false;
  private playing: boolean;
  private time = 0;
  private last = 0;
  private hover: Hit | null = null;
  private selectedId: string | null = null;
  private panelHover: string | null = null;
  private down: { x: number; y: number } | null = null;
  private tween: {
    t0: number;
    ms: number;
    p0: THREE.Vector3;
    p1: THREE.Vector3;
    a0: THREE.Vector3;
    a1: THREE.Vector3;
  } | null = null;
  private autoFit = true;
  private view: SettlementView = "overview";
  private frames = 0;
  private frameMs = 0;
  private bornAt = performance.now();
  private firstFrame = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: SettlementCallbacks,
    private readonly opts: SettlementOptions,
  ) {
    this.look = lookFor(opts.scheme);
    this.playing = !opts.reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(this.renderer.domElement);
    const el = this.renderer.domElement;
    el.style.touchAction = "none";
    el.addEventListener("webglcontextlost", this.onContextLost);
    el.addEventListener("webglcontextrestored", this.onContextRestored);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.hemi, this.ambient, this.sun, this.sun.target, this.content);

    const unit = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    this.outline = new THREE.LineSegments(
      unit,
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    this.hoverOutline = new THREE.LineSegments(
      unit,
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    const ringGeo = new THREE.RingGeometry(0.97, 1.0, 96).rotateX(-Math.PI / 2);
    this.ringSel = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    for (const o of [this.outline, this.hoverOutline, this.ringSel]) {
      o.visible = false;
      o.renderOrder = 10;
      this.scene.add(o);
    }

    this.overlay = document.createElement("div");
    this.overlay.className = "s3-overlay";
    this.overlay.setAttribute("data-testid", "map3d-labels");
    host.appendChild(this.overlay);

    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.06;
    this.controls.addEventListener("change", () => this.invalidate());
    this.controls.addEventListener("start", () => {
      this.autoFit = false;
      this.tween = null;
    });
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerleave", this.onLeave);
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("dblclick", this.onDbl);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.applyLook();
    this.resize();
    this.publishState();
    this.loop();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public API

  setScheme(scheme: Scheme): void {
    if (scheme === this.look.scheme) return;
    this.look = lookFor(scheme);
    this.applyLook();
    if (this.land) this.build(this.land);
  }

  setLandscape(land: Landscape): void {
    const first = this.land === null;
    const t0 = performance.now();
    this.build(land);
    this.host.dataset.buildMs = (performance.now() - t0).toFixed(0);
    if (first) this.goto(this.view, false);
  }

  setSelected(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.updateSelection();
    this.invalidate();
  }

  setPanelHover(id: string | null): void {
    this.panelHover = id;
    this.applyEmphasis();
    this.invalidate();
  }

  /**
   * The review layer (#167), resolved against `land.buildings` (one index per building): untouched buildings fade to
   * grey, changed ones take their change's colour, hop-1 callers a soft tint, and arcs join each caller building to
   * the changed building it calls. Null clears it. Positions never change.
   */
  setReview(paint: LayerPaint | null): void {
    this.review = paint;
    this.applyReview();
    this.applyEmphasis();
    this.invalidate();
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on && !this.opts.reducedMotion;
    this.controls.autoRotateSpeed = 0.8;
    this.invalidate();
  }

  setPlaying(on: boolean): void {
    if (on === this.playing) return;
    this.playing = on;
    this.last = performance.now();
    this.publishState();
    this.cb.onPlaying?.(on);
    this.invalidate();
  }

  isPlaying(): boolean {
    return this.playing;
  }

  setView(view: SettlementView | "reset"): void {
    this.autoFit = true;
    this.view = view === "reset" ? "overview" : view;
    this.goto(this.view, !this.opts.reducedMotion);
  }

  hasId(id: string): boolean {
    return Boolean(this.land?.byId.has(id));
  }

  /** The settlement (workspace id) an id belongs to. */
  settlementOf(id: string | null): string | null {
    const l = this.land;
    const e = id ? l?.byId.get(id) : undefined;
    if (!l || !e) return null;
    if (e.type === "settlement") return l.settlements[e.i]?.id ?? null;
    return l.settlements[l.buildings[e.i]?.settlement ?? -1]?.id ?? null;
  }

  flyTo(id: string): void {
    const l = this.land;
    const e = l?.byId.get(id);
    if (!l || !e) return;
    let target: THREE.Vector3;
    let dist: number;
    if (e.type === "settlement") {
      const s = l.settlements[e.i] as Settlement;
      target = new THREE.Vector3(s.x, 0, s.z);
      dist = s.clear * 3.2 + 10;
    } else {
      const b = l.buildings[e.i] as SBuilding;
      target = new THREE.Vector3(b.x, b.h / 2, b.z);
      dist = Math.max(10, b.h * 3.5);
    }
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.35) dir.setY(0.35).normalize();
    this.autoFit = false;
    this.animateTo(target.clone().addScaledVector(dir, dist), target, !this.opts.reducedMotion);
  }

  /** Review (#171): frames building `id` and the `others` (its direct consumers) together, from the current heading. */
  flyToGroup(id: string, others: readonly string[]): void {
    const l = this.land;
    if (!l) return;
    const pts: { x: number; y: number; z: number; r: number }[] = [];
    for (const k of [id, ...others]) {
      const e = l.byId.get(k);
      if (e?.type !== "building") continue;
      const b = l.buildings[e.i] as SBuilding;
      // The sphere around the whole building: footprint and height.
      pts.push({ x: b.x, y: b.h / 2, z: b.z, r: Math.hypot(Math.hypot(b.w, b.d) / 2, b.h / 2) });
    }
    if (pts.length < 2) {
      this.flyTo(id);
      return;
    }
    const target = new THREE.Vector3();
    for (const p of pts) target.add(new THREE.Vector3(p.x, p.y, p.z));
    target.multiplyScalar(1 / pts.length);
    let radius = 0;
    for (const p of pts) radius = Math.max(radius, target.distanceTo(new THREE.Vector3(p.x, p.y, p.z)) + p.r);
    // The narrower of the vertical and horizontal half angles decides how far back the sphere fits.
    const vHalf = (FOV * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * (this.w / Math.max(1, this.h)));
    const dist = Math.max(14, (radius * 1.2) / Math.sin(Math.min(vHalf, hHalf)));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.35) dir.setY(0.35).normalize();
    this.autoFit = false;
    this.animateTo(target.clone().addScaledVector(dir, dist), target, !this.opts.reducedMotion);
  }

  /** Test hook: where the buildings `ids` project on screen now, in normalised device coordinates (-1 to 1). */
  projectIds(ids: readonly string[]): { id: string; x: number; y: number; z: number }[] {
    const l = this.land;
    if (!l) return [];
    this.camera.updateMatrixWorld(true);
    return ids.flatMap((id) => {
      const e = l.byId.get(id);
      if (e?.type !== "building") return [];
      const b = l.buildings[e.i] as SBuilding;
      const q = new THREE.Vector3(b.x, b.h / 2, b.z).project(this.camera);
      return [{ id, x: q.x, y: q.y, z: q.z }];
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerleave", this.onLeave);
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("dblclick", this.onDbl);
    el.removeEventListener("webglcontextlost", this.onContextLost);
    el.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.controls.dispose();
    this.clear();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    (this.hoverOutline.material as THREE.Material).dispose();
    this.ringSel.geometry.dispose();
    (this.ringSel.material as THREE.Material).dispose();
    this.renderer.dispose();
    // Give the context back now rather than at garbage collection: browsers cap live WebGL contexts.
    this.renderer.forceContextLoss();
    el.remove();
    this.overlay.remove();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Building

  private applyLook(): void {
    const L = this.look;
    this.scene.background = color(L.sky);
    this.scene.fog = new THREE.Fog(color(L.sky), 100, 1000);
    this.hemi.color = color(L.hemiSky);
    this.hemi.groundColor = color(L.hemiGround);
    this.hemi.intensity = L.night ? 1.05 : 1.1;
    this.ambient.intensity = L.ambient * (L.night ? 0.6 : 0.5);
    this.sun.intensity = L.sun;
    this.sun.color = color(L.night ? "#9fb3ff" : "#fff4e0");
    this.uniforms.uNight.value = L.night ? 1 : 0;
    this.invalidate();
  }

  private clearReviewArcs(): void {
    if (this.reviewGroup) this.content.remove(this.reviewGroup);
    this.reviewGroup = null;
    for (const d of this.reviewDisposables) d.dispose();
    this.reviewDisposables = [];
  }

  /** Recolours the building instances for the review layer (from their own colours) and draws its arcs. */
  private applyReview(): void {
    const land = this.land;
    const built = this.built;
    this.clearReviewArcs();
    if (!land || !built) return;
    const rv = this.review && this.review.lit.length === land.buildings.length ? this.review : null;
    const colours = MARK_COLOURS[this.look.scheme];
    const fade = color(this.look.night ? "#2b3039" : "#cfd2d8");
    const affected = color(colours.affected);
    const tmp = new THREE.Color();
    for (const p of built.pickables) {
      const attr = p.mesh.instanceColor;
      if (!attr) continue;
      let base = p.mesh.userData.baseColors as Float32Array | undefined;
      if (!base) {
        base = Float32Array.from(attr.array as ArrayLike<number>);
        p.mesh.userData.baseColors = base;
      }
      for (let i = 0; i < p.owner.length; i++) {
        tmp.setRGB(base[i * 3] as number, base[i * 3 + 1] as number, base[i * 3 + 2] as number);
        const b = p.owner[i] as number;
        if (rv) {
          const ch = rv.change[b];
          const hop = rv.hop[b] ?? 0;
          if (ch) tmp.copy(color(colours[ch])).lerp(color("#ffffff"), 0.08);
          else if (hop > 0) tmp.lerp(affected, hop === 1 ? 0.6 : 0.3);
          else {
            const l = tmp.r * 0.3 + tmp.g * 0.59 + tmp.b * 0.11;
            tmp.setRGB(l, l, l).lerp(fade, 0.65);
          }
        }
        p.mesh.setColorAt(i, tmp);
      }
      attr.needsUpdate = true;
    }
    if (!rv) {
      delete this.host.dataset.review;
      return;
    }
    // Arcs from the top of each caller building to the top of the changed one, with a cone at the changed end.
    const group = new THREE.Group();
    group.userData.review = true;
    const cone = new THREE.ConeGeometry(0.22, 0.6, 10);
    this.reviewDisposables.push(cone);
    const mats = new Map<string, THREE.MeshBasicMaterial>();
    const matOf = (kind: string): THREE.MeshBasicMaterial => {
      let m = mats.get(kind);
      if (!m) {
        m = new THREE.MeshBasicMaterial({ color: color(colours[kind as keyof typeof colours] ?? "#888888") });
        mats.set(kind, m);
        this.reviewDisposables.push(m);
      }
      return m;
    };
    const drawn: { src: string; dst: string; change: string; soft?: boolean }[] = [];
    const softMats = new Map<string, THREE.MeshBasicMaterial>();
    // A potentially affected consumer's arc is thin, faint and dashed (#173), drawn under the direct ones.
    const softOf = (kind: string): THREE.MeshBasicMaterial => {
      let m = softMats.get(kind);
      if (!m) {
        m = new THREE.MeshBasicMaterial({
          color: color(colours[kind as keyof typeof colours] ?? "#888888"),
          transparent: true,
          opacity: 0.4,
        });
        softMats.set(kind, m);
        this.reviewDisposables.push(m);
      }
      return m;
    };
    for (const l of capPaintLinks(rv.links, MAX_ARCS)) {
      const a = land.buildings[l.src];
      const b = land.buildings[l.dst];
      if (!a || !b) continue;
      const p0 = new THREE.Vector3(a.x, a.h + 0.25, a.z);
      const p2 = new THREE.Vector3(b.x, b.h + 0.25, b.z);
      const dist = p0.distanceTo(p2);
      const mid = p0.clone().add(p2).multiplyScalar(0.5);
      mid.y = Math.max(p0.y, p2.y) + Math.max(2, dist * 0.35);
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
      const mat = l.soft ? softOf(l.change) : matOf(l.change);
      if (l.soft) {
        for (const piece of dashesOf(curve, 0.9, 0.55)) {
          const tube = new THREE.TubeGeometry(piece, 4, 0.05, 6, false);
          this.reviewDisposables.push(tube);
          const mesh = new THREE.Mesh(tube, mat);
          mesh.renderOrder = 4;
          group.add(mesh);
        }
      } else {
        const tube = new THREE.TubeGeometry(curve, 32, 0.07 + 0.04 * Math.min(4, l.weight), 6, false);
        this.reviewDisposables.push(tube);
        const mesh = new THREE.Mesh(tube, mat);
        mesh.renderOrder = 5;
        group.add(mesh);
      }
      const tip = new THREE.Mesh(cone, mat);
      const dir = curve.getTangent(1).normalize();
      tip.position.copy(p2);
      tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      group.add(tip);
      drawn.push({ src: a.id, dst: b.id, change: l.change, ...(l.soft ? { soft: true } : {}) });
    }
    this.content.add(group);
    this.reviewGroup = group;
    const ids = (pick: (i: number) => boolean) => land.buildings.flatMap((b, i) => (pick(i) ? [b.id] : []));
    this.host.dataset.review = JSON.stringify({
      changed: ids((i) => rv.change[i] !== null),
      affected: ids((i) => !rv.change[i] && (rv.hop[i] ?? 0) > 0),
      faded: land.buildings.filter((_, i) => !rv.lit[i]).length,
      hops: Object.fromEntries(
        land.buildings.flatMap((b, i) => (!rv.change[i] && (rv.hop[i] ?? 0) > 0 ? [[b.id, rv.hop[i]]] : [])),
      ),
      links: drawn,
    });
  }

  private clear(): void {
    this.clearReviewArcs();
    this.built?.dispose();
    this.life?.dispose();
    for (const d of this.disposables) d.dispose();
    for (const o of this.statics) this.content.remove(o);
    this.content.clear();
    this.built = null;
    this.life = null;
    this.plates = [];
    this.roadMeshes = [];
    this.statics = [];
    this.disposables = [];
    for (const l of [...this.titles, ...this.pills, ...this.districtLbls]) l.el.remove();
    this.titles = [];
    this.pills = [];
    this.districtLbls = [];
  }

  private build(land: Landscape): void {
    this.clear();
    this.land = land;
    const L = this.look;
    const add = (o: THREE.Object3D) => {
      this.content.add(o);
      this.statics.push(o);
    };
    const ground = landGround(land, L);
    add(ground);
    this.disposables.push(ground.geometry, ground.material as THREE.Material);
    const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.disposables.push(groundMat);
    for (const s of land.settlements) {
      const m = settlementGround(s, L, groundMat);
      add(m);
      this.plates.push(m);
      this.disposables.push(m.geometry);
    }
    for (const r of land.roads) {
      const mat = new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 1,
      });
      const m = roadGround(r, L, mat);
      add(m);
      this.roadMeshes.push(m);
      this.disposables.push(m.geometry, mat);
    }
    this.built = buildBuildings(land, L, this.uniforms);
    add(this.built.group);
    this.buildTrees(land);
    this.life = buildLife(land, L, this.built);
    add(this.life.group);
    this.life.update(this.time);

    // Sun and shadows cover the land.
    const E = land.extent;
    this.sun.position.set(-0.55 * E * 1.4, E * 1.3, 0.75 * E * 1.4);
    this.sun.target.position.set(0, 0, 0);
    const sc = this.sun.shadow.camera;
    sc.left = -E * 1.15;
    sc.right = E * 1.15;
    sc.top = E * 1.15;
    sc.bottom = -E * 1.15;
    sc.near = 1;
    sc.far = E * 5;
    sc.updateProjectionMatrix();
    this.renderer.shadowMap.needsUpdate = true;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = E * 10;

    this.buildLabels(land);
    this.applyReview();
    this.updateSelection();
    this.applyEmphasis();
    this.publishState();
    this.invalidate();
  }

  private buildTrees(land: Landscape): void {
    const L = this.look;
    const spots: { x: number; z: number; s: number; pine: boolean }[] = [];
    for (const s of land.settlements) {
      const rnd = rngFor(`trees:${s.id}`);
      for (const t of s.plan.trees)
        spots.push({
          x: s.x + t[0],
          z: s.z + t[1],
          s: 0.8 + rnd() * 0.7,
          pine: rnd() < (s.tier === "village" ? 0.55 : 0.35),
        });
    }
    // Woods on the open land: seeded, off the plates and the roads.
    const rnd = rngFor(`woods:${land.settlements.map((s) => s.id).join("|")}`);
    const E = land.extent;
    const want = Math.round(Math.min(700, E * 4));
    const clearOf = (x: number, z: number): boolean => {
      for (const s of land.settlements) if (Math.hypot(x - s.x, z - s.z) < s.clear + 1.2) return false;
      for (const r of land.roads)
        for (let i = 0; i < r.pts.length - 1; i += 1)
          if (segPoint([x, z], r.pts[i] as Pt, r.pts[i + 1] as Pt).d < r.width / 2 + 0.9) return false;
      return true;
    };
    // Clumps: a few centres, trees round them.
    for (let c = 0; c < want / 9 && spots.length < want + 400; c++) {
      const cx = (rnd() * 2 - 1) * E * 1.15;
      const cz = (rnd() * 2 - 1) * E * 1.15;
      const k = 4 + Math.floor(rnd() * 10);
      for (let i = 0; i < k; i++) {
        const x = cx + (rnd() - 0.5) * 7;
        const z = cz + (rnd() - 0.5) * 7;
        if (clearOf(x, z)) spots.push({ x, z, s: 0.9 + rnd() * 0.9, pine: rnd() < 0.5 });
      }
    }
    const make = (pine: boolean) => {
      const list = spots.filter((t) => t.pine === pine);
      const geo = pine ? pineGeometry() : oakGeometry();
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      mesh.count = list.length;
      const base = color(pine ? L.pine : L.oak);
      const r2 = rngFor(`tree-col:${pine}`);
      list.forEach((t, i) => {
        mesh.setMatrixAt(i, new THREE.Matrix4().makeScale(t.s, t.s, t.s).setPosition(t.x, 0, t.z));
        mesh.setColorAt(i, base.clone().offsetHSL((r2() - 0.5) * 0.04, 0, (r2() - 0.5) * 0.08));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.content.add(mesh);
      this.statics.push(mesh);
      this.disposables.push(geo, mat, mesh);
    };
    make(true);
    make(false);
  }

  private buildLabels(land: Landscape): void {
    const mk = (cls: string): HTMLElement => {
      const el = document.createElement("div");
      el.className = `s3-label ${cls}`;
      el.style.visibility = "hidden";
      this.overlay.appendChild(el);
      return el;
    };
    for (const s of land.settlements) {
      const el = mk("s3-title");
      el.dataset.settlement = s.id;
      el.dataset.tier = s.tier;
      el.style.setProperty("--ws", workspaceColorAt(s.colorIndex, this.look.scheme));
      const tier = document.createElement("span");
      tier.className = "s3-tier";
      tier.appendChild(tierIcon(s.tier));
      tier.append(TIER_LABEL[s.tier]);
      const name = document.createElement("strong");
      name.className = "s3-name";
      name.textContent = s.title;
      const sub = document.createElement("span");
      sub.className = "s3-sub";
      sub.textContent = `${n(s.fns)} fn · ${n(s.files)} ${s.files === 1 ? "file" : "files"}`;
      el.append(name, tier, sub);
      this.titles.push({ el, s, w: 0, h: 0 });
    }
    const named = (id: string) => land.settlements.find((s) => s.id === id)?.title ?? id;
    land.roads.forEach((r, rank) => {
      if (r.declaredOnly || (r.cls === "lane" && rank >= 12)) return;
      const el = mk(`s3-pill s3-${r.cls}`);
      el.dataset.road = r.key;
      const flows = [...r.flows].sort((a, b) => b.weight - a.weight);
      for (const f of flows) {
        const line = document.createElement("span");
        line.className = "s3-flow";
        const src = land.settlements.find((s) => s.id === f.from);
        line.style.setProperty("--ws", src ? workspaceColorAt(src.colorIndex, this.look.scheme) : "");
        line.textContent = `${named(f.from)} → ${named(f.to)} ${n(f.weight)}`;
        el.appendChild(line);
      }
      el.title = flows
        .map((f) => `${named(f.from)} imports from ${named(f.to)}: ${n(f.weight)} imports`)
        .join("\n");
      this.pills.push({ el, road: r, w: 0, h: 0 });
    });
    for (const s of land.settlements) {
      for (const d of s.districts) {
        if (s.districts.length < 2 && s.tier !== "metropolis") continue;
        const el = mk("s3-district");
        el.dataset.district = `${s.id}:${d.key}`;
        el.textContent = `${d.title} · ${n(d.files)}`;
        el.title = `${d.path}: ${n(d.fns)} functions in ${n(d.files)} files`;
        this.districtLbls.push({ el, s, key: d.key, w: 0, h: 0 });
      }
    }
    for (const l of [...this.titles, ...this.pills, ...this.districtLbls]) {
      const r = l.el.getBoundingClientRect();
      l.w = Math.ceil(r.width);
      l.h = Math.ceil(r.height);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Selection and emphasis

  private focusSettlement(): string | null {
    if (this.panelHover) return this.panelHover;
    const l = this.land;
    if (!l) return null;
    if (this.selectedId) {
      const sid = this.settlementOf(this.selectedId);
      if (sid) return sid;
    }
    if (this.hover?.type === "settlement") return l.settlements[this.hover.i]?.id ?? null;
    if (this.hover?.type === "building")
      return l.settlements[l.buildings[this.hover.i]?.settlement ?? -1]?.id ?? null;
    return null;
  }

  private applyEmphasis(): void {
    const f = this.focusSettlement();
    this.land?.roads.forEach((r, i) => {
      const mat = this.roadMeshes[i]?.material as THREE.MeshLambertMaterial | undefined;
      if (!mat) return;
      // With the review layer on, the roads recede so the review's arcs lead.
      const on = (!f || r.a === f || r.b === f) && !this.review;
      mat.opacity = on ? 1 : this.review ? 0.3 : 0.35;
      mat.depthWrite = on;
    });
    this.dirtyLabels = true;
  }

  private dirtyLabels = true;

  private setOutline(o: THREE.LineSegments, b: SBuilding | null, hover: boolean): void {
    if (!b) {
      o.visible = false;
      return;
    }
    o.visible = true;
    o.position.set(b.x, 0, b.z);
    o.rotation.set(0, b.rot, 0);
    o.scale.set(b.w + 0.25, b.h + 0.6, b.d + 0.25);
    (o.material as THREE.LineBasicMaterial).color.set(
      hover ? (this.look.night ? "#ffd43b" : "#e8590c") : this.look.night ? "#ffffff" : "#0b0e14",
    );
  }

  private updateSelection(): void {
    const l = this.land;
    const e = this.selectedId ? l?.byId.get(this.selectedId) : undefined;
    this.setOutline(this.outline, e?.type === "building" ? (l?.buildings[e.i] ?? null) : null, false);
    const s = e?.type === "settlement" ? l?.settlements[e.i] : undefined;
    if (s) {
      this.ringSel.visible = true;
      this.ringSel.position.set(s.x, 0.2, s.z);
      this.ringSel.scale.setScalar(s.clear + 0.6);
      (this.ringSel.material as THREE.MeshBasicMaterial).color.set(this.look.night ? "#ffffff" : "#0b0e14");
    } else this.ringSel.visible = false;
    this.applyEmphasis();
  }

  // ---------------------------------------------------------------------------------------------------------------
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
    if (this.land && this.autoFit) this.goto(this.view, false);
    this.invalidate();
  }

  private fit(view: SettlementView): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const l = this.land;
    if (view === "street" && l && l.settlements.length > 0) {
      // Down an avenue of the biggest settlement towards its centre: the radial street on the camera's side.
      const s = [...l.settlements].sort((a, b) => b.fns - a.fns)[0] as Settlement;
      const want = Math.atan2(Math.cos(AZIMUTH), Math.sin(AZIMUTH));
      let ang = want;
      let best = Number.POSITIVE_INFINITY;
      for (const st of s.plan.streets) {
        if (st.kind === "ring" || st.pts.length !== 2) continue;
        const p = st.pts[1] as Pt;
        const a = Math.atan2(p[1], p[0]);
        const d = Math.abs(Math.atan2(Math.sin(a - want), Math.cos(a - want)));
        if (d < best) {
          best = d;
          ang = a;
        }
      }
      const R = s.plan.built;
      const target = new THREE.Vector3(s.x + Math.cos(ang) * R * 0.2, 2.2, s.z + Math.sin(ang) * R * 0.2);
      const pos = new THREE.Vector3(s.x + Math.cos(ang) * (R + 4), 3.2, s.z + Math.sin(ang) * (R + 4));
      return { pos, target };
    }
    const pts: THREE.Vector3[] = [];
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (const [i, s] of (l?.settlements ?? []).entries()) {
      const top = (this.built?.heights[i] ?? 2) + 1;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = s.x + Math.cos(a) * s.clear;
        const z = s.z + Math.sin(a) * s.clear;
        pts.push(new THREE.Vector3(x, 0, z));
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      pts.push(new THREE.Vector3(s.x, top, s.z));
    }
    if (pts.length === 0) return { pos: new THREE.Vector3(0, 60, 60), target: new THREE.Vector3() };
    const target = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const dir =
      view === "top"
        ? new THREE.Vector3(0, 1, 0.0001).normalize()
        : new THREE.Vector3(
            Math.sin(AZIMUTH) * Math.cos(ELEVATION),
            Math.sin(ELEVATION),
            Math.cos(AZIMUTH) * Math.cos(ELEVATION),
          );
    const cam = new THREE.PerspectiveCamera(FOV, this.w / this.h, 0.1, 1e5);
    const ok = (d: number): boolean => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      for (const p of pts) {
        const q = p.clone().project(cam);
        if (q.z > 1 || Math.abs(q.x) > 0.95 || q.y > 0.84 || q.y < -0.8) return false;
      }
      return true;
    };
    let lo = 1;
    let hi = (l?.extent ?? 50) * 20;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid;
      else lo = mid;
    }
    // Shift the target down the screen a little: labels sit above the settlements, the key below.
    return { pos: target.clone().addScaledVector(dir, hi), target };
  }

  private goto(view: SettlementView, animate: boolean): void {
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
      ms: 700,
      p0: this.camera.position.clone(),
      p1: pos,
      a0: this.controls.target.clone(),
      a1: target,
    };
    this.invalidate();
  }

  /** Near and far planes that always contain the whole land from wherever the camera is. */
  private updateClipping(): void {
    const E = this.land?.extent ?? 50;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const reach = this.camera.position.length() + E * 2.5;
    this.camera.near = Math.max(0.05, Math.min(dist * 0.02, 2));
    this.camera.far = Math.max(reach * 1.5, dist + E * 4);
    this.camera.updateProjectionMatrix();
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = dist + E * 0.9;
      fog.far = dist + E * 5;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Pointer

  private ndc(x: number, y: number): THREE.Vector2 {
    return new THREE.Vector2((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1);
  }

  private pick(x: number, y: number): Hit | null {
    const l = this.land;
    if (!l || !this.built) return null;
    this.ray.setFromCamera(this.ndc(x, y), this.camera);
    let best: { hit: Hit; d: number } | null = null;
    for (const p of this.built.pickables) {
      const h = this.ray.intersectObject(p.mesh, false)[0];
      if (h && h.instanceId !== undefined && (!best || h.distance < best.d))
        best = { hit: { type: "building", i: p.owner[h.instanceId] as number }, d: h.distance };
    }
    if (best) return best.hit;
    const roads = this.ray.intersectObjects(this.roadMeshes, false)[0];
    const plates = this.ray.intersectObjects(this.plates, false)[0];
    if (roads && (!plates || roads.distance <= plates.distance + 0.05)) {
      const i = this.roadMeshes.indexOf(roads.object as THREE.Mesh);
      if (i >= 0) return { type: "road", i };
    }
    if (plates) {
      const i = this.plates.indexOf(plates.object as THREE.Mesh);
      if (i >= 0) return { type: "settlement", i };
    }
    return null;
  }

  private idOf(hit: Hit): string | null {
    const l = this.land;
    if (!l) return null;
    if (hit.type === "building") return l.buildings[hit.i]?.id ?? null;
    if (hit.type === "settlement") return l.settlements[hit.i]?.id ?? null;
    const r = l.roads[hit.i];
    if (!r) return null;
    return [...r.flows].sort((a, b) => b.weight - a.weight)[0]?.from ?? r.a;
  }

  private tipFor(hit: Hit): SettlementTip | null {
    const l = this.land;
    if (!l) return null;
    if (hit.type === "building") {
      const b = l.buildings[hit.i] as SBuilding;
      const s = l.settlements[b.settlement] as Settlement;
      const d = districtOf(l, b);
      return {
        title: b.path,
        lines: [
          `file · ${n(b.fns)} functions${b.loc !== null ? ` · ${n(b.loc)} lines` : ""}`,
          `${s.title} (${TIER_LABEL[s.tier].toLowerCase()})${d ? ` · ${d.title}` : ""}`,
          `${archName(b)} · ${b.role === "code" ? "source file" : b.role}`,
          ...reviewTipLines(this.review, hit.i, (k) => l.buildings[k]?.path ?? ""),
        ],
      };
    }
    if (hit.type === "settlement") {
      const s = l.settlements[hit.i] as Settlement;
      return {
        title: s.title,
        lines: [`${TIER_LABEL[s.tier]} · ${s.kind} · ${n(s.fns)} functions · ${n(s.files)} files`, s.path],
      };
    }
    const r = l.roads[hit.i] as Road;
    const named = (id: string) => l.settlements.find((s) => s.id === id)?.title ?? id;
    return {
      title: `${r.cls === "highway" ? "Highway" : r.cls === "road" ? "Road" : "Lane"}: ${named(r.a)} – ${named(r.b)}`,
      lines: r.declaredOnly
        ? ["declared in package.json only, no imports"]
        : [...r.flows]
            .sort((a, b) => b.weight - a.weight)
            .map((f) => `${named(f.from)} → ${named(f.to)}: ${n(f.weight)} imports`),
    };
  }

  private readonly onMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.buttons !== 0) {
      this.cb.onTip(null, 0, 0);
      return;
    }
    const hit = this.pick(x, y);
    const same = hit && this.hover && hit.type === this.hover.type && hit.i === this.hover.i;
    if (!same && (hit || this.hover)) {
      this.hover = hit;
      this.cb.onHover(hit && hit.type !== "road" ? this.idOf(hit) : null);
      const l = this.land;
      this.setOutline(
        this.hoverOutline,
        hit?.type === "building" ? (l?.buildings[hit.i] ?? null) : null,
        true,
      );
      this.applyEmphasis();
      this.invalidate();
    }
    this.cb.onTip(hit ? this.tipFor(hit) : null, x, y);
    this.renderer.domElement.style.cursor = hit ? "pointer" : "grab";
  };

  private readonly onLeave = (): void => {
    if (this.hover) {
      this.hover = null;
      this.cb.onHover(null);
      this.hoverOutline.visible = false;
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
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
    this.cb.onSelect(hit ? this.idOf(hit) : null);
  };

  private readonly onDbl = (e: MouseEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
    const id = hit ? this.idOf(hit) : null;
    if (!id) return;
    this.cb.onSelect(id);
    this.flyTo(id);
  };

  private readonly onVisibility = (): void => {
    // Nothing animates in a hidden tab; the clock does not jump when it comes back.
    if (document.hidden) cancelAnimationFrame(this.raf);
    else if (!this.disposed) {
      this.last = performance.now();
      this.invalidate();
      cancelAnimationFrame(this.raf);
      this.loop();
    }
    this.publishState();
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onContextRestored = (): void => {
    // The restored drawing buffer is empty: draw again now, not at the next pointer move.
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Frame loop

  private invalidate(): void {
    this.dirty = true;
    this.dirtyLabels = true;
  }

  private publishState(): void {
    const animating = this.playing && !document.hidden;
    this.host.dataset.animating = String(animating);
    this.host.dataset.playing = String(this.playing);
    if (this.life) {
      this.host.dataset.vehicles = String(this.life.counts.roadVehicles + this.life.counts.streetVehicles);
      this.host.dataset.life = JSON.stringify(this.life.counts);
    }
  }

  private loop = (): void => {
    if (this.disposed || document.hidden) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - (this.last || now)) / 1000));
    this.last = now;
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.t0) / this.tween.ms);
      const k = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, k);
      this.controls.target.lerpVectors(this.tween.a0, this.tween.a1, k);
      this.camera.lookAt(this.controls.target);
      if (t >= 1) this.tween = null;
      this.invalidate();
    }
    this.controls.update(dt);
    const animate = this.playing && this.land !== null;
    if (animate) {
      this.time += dt;
      this.life?.update(this.time);
      this.uniforms.uTime.value = this.time;
      this.dirty = true;
    }
    if (!this.dirty || !this.land) return;
    this.dirty = false;
    const t0 = performance.now();
    this.updateClipping();
    this.renderer.render(this.scene, this.camera);
    if (this.dirtyLabels) {
      this.dirtyLabels = false;
      this.placeLabels();
    }
    const ms = performance.now() - t0;
    this.frames++;
    this.frameMs += ms;
    if (!this.firstFrame) {
      this.firstFrame = true;
      this.host.dataset.firstFrameMs = (performance.now() - this.bornAt).toFixed(0);
      // Since the page started loading (performance.now() counts from navigation start).
      this.host.dataset.firstFrameAt = performance.now().toFixed(0);
    }
    this.host.dataset.frameMs = (this.frameMs / this.frames).toFixed(2);
    this.host.dataset.frames = String(this.frames);
    this.host.dataset.lifeT = this.time.toFixed(3);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Labels

  private px(x: number, y: number, z: number): [number, number, boolean] {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.w, (-v.y * 0.5 + 0.5) * this.h, v.z < 1 && v.z > -1];
  }

  private placeLabels(): void {
    const l = this.land;
    if (!l) return;
    this.camera.updateMatrixWorld();
    const W = this.w;
    const H = this.h;
    const placed: ScreenRect[] = [];
    const keyEl = this.host.parentElement?.querySelector(".map3d-key");
    const ctlEl = this.host.parentElement?.querySelector(".s3-controls");
    const hr = this.host.getBoundingClientRect();
    for (const el of [keyEl, ctlEl]) {
      if (!el) continue;
      const kr = el.getBoundingClientRect();
      placed.push({ l: kr.left - hr.left, t: kr.top - hr.top, r: kr.right - hr.left, b: kr.bottom - hr.top });
    }
    const inside = (r: ScreenRect) => r.l >= 2 && r.t >= 2 && r.r <= W - 2 && r.b <= H - 2;
    const show = (el: HTMLElement, x: number, y: number) => {
      el.style.visibility = "visible";
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    const hide = (el: HTMLElement) => {
      el.style.visibility = "hidden";
    };
    const focus = this.focusSettlement();
    const out: unknown[] = [];

    // 1. Settlement titles: above the settlement's skyline, else beside or below its plate. Always shown.
    const order = [...this.titles].sort((a, b) => b.s.fns - a.s.fns || (a.s.id < b.s.id ? -1 : 1));
    for (const t of order) {
      const s = t.s;
      const i = l.settlements.indexOf(s);
      const top = (this.built?.heights[i] ?? 2) + 0.8;
      const a = this.px(s.x, top, s.z);
      // The settlement's outline on screen (plate rim and skyline): the title goes just outside it.
      let hl = a[0];
      let hr2 = a[0];
      let ht = a[1];
      let hb = a[1];
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2;
        const q = this.px(s.x + Math.cos(ang) * s.clear, 0, s.z + Math.sin(ang) * s.clear);
        hl = Math.min(hl, q[0]);
        hr2 = Math.max(hr2, q[0]);
        ht = Math.min(ht, q[1]);
        hb = Math.max(hb, q[1]);
      }
      const cx = (hl + hr2) / 2;
      const cy = (ht + hb) / 2;
      // Behind the camera or off screen (close-up views): no title.
      const centre = this.px(s.x, 0, s.z);
      // Close to the ground, far settlements are specks behind the buildings: only the near ones keep a title.
      const close = this.camera.position.y < l.extent * 0.25;
      if (
        !centre[2] ||
        centre[0] < -40 ||
        centre[0] > W + 40 ||
        centre[1] < -40 ||
        centre[1] > H + 40 ||
        (close && Math.hypot(s.x - this.controls.target.x, s.z - this.controls.target.z) > s.clear * 1.2)
      ) {
        hide(t.el);
        continue;
      }
      const cands: [number, number][] = [
        [cx - t.w / 2, ht - t.h - 4],
        [cx - t.w / 2, hb + 4],
        [hr2 + 6, cy - t.h / 2],
        [hl - t.w - 6, cy - t.h / 2],
        [hl, ht - t.h - 4],
        [hr2 - t.w, ht - t.h - 4],
        [hl, hb + 4],
        [hr2 - t.w, hb + 4],
        [cx - t.w / 2, ht - 2 * t.h - 8],
        [cx - t.w / 2, hb + t.h + 8],
        // Inside the outline, over the plate, as a last resort.
        [cx - t.w / 2, ht + 6],
        [cx - t.w / 2, hb - t.h - 6],
      ];
      let spot: [number, number] | null = null;
      for (const c of cands) {
        const r = { l: c[0], t: c[1], r: c[0] + t.w, b: c[1] + t.h };
        if (inside(r) && !placed.some((p) => rectsOverlap(p, r, 2))) {
          spot = c;
          break;
        }
      }
      if (!spot) {
        const c = cands[0] as [number, number];
        spot = [Math.min(Math.max(c[0], 2), W - t.w - 2), Math.min(Math.max(c[1], 2), H - t.h - 2)];
      }
      const r = { l: spot[0], t: spot[1], r: spot[0] + t.w, b: spot[1] + t.h };
      placed.push(r);
      t.el.classList.toggle("is-focus", focus === s.id);
      t.el.classList.toggle("is-dim", Boolean(focus) && focus !== s.id);
      show(t.el, spot[0], spot[1]);
      out.push({
        id: s.id,
        tier: s.tier,
        rect: [r.l, r.t, r.r, r.b],
        anchor: [a[0], a[1]],
        centre: [centre[0], centre[1]],
      });
    }
    this.overlay.dataset.titles = JSON.stringify(out);

    // 2. Road pills: along the road, the heaviest first; lanes only when there is room.
    const pillOut: unknown[] = [];
    const sorted = [...this.pills].sort((a, b) => {
      const fa = focus && (a.road.a === focus || a.road.b === focus) ? 1 : 0;
      const fb = focus && (b.road.a === focus || b.road.b === focus) ? 1 : 0;
      return fb - fa || b.road.weight - a.road.weight;
    });
    const rankOf = new Map(l.roads.map((r, i) => [r.key, i]));
    for (const p of sorted) {
      const on = !focus || p.road.a === focus || p.road.b === focus;
      // Unfocused, only the busiest links are labelled; a focused settlement labels every link it has.
      const wanted = focus ? on : p.road.cls === "highway" || (rankOf.get(p.road.key) ?? 99) < 6;
      if (!wanted) {
        hide(p.el);
        continue;
      }
      const path = makePath(p.road.pts);
      let spot: [number, number] | null = null;
      const fracs = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.12, 0.88];
      // On the road, then just beside it; never over a title or another label. Only a highway, as a last resort, may
      // sit over another road's label (it is the one link the reader must always find).
      const shifts: [number, number][] =
        p.road.cls === "lane"
          ? [[0, 0]]
          : [
              [0, 0],
              [0, -(p.h / 2 + 6)],
              [0, p.h / 2 + 6],
              [p.w / 2 + 8, 0],
              [-(p.w / 2 + 8), 0],
              [0, -(p.h + 12)],
              [0, p.h + 12],
            ];
      const others = (r: ScreenRect, hard: boolean) =>
        (hard ? placed.slice(0, this.titles.length + 2) : placed).some((x) => rectsOverlap(x, r, 2));
      for (const hard of p.road.cls === "highway" ? [false, true] : [false])
        for (const [dx, dy] of shifts)
          for (const f of fracs) {
            if (spot) break;
            const smp = sampleAt(path, path.length * f);
            const q = this.px(smp.x, 0.2, smp.z);
            if (!q[2]) continue;
            const r = {
              l: q[0] + dx - p.w / 2,
              t: q[1] + dy - p.h / 2,
              r: q[0] + dx + p.w / 2,
              b: q[1] + dy + p.h / 2,
            };
            if (inside(r) && !others(r, hard)) spot = [r.l, r.t];
          }
      if (!spot || (!on && p.road.cls === "lane")) {
        hide(p.el);
        continue;
      }
      placed.push({ l: spot[0], t: spot[1], r: spot[0] + p.w, b: spot[1] + p.h });
      p.el.classList.toggle("is-dim", !on);
      show(p.el, spot[0], spot[1]);
      pillOut.push({
        key: p.road.key,
        cls: p.road.cls,
        text: p.el.textContent,
        rect: [spot[0], spot[1], spot[0] + p.w, spot[1] + p.h],
      });
    }
    this.overlay.dataset.pills = JSON.stringify(pillOut);

    // 3. District names: for the focused settlement, or any settlement big on screen.
    let shown = 0;
    for (const d of this.districtLbls) {
      const s = d.s;
      const rim = this.px(s.x + s.clear, 0, s.z);
      const c = this.px(s.x, 0, s.z);
      const big = Math.hypot(rim[0] - c[0], rim[1] - c[1]) > 210;
      const dd = s.districts.find((x) => x.key === d.key);
      if (!dd || !(big || focus === s.id)) {
        hide(d.el);
        continue;
      }
      const mid = (dd.a0 + dd.a1) / 2;
      const rr = (dd.r0 + dd.r1) / 2;
      const q = this.px(s.x + Math.cos(mid) * rr, 0.3, s.z + Math.sin(mid) * rr);
      const r = { l: q[0] - d.w / 2, t: q[1] - d.h / 2, r: q[0] + d.w / 2, b: q[1] + d.h / 2 };
      if (!q[2] || !inside(r) || placed.some((x) => rectsOverlap(x, r, 1))) {
        hide(d.el);
        continue;
      }
      placed.push(r);
      show(d.el, r.l, r.t);
      shown++;
    }
    this.overlay.dataset.districts = String(shown);
  }
}

export function archName(b: SBuilding): string {
  switch (b.arch) {
    case "cottage":
      return "cottage";
    case "house":
      return "house";
    case "barn":
      return "barn";
    case "shop":
      return "shop";
    case "hall":
      return "hall";
    case "block":
      return "apartment block";
    case "shopblock":
      return "block with shops";
    case "tower":
      return "tower";
    case "station":
      return "station hall";
    case "lab":
      return "lab";
    case "tank":
      return "water tower";
    case "kiosk":
      return "kiosk";
  }
}
