// Imperative three.js side of the 3D map. 3d-force-graph supplies the renderer, orbit camera, picking and node
// objects; everything else (islands, bundled arcs, particles, faint intra-island links) is added to its scene.
// Positions are frozen: the force engine never runs (cooldownTicks 0), the layout comes from layout.ts.
// Text is not drawn in WebGL: names, captions, folder labels and count pills are DOM elements in an overlay that
// is placed in screen space every frame (see `layoutLabels`), so they stay crisp and a constant size.
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject } from "3d-force-graph";
import * as THREE from "three";
import type { GraphEdge, GraphNode } from "../api.ts";
import type { Scheme } from "../theme.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import {
  type Arc,
  arcWidthPx,
  type Cluster,
  computeLayout,
  folderCaption,
  type Island,
  islandLabelPx,
  type Layout,
  pillArcIds,
  stripSharedSrc,
  type Vec3,
} from "./layout.ts";
import { type SceneTheme, sceneTheme } from "./palette.ts";

export interface TipInfo {
  title: string;
  lines: string[];
}

export interface SceneCallbacks {
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
  onTip(tip: TipInfo | null, x: number, y: number): void;
}

export interface SceneOptions {
  scheme: Scheme;
  reducedMotion: boolean;
}

type N = NodeObject & { id: string; gnode: GraphNode };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const SVG_NS = "http://www.w3.org/2000/svg";

interface NodeEntry {
  node: GraphNode;
  island: string;
  color: THREE.Color;
  material: THREE.MeshLambertMaterial;
}

interface IslandEntry {
  island: Island;
  color: THREE.Color;
  shell: THREE.Mesh;
  halo: THREE.Mesh;
  ring: THREE.LineLoop;
  pick: THREE.Mesh;
  label: Lbl;
}

interface ArcEntry {
  arc: Arc;
  mesh: THREE.Mesh;
  head: THREE.Mesh;
  curve: THREE.QuadraticBezierCurve3;
  radius: number;
  /** False for declared-dependency-only arcs while "Show declared dependencies" is off. */
  visible: boolean;
  pill: Lbl;
  /** Rank by weight among import arcs (0 = heaviest). */
  rank: number;
  /** World points along the curve (for screen-space obstacle tests). */
  samples: THREE.Vector3[];
  /** World length of the arrowhead cone, and where its base starts on the curve. */
  headLen: number;
  tHead: number;
}

type LabelKind = "island" | "dir" | "cluster" | "file" | "arc" | "hover";

/** One DOM label (plus an optional leader line in the SVG layer) taking part in screen-space de-collision. */
interface Lbl {
  el: HTMLElement;
  leader: SVGLineElement | null;
  kind: LabelKind;
  /** Island the label belongs to (arcs: null). */
  island: string | null;
  /** Higher is placed first within a kind (function count). */
  prio: number;
  /** Rank among the same kind inside its island (0 = biggest). */
  rank: number;
  /** Measured size in CSS pixels at scale 1. */
  w: number;
  h: number;
  nodeId?: string;
  world?: THREE.Vector3;
  worldR?: number;
  arc?: ArcEntry;
  /** Arc pills: size of the long "A → B: N imports" form. */
  fullW?: number;
  fullH?: number;
  shortText?: string;
  fullText?: string;
  /** Arc pills: the text node and the direction glyph (an SVG arrow rotated along the arc, towards the target). */
  textEl?: HTMLElement;
  glyph?: SVGSVGElement;
  glyphDeg?: number;
  /** Text variants, longest first, each with its measured size (file names: with extension, without). */
  variants?: { text: string; w: number; h: number }[];
  /** Folder disc this label belongs to (cluster captions, file names): the ring it is placed against. */
  ring?: { center: THREE.Vector3; r: number; rank: number };
  dim?: boolean;
  last?: string;
  shown: boolean;
  /** Frame number in which the label was last placed. */
  seen: number;
}

interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** Shade offsets by folder rank inside an island (Files level): lighter or darker than the island colour. */
const SHADES = [0, 0.3, -0.22, 0.5, -0.38, 0.14, -0.1, 0.4] as const;
const PAD = 3;
const MARGIN = 5;
/** Files level: the largest files named per folder ring, the ring size (px diameter) that earns names, and how many
 * rings per island (the biggest ones) are named by default; hovering the island names more. */
const FILES_NAMED = 2;
const BIG_RING_PX = 40;
const RINGS_NAMED = 2;
const LEADER_MAX = 24;
/** An island is "big" (name block on top of it) when its radius is at least this fraction of the largest. */
const BIG_FRACTION = 0.5;

const v3 = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p.x, p.y, p.z);

const kindOrder = (k: LabelKind): number => (k === "dir" ? 0 : k === "cluster" ? 1 : 2);

/** File name without its extension ("auditHandler.ts" -> "auditHandler"). */
const stem = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
};

const overlaps = (a: Rect, b: Rect): boolean => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

function rectHitsDisc(r: Rect, d: { x: number; y: number; r: number }): boolean {
  const nx = clamp(d.x, r.l, r.r);
  const ny = clamp(d.y, r.t, r.b);
  return Math.hypot(nx - d.x, ny - d.y) < d.r;
}

function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.9)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  return new THREE.CanvasTexture(c);
}

export class MapScene {
  private readonly graph: ForceGraph3DInstance<N>;
  private readonly extras = new THREE.Group();
  private readonly unitSphere = new THREE.SphereGeometry(1, 20, 14);
  private theme: SceneTheme;
  private scheme: Scheme;
  private readonly reduced: boolean;
  private layout: Layout | null = null;
  private edges: GraphEdge[] = [];
  private entries = new Map<string, NodeEntry>();
  private islandEntries = new Map<string, IslandEntry>();
  private arcEntries: ArcEntry[] = [];
  private edgeLines: THREE.LineSegments | null = null;
  private particles: THREE.Points | null = null;
  private particleSeeds: { arc: number; phase: number; speed: number }[] = [];
  private dot: THREE.Texture | null = null;
  private focus: string | null = null;
  private hoverArc: ArcEntry | null = null;
  private hoverNode: string | null = null;
  /** Island under the pointer (or owning the hovered node), and the island hovered in the legend. */
  private pointerIsland: string | null = null;
  private legendIsland: string | null = null;
  private showDeclared = false;
  private level: "workspaces" | "dirs" | "files" = "dirs";
  private userMoved = false;
  private labels: Lbl[] = [];
  private hoverLabel: Lbl | null = null;
  private readonly overlay: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private lastClick = { id: "", t: 0 };
  private raf = 0;
  private moveRaf = 0;
  private pointer = { x: 0, y: 0, inside: false };
  private disposed = false;
  private readonly ro: ResizeObserver | null;
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    private readonly el: HTMLElement,
    private readonly cb: SceneCallbacks,
    opts: SceneOptions,
  ) {
    this.scheme = opts.scheme;
    this.theme = sceneTheme(opts.scheme);
    this.reduced = opts.reducedMotion;
    this.graph = new ForceGraph3D(el, { controlType: "orbit" }) as unknown as ForceGraph3DInstance<N>;
    this.graph
      .backgroundColor(this.theme.background)
      .showNavInfo(false)
      .enableNodeDrag(false)
      .cooldownTicks(0)
      .warmupTicks(0)
      .nodeLabel(() => "") // the built-in tooltip is innerHTML; we draw our own from plain text
      .nodeId("id")
      .nodeThreeObjectExtend(false)
      .nodeThreeObject((n) => this.makeNodeObject(n as N))
      .onNodeHover((n) => {
        this.hoverNode = n ? (n as N).id : null;
        this.cb.onHover(this.hoverNode);
        this.setPointerIsland(
          this.hoverNode ? (this.entries.get(this.hoverNode)?.island ?? null) : this.pickIsland(),
        );
        this.updateEdgeOverlay();
        this.updateTip();
      })
      .onNodeClick((n) => this.handleNodeClick(n as N))
      .onBackgroundClick(() => this.handleBackgroundClick());
    this.graph.scene().add(this.extras);
    this.overlay = document.createElement("div");
    this.overlay.className = "m3-overlay";
    this.overlay.setAttribute("data-testid", "map3d-labels");
    this.overlay.setAttribute("data-edges", "0");
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("class", "m3-leaders");
    this.overlay.appendChild(this.svg);
    el.appendChild(this.overlay);
    this.applyOverlayTheme();
    const dom = this.graph.renderer().domElement;
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("pointerleave", this.onPointerLeave);
    this.ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
    this.ro?.observe(el);
    this.resize();
    const controls = this.controls();
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.7;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    (this.graph.controls() as unknown as THREE.EventDispatcher<{ start: object }>).addEventListener(
      "start",
      () => {
        this.userMoved = true;
      },
    );
    this.raf = requestAnimationFrame(this.tick);
  }

  // ---- public API -------------------------------------------------------------------------------------------

  setScheme(scheme: Scheme): void {
    this.scheme = scheme;
    this.theme = sceneTheme(scheme);
    this.graph.backgroundColor(this.theme.background);
    this.applyOverlayTheme();
    if (this.layout) this.rebuild(this.layout);
  }

  private applyOverlayTheme(): void {
    const s = this.overlay.style;
    s.setProperty("--m3-fg", this.theme.labelText);
    s.setProperty("--m3-bg", this.theme.labelBg);
    s.setProperty("--m3-leader", this.scheme === "dark" ? "rgba(243,245,249,0.55)" : "rgba(18,21,28,0.5)");
  }

  setData(nodes: GraphNode[], edges: GraphEdge[]): Layout {
    this.edges = edges;
    const layout = computeLayout({ nodes, edges });
    this.layout = layout;
    this.nodesById = new Map(nodes.map((n) => [n.id, n]));
    this.level = nodes.some((n) => n.kind === "file" || n.kind === "folded")
      ? "files"
      : nodes.some((n) => n.kind === "dir")
        ? "dirs"
        : "workspaces";
    this.overlay.setAttribute("data-level", this.level);
    this.userMoved = false;
    this.refDist = this.fitDistance();
    this.rebuild(layout);
    this.resetCamera(false);
    return layout;
  }

  setFocus(id: string | null): void {
    this.focus = id;
    this.applyHighlight();
    this.controls().autoRotate = this.autoRotateWanted && id === null;
  }

  private autoRotateWanted = false;
  private nodesById = new Map<string, GraphNode>();

  setAutoRotate(on: boolean): void {
    this.autoRotateWanted = on && !this.reduced;
    this.controls().autoRotate = this.autoRotateWanted && this.focus === null;
  }

  /** Legend row hover: highlights the island in the scene and reveals its labels and arcs. */
  setLegendHover(id: string | null): void {
    if (this.legendIsland === id) return;
    this.legendIsland = id;
    this.applyIslandsAndArcs();
  }

  setShowDeclared(on: boolean): void {
    if (this.showDeclared === on) return;
    this.showDeclared = on;
    for (const ae of this.arcEntries) this.syncArcVisibility(ae);
    this.applyIslandsAndArcs();
  }

  resetCamera(animate = true): void {
    this.userMoved = false;
    const d = this.layout?.viewDir ?? { x: 0.1, y: 0.3, z: 0.95 };
    const dist = this.fitDistance();
    this.graph.cameraPosition(
      { x: d.x * dist, y: d.y * dist, z: d.z * dist },
      { x: 0, y: 0, z: 0 },
      animate ? 900 : 0,
    );
  }

  /** Distance along `viewDir` at which every island disc fits the viewport (iterated; perspective changes the fit). */
  private fitDistance(): number {
    const layout = this.layout;
    if (!layout) return 300;
    const fov = (this.graph.camera() as THREE.PerspectiveCamera).fov || 50;
    const aspect = (this.el.clientWidth || 1200) / (this.el.clientHeight || 800);
    const cam = new THREE.PerspectiveCamera(fov, aspect, 1, 1e6);
    const dir = v3(layout.viewDir);
    let dist = layout.extent * 2;
    const corners = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const;
    for (let it = 0; it < 6; it++) {
      cam.position.copy(dir).multiplyScalar(dist);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      let m = 0;
      const p = new THREE.Vector3();
      for (const isl of layout.islands) {
        for (const [sx, sy] of corners) {
          p.copy(v3(isl.center))
            .addScaledVector(right, sx * isl.radius)
            .addScaledVector(up, sy * isl.radius * 1.25) // headroom for names above and callouts around
            .project(cam);
          m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
        }
      }
      for (const a of layout.arcs) {
        if (a.dependsOnly) continue;
        const q = new THREE.QuadraticBezierCurve3(v3(a.p0), v3(a.p1), v3(a.p2));
        for (const t of [0.35, 0.5, 0.65]) {
          q.getPoint(t, p);
          p.project(cam);
          m = Math.max(m, Math.abs(p.x) * 1.02, Math.abs(p.y) * 1.02);
        }
      }
      dist = Math.max(layout.extent * 0.6, dist * (m / 0.8));
    }
    return dist;
  }

  /** World height that renders `px` pixels tall at the default camera distance. */
  private px(px: number): number {
    const fov = ((this.graph.camera() as THREE.PerspectiveCamera).fov || 50) * (Math.PI / 180);
    const h = this.el.clientHeight || 800;
    return (px / h) * 2 * this.refDist * Math.tan(fov / 2);
  }

  private refDist = 300;

  flyToNode(id: string): void {
    const p = this.layout?.positions.get(id);
    if (!p || !this.layout) return;
    const r = this.layout.nodeRadius.get(id) ?? 2;
    const island = this.entries.get(id)?.island;
    const c = island ? this.layout.islands.find((i) => i.id === island)?.center : undefined;
    this.flyTo(p, c ?? { x: 0, y: 0, z: 0 }, Math.max(24, r * 7));
  }

  flyToIsland(id: string): void {
    const isl = this.layout?.islands.find((i) => i.id === id);
    if (!isl) return;
    this.flyTo(isl.center, { x: 0, y: 0, z: 0 }, isl.radius * 3.6);
  }

  hasNode(id: string): boolean {
    return this.entries.has(id);
  }

  isIsland(id: string): boolean {
    return this.islandEntries.has(id);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.moveRaf);
    this.ro?.disconnect();
    const dom = this.graph.renderer().domElement;
    dom.removeEventListener("pointermove", this.onPointerMove);
    dom.removeEventListener("pointerleave", this.onPointerLeave);
    this.clearExtras();
    this.overlay.remove();
    this.unitSphere.dispose();
    this.dot?.dispose();
    this.graph.graphData({ nodes: [], links: [] });
    this.graph._destructor();
  }

  // ---- building ---------------------------------------------------------------------------------------------

  private controls(): {
    autoRotate: boolean;
    autoRotateSpeed: number;
    enableDamping: boolean;
    dampingFactor: number;
  } {
    return this.graph.controls() as ReturnType<MapScene["controls"]>;
  }

  private resize(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w > 0 && h > 0) {
      const changed = w !== this.lastSize.w || h !== this.lastSize.h;
      this.lastSize = { w, h };
      this.graph.width(w).height(h);
      // Re-fit on resize (inspector opening, window resize) unless the person has already moved the camera.
      if (changed && this.layout && !this.userMoved) {
        this.refDist = this.fitDistance();
        this.resetCamera(false);
      }
    }
  }

  private lastSize = { w: 0, h: 0 };

  private flyTo(target: Vec3, around: Vec3, dist: number): void {
    const dir = new THREE.Vector3(target.x - around.x, target.y - around.y, target.z - around.z);
    if (dir.length() < 1e-3) dir.set(0.3, 0.35, 1);
    dir.normalize();
    // Look slightly down so labels above the target stay in view.
    dir.y += 0.25;
    dir.normalize();
    this.graph.cameraPosition(
      { x: target.x + dir.x * dist, y: target.y + dir.y * dist, z: target.z + dir.z * dist },
      target,
      900,
    );
  }

  private clearExtras(): void {
    for (const l of this.labels) {
      l.el.remove();
      l.leader?.remove();
    }
    this.labels = [];
    this.lastKey = "";
    this.hoverLabel = null;
    this.extras.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const x of mat) x.dispose();
      else mat?.dispose?.();
    });
    this.extras.clear();
    this.islandEntries.clear();
    this.arcEntries = [];
    this.edgeLines = null;
    this.particles = null;
    this.particleSeeds = [];
  }

  private islandColor(i: Island): THREE.Color {
    return new THREE.Color(workspaceColorAt(i.index, this.scheme));
  }

  /** A DOM label; its size is measured once everything is attached (`measureLabels`). */
  private makeLabel(
    kind: LabelKind,
    island: string | null,
    prio: number,
    rank: number,
    build: (el: HTMLElement) => void,
    opts: { leader?: boolean; color?: string; cls?: string } = {},
  ): Lbl {
    const el = document.createElement("div");
    el.className = `m3-label m3-${kind}${opts.cls ? ` ${opts.cls}` : ""}`;
    el.style.visibility = "hidden";
    build(el);
    this.overlay.appendChild(el);
    let leader: SVGLineElement | null = null;
    if (opts.leader !== false) {
      leader = document.createElementNS(SVG_NS, "line");
      leader.setAttribute("class", "m3-leader");
      if (opts.color) leader.style.stroke = opts.color;
      leader.style.visibility = "hidden";
      this.svg.appendChild(leader);
    }
    const lbl: Lbl = { el, leader, kind, island, prio, rank, w: 0, h: 0, shown: false, seen: -1 };
    this.labels.push(lbl);
    return lbl;
  }

  private measureLabels(): void {
    for (const l of this.labels) {
      if (l.w > 0) continue;
      l.w = l.el.offsetWidth;
      l.h = l.el.offsetHeight;
      if (l.kind === "arc" && l.fullText !== undefined && l.shortText !== undefined && l.textEl) {
        l.el.classList.add("m3-full");
        l.textEl.textContent = l.fullText;
        l.fullW = l.el.offsetWidth;
        l.fullH = l.el.offsetHeight;
        l.el.classList.remove("m3-full");
        l.textEl.textContent = l.shortText;
      }
      if (l.variants) {
        for (const v of l.variants) {
          l.el.textContent = v.text;
          v.w = l.el.offsetWidth;
          v.h = l.el.offsetHeight;
        }
        const first = l.variants[0];
        if (first) {
          l.el.textContent = first.text;
          l.w = first.w;
          l.h = first.h;
        }
      }
    }
  }

  private rebuild(layout: Layout): void {
    this.clearExtras();
    this.entries = new Map();
    const byIsland = new Map<string, GraphNode[]>();
    const islandOf = new Map<string, Island>();
    for (const isl of layout.islands) {
      for (const id of isl.nodeIds) islandOf.set(id, isl);
    }
    const graphNodes: N[] = [];
    for (const [id, p] of layout.positions) {
      const isl = islandOf.get(id) as Island;
      const node = this.nodesById.get(id) as GraphNode;
      const list = byIsland.get(isl.id) ?? [];
      list.push(node);
      byIsland.set(isl.id, list);
      graphNodes.push({ id, gnode: node, x: p.x, y: p.y, z: p.z, fx: p.x, fy: p.y, fz: p.z } as N);
    }
    this.islandOfNode = islandOf;
    this.graph.graphData({ nodes: graphNodes, links: [] });
    const maxR = Math.max(1, ...layout.islands.map((i) => i.radius));

    // Islands: translucent shell + back-face halo + equator ring; the name block is a DOM label.
    for (const isl of layout.islands) {
      const color = this.islandColor(isl);
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(isl.radius, 40, 28),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, depthWrite: false }),
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(isl.radius, 40, 28),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.1,
          side: THREE.BackSide,
          depthWrite: false,
        }),
      );
      const ringPts: THREE.Vector3[] = [];
      for (let k = 0; k < 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(a) * isl.radius, 0, Math.sin(a) * isl.radius));
      }
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(ringPts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
      );
      const group = new THREE.Group();
      group.position.copy(v3(isl.center));
      group.add(halo, shell, ring);

      // One block: the name (size follows importance) and a smaller caption, in the same rounded box.
      const hex = `#${color.getHexString()}`;
      const label = this.makeLabel(
        "island",
        isl.id,
        isl.functions,
        0,
        (el) => {
          el.style.borderColor = hex;
          el.setAttribute("data-island", isl.id);
          el.setAttribute("data-big", isl.radius >= maxR * BIG_FRACTION ? "true" : "false");
          const name = document.createElement("div");
          name.className = "m3-name";
          name.style.fontSize = `${islandLabelPx(isl.functions).toFixed(1)}px`;
          name.textContent = isl.label;
          const cap = document.createElement("div");
          cap.className = "m3-cap";
          cap.textContent = `${isl.functions.toLocaleString("en-US")} functions · ${isl.files.toLocaleString("en-US")} files · ${isl.wsKind}`;
          el.append(name, cap);
          el.title = isl.fullLabel;
        },
        { color: hex },
      );
      // Invisible pick sphere so the pointer can hit an island between its nodes.
      const pick = new THREE.Mesh(
        new THREE.SphereGeometry(isl.radius, 16, 12),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      group.add(pick);
      this.extras.add(group);
      this.islandEntries.set(isl.id, { island: isl, color, shell, halo, ring, pick, label });
    }

    // Folder rings (Files level): faint flat rings on the disc that faces the default camera, one per folder, and
    // a slightly different shade of dots per folder. The Folders level draws the folders themselves as spheres.
    this.clusterRank = new Map();
    const perIsland = new Map<string, number>();
    for (const c of layout.clusters) perIsland.set(c.island, (perIsland.get(c.island) ?? 0) + 1);
    const facing = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      v3(layout.viewDir).normalize(),
    );
    for (const c of layout.clusters) {
      for (const id of c.nodeIds) this.clusterRank.set(id, c.rank);
      if (this.level !== "files" || (perIsland.get(c.island) ?? 0) < 2) continue;
      const color = this.islandEntries.get(c.island)?.color;
      if (!color) continue;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * c.radius, Math.sin(a) * c.radius, 0));
      }
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }),
      );
      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(c.radius, 48),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.07,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const g = new THREE.Group();
      g.position.copy(v3(c.center));
      g.quaternion.copy(facing);
      g.add(fill, ring);
      this.extras.add(g);
    }

    this.buildNodeLabels(layout, byIsland);

    // Import links between nodes are not drawn by default (a web of thin lines hides the picture); the links of
    // the hovered or selected node are added on demand (`updateEdgeOverlay`).
    this.edgeLines = null;

    // Bundled arcs between islands, with arrowheads just outside the target island.
    const headLen = this.px(17);
    const maxWeight = Math.max(1, ...layout.arcs.filter((a) => !a.dependsOnly).map((a) => a.weight));
    for (const arc of layout.arcs) {
      const src = this.islandEntries.get(arc.src);
      const dst = this.islandEntries.get(arc.dst);
      if (!src || !dst) continue;
      const curve = new THREE.QuadraticBezierCurve3(v3(arc.p0), v3(arc.p1), v3(arc.p2));
      const radius = this.px(arcWidthPx(arc.weight) / 2);
      // The tube stops where the arrowhead's base starts, so the head is the visible end of the arc.
      const total = curve.getLength();
      const tEnd = clamp(1 - headLen / Math.max(total, 1e-6), 0.5, 0.98);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 40; i++) pts.push(curve.getPoint((tEnd * i) / 40));
      const tubeCurve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
      const geo = new THREE.TubeGeometry(tubeCurve, 56, radius, 8, false);
      const colors: number[] = [];
      const ringVerts = 9;
      const c = new THREE.Color();
      for (let i = 0; i <= 56; i++) {
        c.copy(src.color).lerp(dst.color, (i / 56) * tEnd);
        for (let k = 0; k < ringVerts; k++) colors.push(c.r, c.g, c.b);
      }
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5 }),
      );
      const tangent = curve.getTangent(1).normalize();
      const headR = Math.max(this.px(6.5), radius * 2.4);
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(headR, headLen, 20),
        new THREE.MeshBasicMaterial({ color: dst.color, transparent: true, opacity: 1 }),
      );
      head.position.copy(curve.getPoint(1).addScaledVector(tangent, -headLen / 2));
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
      this.extras.add(mesh, head);
      // Count pill ("24" and a small arrow along the arc, towards the importing target) on every arc; the long
      // "A → B: N imports" form while an endpoint is active.
      const from = src.island.label;
      const to = dst.island.label;
      const shortText = arc.dependsOnly ? "dep" : `${arc.weight.toLocaleString("en-US")}`;
      const fullText = `${from} → ${to}: ${arc.dependsOnly ? "declared dependency" : `${arc.weight.toLocaleString("en-US")} imports`}`;
      const light = arc.dependsOnly || arc.weight < maxWeight * 0.06;
      const pill = this.makeLabel(
        "arc",
        null,
        arc.weight,
        0,
        (el) => {
          el.setAttribute("data-arc", arc.id);
          el.setAttribute("data-weight", String(arc.weight));
          const t = document.createElement("span");
          t.className = "m3-pt";
          t.textContent = shortText;
          const g = document.createElementNS(SVG_NS, "svg");
          g.setAttribute("class", "m3-pa");
          g.setAttribute("viewBox", "0 0 12 10");
          g.setAttribute("aria-hidden", "true");
          const path = document.createElementNS(SVG_NS, "path");
          path.setAttribute("d", "M1 5H10.5M6.8 1.4L10.8 5L6.8 8.6");
          g.appendChild(path);
          el.append(t, g);
        },
        { leader: false, cls: light ? "m3-arc-lo" : "" },
      );
      pill.textEl = pill.el.querySelector(".m3-pt") as HTMLElement;
      pill.glyph = pill.el.querySelector("svg") as SVGSVGElement;
      pill.shortText = shortText;
      pill.fullText = fullText;
      const samples: THREE.Vector3[] = [];
      for (let i = 0; i <= 32; i++) samples.push(curve.getPoint(i / 32));
      const ae: ArcEntry = {
        arc,
        mesh,
        head,
        curve,
        radius,
        visible: true,
        pill,
        rank: 999,
        samples,
        headLen,
        tHead: tEnd,
      };
      pill.arc = ae;
      this.syncArcVisibility(ae);
      this.arcEntries.push(ae);
    }
    [...this.arcEntries]
      .filter((a) => !a.arc.dependsOnly)
      .sort((a, b) => b.arc.weight - a.arc.weight || (a.arc.id < b.arc.id ? -1 : 1))
      .forEach((a, i) => {
        a.rank = i;
      });

    // Directional particles: skipped under prefers-reduced-motion (the arrowheads still show direction).
    if (!this.reduced && this.arcEntries.length > 0) {
      this.dot ??= dotTexture();
      this.particleSeeds = [];
      this.arcEntries.forEach((ae, ai) => {
        const count = clamp(Math.round(Math.sqrt(ae.arc.weight) / 2), 1, 5);
        for (let k = 0; k < count; k++) {
          this.particleSeeds.push({
            arc: ai,
            phase: k / count,
            speed: 0.07 + Math.min(0.1, ae.arc.weight / 800),
          });
        }
      });
      const n = this.particleSeeds.length;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(new Array(n * 3).fill(0), 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(n * 3).fill(1), 3));
      this.particles = new THREE.Points(
        g,
        new THREE.PointsMaterial({
          size: this.px(9),
          map: this.dot,
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          alphaTest: 0.05,
        }),
      );
      this.particles.frustumCulled = false;
      this.extras.add(this.particles);
      this.updateParticles(0);
    }
    this.measureLabels();
    this.applyHighlight();
  }

  /**
   * Folder labels (Folders level); folder captions and the largest file names per folder (Files level). A label is
   * created for every folder that has functions and for the top files of each folder; `layoutLabels` decides every
   * frame which ones fit. Folders without a label show their name when hovered.
   */
  private buildNodeLabels(layout: Layout, byIsland: Map<string, GraphNode[]>): void {
    this.islandClusters = new Map();
    for (const c of layout.clusters) {
      this.islandClusters.set(c.island, [...(this.islandClusters.get(c.island) ?? []), c]);
    }
    if (this.level === "dirs") {
      for (const [iid, list] of byIsland) {
        if (list.length < 2) continue; // the island name already names a lone folder
        const top = [...list].sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
        const names = stripSharedSrc(top.map((n) => n.label));
        top.forEach((n, i) => {
          const p = layout.positions.get(n.id);
          if (!p) return;
          const text = folderCaption(names[i] as string, n.size);
          const lbl = this.makeLabel("dir", iid, n.size, i, (el) => {
            el.textContent = text;
            el.title = `${n.label}: ${n.size.toLocaleString("en-US")} functions`;
          });
          // One line ("lib · 222 fn"), or two lines ("lib" over "222 fn") for a tight spot.
          lbl.variants = [
            { text, w: 0, h: 0 },
            { text: `${names[i]}\n${n.size.toLocaleString("en-US")} fn`, w: 0, h: 0 },
          ];
          lbl.nodeId = n.id;
          lbl.world = v3(p);
          lbl.worldR = layout.nodeRadius.get(n.id) ?? 2;
        });
      }
    } else if (this.level === "files") {
      for (const [iid, cs] of this.islandClusters) {
        const names = stripSharedSrc(cs.map((c) => (c.key === "." ? "(root)" : c.key)));
        if (cs.length >= 2) {
          cs.forEach((c, i) => {
            const lbl = this.makeLabel(
              "cluster",
              iid,
              c.functions,
              c.rank,
              (el) => {
                el.textContent = folderCaption(names[i] as string, c.functions);
                el.title = `${c.key}: ${c.functions.toLocaleString("en-US")} functions in ${c.files} files`;
              },
              { leader: true },
            );
            lbl.world = v3(c.center);
            lbl.worldR = c.radius;
          });
        }
        for (const c of cs) {
          const top = c.nodeIds
            .map((id) => this.nodesById.get(id))
            .filter((n): n is GraphNode => !!n)
            .sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1))
            .slice(0, FILES_NAMED);
          top.forEach((n, i) => {
            const p = layout.positions.get(n.id);
            if (!p) return;
            const full = folderCaption(n.label, n.size);
            const short = folderCaption(stem(n.label), n.size);
            const lbl = this.makeLabel("file", iid, n.size, i, (el) => {
              el.textContent = full;
              el.title = n.path ?? n.label;
            });
            lbl.variants =
              full === short
                ? [{ text: full, w: 0, h: 0 }]
                : [
                    { text: full, w: 0, h: 0 },
                    { text: short, w: 0, h: 0 },
                  ];
            lbl.nodeId = n.id;
            lbl.world = v3(p);
            lbl.worldR = layout.nodeRadius.get(n.id) ?? 1;
            lbl.ring = { center: v3(c.center), r: c.radius, rank: c.rank };
          });
        }
      }
    }
  }

  private islandClusters = new Map<string, Cluster[]>();

  private islandOfNode = new Map<string, Island>();
  private clusterRank = new Map<string, number>();

  private makeNodeObject(n: N): THREE.Object3D {
    const isl = this.islandOfNode.get(n.id) as Island;
    const color = this.islandColor(isl);
    const shade = SHADES[(this.clusterRank.get(n.id) ?? 0) % SHADES.length] as number;
    if (shade > 0) color.lerp(new THREE.Color("#ffffff"), shade);
    else if (shade < 0) color.lerp(new THREE.Color("#000000"), -shade);
    const r = this.layout?.nodeRadius.get(n.id) ?? 2;
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(this.unitSphere, material);
    mesh.scale.setScalar(r);
    const group = new THREE.Group();
    group.add(mesh);
    this.entries.set(n.id, { node: n.gnode, island: isl.id, color, material });
    return group;
  }

  // ---- highlight --------------------------------------------------------------------------------------------

  /** Nodes and islands that stay lit for the current focus; null means "no selection, show everything". */
  private selection(): { nodes: Set<string>; islands: Set<string> } | null {
    const f = this.focus;
    if (f === null || !this.layout) return null;
    const nodes = new Set<string>();
    const islands = new Set<string>();
    if (this.islandEntries.has(f)) {
      islands.add(f);
      for (const a of this.layout.arcs) {
        if (a.src === f || a.dst === f) {
          islands.add(a.src);
          islands.add(a.dst);
        }
      }
      const inIsland = new Set(this.islandEntries.get(f)?.island.nodeIds);
      for (const id of inIsland) nodes.add(id);
      for (const e of this.edges) {
        if (inIsland.has(e.src) && this.entries.has(e.dst)) nodes.add(e.dst);
        if (inIsland.has(e.dst) && this.entries.has(e.src)) nodes.add(e.src);
      }
      return { nodes, islands };
    }
    const own = this.entries.get(f);
    if (!own) return { nodes, islands }; // focus names something not drawn: dim everything
    nodes.add(f);
    for (const e of this.edges) {
      if (e.src === f && this.entries.has(e.dst)) nodes.add(e.dst);
      if (e.dst === f && this.entries.has(e.src)) nodes.add(e.src);
    }
    for (const id of nodes) islands.add(this.entries.get(id)?.island ?? "");
    islands.add(own.island);
    return { nodes, islands };
  }

  /** Island whose arcs and labels are emphasised: the hovered one, else the selected one (or the selected node's). */
  private activeIsland(): string | null {
    const hover = this.pointerIsland ?? this.legendIsland;
    if (hover) return hover;
    const f = this.focus;
    if (f === null) return null;
    if (this.islandEntries.has(f)) return f;
    return this.entries.get(f)?.island ?? null;
  }

  private arcTouches(a: Arc, island: string): boolean {
    return a.src === island || a.dst === island;
  }

  /** Opacity of an arc tube and its head, by state: no emphasis (quiet), touching the active island, or dimmed. */
  private arcOpacity(ae: ArcEntry): { tube: number; head: number } {
    if (!ae.visible) return { tube: 0, head: 0 };
    const act = this.activeIsland();
    if (!act) return { tube: 0.5, head: 1 };
    return this.arcTouches(ae.arc, act) ? { tube: 1, head: 1 } : { tube: 0.04, head: 0.08 };
  }

  private syncArcVisibility(ae: ArcEntry): void {
    ae.visible = !ae.arc.dependsOnly || this.showDeclared;
    ae.mesh.visible = ae.visible;
    ae.head.visible = ae.visible;
  }

  private applyHighlight(): void {
    const sel = this.selection();
    const bg = new THREE.Color(this.theme.background);
    const c = new THREE.Color();
    for (const [id, e] of this.entries) {
      const lit = !sel || sel.nodes.has(id);
      c.copy(e.color);
      if (!lit) c.lerp(bg, 0.86);
      e.material.color.copy(c);
    }
    for (const l of this.labels) {
      if (l.nodeId) l.dim = !!sel && !sel.nodes.has(l.nodeId);
    }
    this.applyIslandsAndArcs();
    this.updateEdgeOverlay();
  }

  /** Thin lines for the imports of the hovered (else selected) node; nothing is drawn when none is active. */
  private updateEdgeOverlay(): void {
    const layout = this.layout;
    const id = this.hoverNode ?? (this.focus && this.entries.has(this.focus) ? this.focus : null);
    const key = id ?? "";
    if (this.edgeKey === key && (this.edgeLines !== null || id === null)) return;
    this.edgeKey = key;
    this.overlay.setAttribute("data-edges", "0");
    if (this.edgeLines) {
      this.extras.remove(this.edgeLines);
      this.edgeLines.geometry.dispose();
      (this.edgeLines.material as THREE.Material).dispose();
      this.edgeLines = null;
    }
    if (!layout || !id) return;
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    const own = this.entries.get(id);
    const hits = this.edges
      .filter(
        (e) => (e.src === id || e.dst === id) && layout.positions.has(e.src) && layout.positions.has(e.dst),
      )
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
      .slice(0, 80);
    for (const e of hits) {
      const a = layout.positions.get(e.src) as Vec3;
      const b = layout.positions.get(e.dst) as Vec3;
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      c.copy(own?.color ?? new THREE.Color(this.theme.faintLink)).lerp(
        new THREE.Color(this.scheme === "dark" ? "#ffffff" : "#000000"),
        0.25,
      );
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    if (pos.length === 0) return;
    this.overlay.setAttribute("data-edges", String(hits.length));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    this.edgeLines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }),
    );
    this.extras.add(this.edgeLines);
  }

  private edgeKey = "";

  /** Island shells/labels and arcs; also runs on hover, which must not touch the (many) node materials. */
  private applyIslandsAndArcs(): void {
    const sel = this.selection();
    const hover = this.pointerIsland ?? this.legendIsland;
    for (const [id, ie] of this.islandEntries) {
      const lit = !sel || sel.islands.has(id);
      const focused = this.focus === id;
      const hot = hover === id;
      (ie.shell.material as THREE.MeshBasicMaterial).opacity = focused
        ? 0.16
        : hot
          ? 0.14
          : lit
            ? 0.07
            : 0.025;
      (ie.halo.material as THREE.MeshBasicMaterial).opacity = focused ? 0.22 : hot ? 0.2 : lit ? 0.1 : 0.03;
      (ie.ring.material as THREE.LineBasicMaterial).opacity = focused || hot ? 1 : lit ? 0.55 : 0.12;
      ie.label.dim = !(lit || hot);
    }
    for (const ae of this.arcEntries) {
      const o = this.arcOpacity(ae);
      (ae.mesh.material as THREE.MeshBasicMaterial).opacity = o.tube;
      (ae.head.material as THREE.MeshBasicMaterial).opacity = o.head;
      ae.mesh.userData.lit = ae.visible && o.tube > 0.2;
    }
  }

  // ---- interaction ------------------------------------------------------------------------------------------

  private handleNodeClick(n: N): void {
    const now = performance.now();
    const double = this.lastClick.id === n.id && now - this.lastClick.t < 450;
    this.lastClick = { id: n.id, t: now };
    this.cb.onSelect(n.id);
    if (double) this.flyToNode(n.id);
  }

  private handleBackgroundClick(): void {
    const hit = this.pickIsland();
    if (hit) {
      const now = performance.now();
      const double = this.lastClick.id === hit && now - this.lastClick.t < 450;
      this.lastClick = { id: hit, t: now };
      this.cb.onSelect(hit);
      if (double) this.flyToIsland(hit);
    } else this.cb.onSelect(null);
  }

  private ndc(): THREE.Vector2 {
    const r = this.graph.renderer().domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((this.pointer.x - r.left) / r.width) * 2 - 1,
      -((this.pointer.y - r.top) / r.height) * 2 + 1,
    );
  }

  private pickIsland(): string | null {
    this.raycaster.setFromCamera(this.ndc(), this.graph.camera());
    const picks = [...this.islandEntries.values()].map((e) => e.pick);
    const hit = this.raycaster.intersectObjects(picks, false)[0];
    if (!hit) return null;
    for (const [id, e] of this.islandEntries) if (e.pick === hit.object) return id;
    return null;
  }

  private pickArc(): ArcEntry | null {
    this.raycaster.setFromCamera(this.ndc(), this.graph.camera());
    const hit = this.raycaster.intersectObjects(
      this.arcEntries.filter((a) => a.mesh.userData.lit !== false).map((a) => a.mesh),
      false,
    )[0];
    return hit ? (this.arcEntries.find((a) => a.mesh === hit.object) ?? null) : null;
  }

  private readonly onPointerMove = (ev: PointerEvent): void => {
    this.pointer = { x: ev.clientX, y: ev.clientY, inside: true };
    if (this.moveRaf) return;
    this.moveRaf = requestAnimationFrame(() => {
      this.moveRaf = 0;
      if (this.disposed) return;
      this.hoverArc = this.hoverNode ? null : this.pickArc();
      this.setPointerIsland(
        this.hoverNode ? (this.entries.get(this.hoverNode)?.island ?? null) : this.pickIsland(),
      );
      this.updateTip();
    });
  };

  private setPointerIsland(id: string | null): void {
    if (this.pointerIsland === id) return;
    this.pointerIsland = id;
    this.applyIslandsAndArcs();
  }

  private readonly onPointerLeave = (): void => {
    this.pointer.inside = false;
    if (this.hoverNode) {
      this.hoverNode = null;
      this.cb.onHover(null);
      this.updateEdgeOverlay();
    }
    this.hoverArc = null;
    this.setPointerIsland(null);
    this.cb.onTip(null, 0, 0);
  };

  private updateTip(): void {
    const rect = this.el.getBoundingClientRect();
    const x = this.pointer.x - rect.left;
    const y = this.pointer.y - rect.top;
    if (!this.pointer.inside) return;
    if (this.hoverNode) {
      const e = this.entries.get(this.hoverNode);
      if (e) {
        const isl = this.islandEntries.get(e.island)?.island;
        const path = this.hoverNode.replace(/^(file|dir|more):/, "").replace(/^ws:[^:]*:/, "");
        this.cb.onTip(
          {
            title: e.node.label,
            lines: [`${e.node.kind} · ${isl?.fullLabel ?? ""}`, path, ...(e.node.badges ?? [])],
          },
          x,
          y,
        );
        this.setCursor("pointer");
        return;
      }
    }
    if (this.hoverArc) {
      const a = this.hoverArc.arc;
      const from = this.islandEntries.get(a.src)?.island.fullLabel ?? a.src;
      const to = this.islandEntries.get(a.dst)?.island.fullLabel ?? a.dst;
      this.cb.onTip(
        {
          title: `${from} → ${to}: ${a.dependsOnly ? "depends on" : `${a.weight} imports`}`,
          lines: a.bindings !== undefined ? [`(${a.bindings} names imported)`] : [],
        },
        x,
        y,
      );
      this.setCursor("default");
      return;
    }
    const isl = this.pickIsland();
    if (isl) {
      const i = this.islandEntries.get(isl)?.island as Island;
      this.cb.onTip(
        {
          title: i.fullLabel,
          lines: [
            `${i.wsKind} · ${i.functions} functions · ${i.files} files`,
            ...(i.emptyFolders > 0
              ? [
                  `+${i.emptyFolders} empty ${i.emptyFolders === 1 ? "folder" : "folders"} (no functions), not drawn`,
                ]
              : []),
          ],
        },
        x,
        y,
      );
      this.setCursor("pointer");
      return;
    }
    this.cb.onTip(null, 0, 0);
  }

  private setCursor(c: string): void {
    this.graph.renderer().domElement.style.cursor = c;
  }

  // ---- animation --------------------------------------------------------------------------------------------

  private readonly tick = (t: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    if (this.particles) this.updateParticles(t / 1000);
    this.layoutLabels();
  };

  private frameNo = 0;
  private lastKey = "";

  /**
   * Every frame the camera or the state changed, in screen space. Order of placement (earlier wins a collision;
   * nothing placed later may cover it):
   * 0. the hovered node's name, then the arrowheads (obstacles for every label);
   * 1. island name blocks (name + caption as one unit), fully outside every island disc, with a leader to their
   *    own island; they keep off arcs and arrowheads where there is room;
   * 2. arc count pills: every arc up to ALL_PILLS arcs (else the heaviest), in the half nearer the source, each with
   *    a small arrow along the arc; the long "A → B: N imports" form for the active island's arcs;
   * 3. folder captions (inside their sphere when it is big enough, else beside it with a short leader), folder
   *    ring captions and the largest file names (Files level).
   */
  private layoutLabels(): void {
    if (this.labels.length === 0 || !this.layout) return;
    this.syncHoverLabel();
    const cam = this.graph.camera() as THREE.PerspectiveCamera;
    const W = this.el.clientWidth || 1200;
    const H = this.el.clientHeight || 800;
    cam.updateMatrixWorld();
    const active = this.activeIsland();
    const key = `${cam.matrixWorld.elements.map((x) => x.toFixed(3)).join(",")}|${W}x${H}|${active}|${this.focus}|${this.hoverNode}|${this.showDeclared}|${this.level}|${this.labels.length}|${this.hoverLabel?.shortText ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const frame = ++this.frameNo;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const proj = (p: THREE.Vector3): { x: number; y: number; ok: boolean } => {
      tmp.copy(p).project(cam);
      return { x: ((tmp.x + 1) / 2) * W, y: ((1 - tmp.y) / 2) * H, ok: tmp.z > -1 && tmp.z < 1 };
    };
    const projR = (c: THREE.Vector3, R: number): { x: number; y: number; r: number; ok: boolean } => {
      const a = proj(c);
      const b = proj(tmp2.copy(c).addScaledVector(right, R));
      return { x: a.x, y: a.y, r: Math.hypot(a.x - b.x, a.y - b.y), ok: a.ok };
    };
    const sel = this.selection();
    void sel;

    const placed: Rect[] = [];
    const rectOf = (x: number, y: number, w: number, h: number): Rect => ({
      l: x - PAD,
      t: y - PAD,
      r: x + w + PAD,
      b: y + h + PAD,
    });
    const inView = (x: number, y: number, w: number, h: number): boolean =>
      x >= MARGIN && y >= MARGIN && x + w <= W - MARGIN && y + h <= H - MARGIN;
    const isFree = (r: Rect): boolean => !placed.some((p) => overlaps(r, p));
    const show = (
      l: Lbl,
      x: number,
      y: number,
      scale: number,
      lead: [number, number, number, number] | null,
      opacity = 1,
    ): void => {
      const k = `${Math.round(x)},${Math.round(y)},${scale},${opacity}`;
      if (l.last !== k) {
        l.el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)${scale !== 1 ? ` scale(${scale})` : ""}`;
        l.el.style.opacity = opacity === 1 ? "" : String(opacity);
        l.last = k;
      }
      l.seen = frame;
      if (l.leader) {
        if (lead) {
          l.leader.setAttribute("x1", lead[0].toFixed(1));
          l.leader.setAttribute("y1", lead[1].toFixed(1));
          l.leader.setAttribute("x2", lead[2].toFixed(1));
          l.leader.setAttribute("y2", lead[3].toFixed(1));
          l.leader.style.opacity = String(opacity);
          l.leader.style.visibility = "visible";
        } else l.leader.style.visibility = "hidden";
      }
    };
    /** Leader from the edge of a disc to the nearest point of a rectangle (null when they touch). */
    const leaderTo = (
      c: { x: number; y: number; r: number },
      x: number,
      y: number,
      w: number,
      h: number,
    ): [number, number, number, number] | null => {
      const nx = clamp(c.x, x, x + w);
      const ny = clamp(c.y, y, y + h);
      const d = Math.hypot(nx - c.x, ny - c.y);
      if (d <= c.r + 2) return null;
      return [c.x + ((nx - c.x) / d) * c.r, c.y + ((ny - c.y) / d) * c.r, nx, ny];
    };
    /** Rectangle of size w x h placed beside a disc, in direction (dx, dy), `gap` px clear of its edge. */
    const beside = (
      c: { x: number; y: number; r: number },
      dx: number,
      dy: number,
      gap: number,
      w: number,
      h: number,
    ): { x: number; y: number } => {
      const t = Math.min(w / 2 / Math.max(Math.abs(dx), 1e-3), h / 2 / Math.max(Math.abs(dy), 1e-3));
      return { x: c.x + dx * (c.r + gap + t) - w / 2, y: c.y + dy * (c.r + gap + t) - h / 2 };
    };

    // The key box (bottom-left of the canvas) is an obstacle too.
    const keyEl = this.el.parentElement?.querySelector(".map3d-key");
    if (keyEl) {
      const kb = keyEl.getBoundingClientRect();
      const hb = this.el.getBoundingClientRect();
      placed.push({
        l: kb.left - hb.left - 4,
        t: kb.top - hb.top - 4,
        r: kb.right - hb.left + 4,
        b: kb.bottom - hb.top + 4,
      });
    }

    // 0. The hovered node.
    const hl = this.hoverLabel;
    if (hl && this.hoverNode && hl.world) {
      const s = projR(hl.world, hl.worldR ?? 1);
      if (s.ok) {
        const x = clamp(s.x - hl.w / 2, MARGIN, W - MARGIN - hl.w);
        const y = Math.max(MARGIN, s.y - Math.max(s.r, 2) - 6 - hl.h);
        placed.push(rectOf(x, y, hl.w, hl.h));
        show(hl, x, y, 1, null);
      }
    }

    // Arcs on screen: polylines (obstacles for island names) and arrowhead boxes (obstacles for every label).
    const shownArcs = this.arcEntries.filter((a) => a.visible && this.arcOpacity(a).tube > 0.2);
    const headRects: Rect[] = [];
    const arcPts = shownArcs.map((a) => ({ a, pts: a.samples.map(proj) }));
    for (const { a } of arcPts) {
      const tip = proj(a.curve.getPoint(1));
      const base = proj(a.curve.getPoint(a.tHead));
      if (!tip.ok) continue;
      const m = 7;
      const box = {
        l: Math.min(tip.x, base.x) - m,
        t: Math.min(tip.y, base.y) - m,
        r: Math.max(tip.x, base.x) + m,
        b: Math.max(tip.y, base.y) + m,
      };
      headRects.push(box);
      placed.push(box);
    }
    const crossesArc = (r: Rect): boolean =>
      arcPts.some(({ pts }) =>
        pts.some((p) => p.x > r.l - 1 && p.x < r.r + 1 && p.y > r.t - 1 && p.y < r.b + 1),
      );

    // 1. Island name blocks.
    const maxR = Math.max(1, ...this.layout.islands.map((i) => i.radius));
    const scr = new Map<string, { x: number; y: number; r: number; ok: boolean }>();
    for (const [id, ie] of this.islandEntries) scr.set(id, projR(v3(ie.island.center), ie.island.radius));
    const isBig = (id: string): boolean =>
      (this.islandEntries.get(id)?.island.radius ?? 0) >= maxR * BIG_FRACTION;
    /** True when the rectangle touches an island disc (all of them, or only the big ones). */
    const hitsIsland = (r: Rect, except: string | null, bigOnly: boolean, margin = 2): boolean => {
      for (const [id, d] of scr) {
        if (id === except || !d.ok) continue;
        if (bigOnly && !isBig(id)) continue;
        if (rectHitsDisc(r, { x: d.x, y: d.y, r: d.r + margin })) return true;
      }
      return false;
    };
    const order = [...this.islandEntries.values()]
      .map((e) => e.island)
      .sort(
        (a, b) =>
          Number(b.id === active) - Number(a.id === active) ||
          Number(isBig(b.id)) - Number(isBig(a.id)) ||
          b.functions - a.functions ||
          (a.id < b.id ? -1 : 1),
      );
    const smalls = order.filter((i) => !isBig(i.id)).map((i) => scr.get(i.id) as { x: number; y: number });
    const pool = smalls.length > 1 ? smalls : [...scr.values()];
    const centroid = {
      x: pool.reduce((a, p) => a + p.x, 0) / Math.max(1, pool.length),
      y: pool.reduce((a, p) => a + p.y, 0) / Math.max(1, pool.length),
    };
    const TICK = 10;
    const ANGLES = [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100, 120, -120, 140, -140, 160, -160, 180];
    const REACH = [6, 14, 26, 44, 68, 96, 130, 170, 220];
    for (const isl of order) {
      const ie = this.islandEntries.get(isl.id) as IslandEntry;
      const l = ie.label;
      const s = scr.get(isl.id);
      if (!s?.ok) continue;
      const opacity = l.dim ? 0.4 : 1;
      const scales = this.level === "files" ? [1, 0.9, 0.8] : [1];
      let base = -Math.PI / 2; // big islands: above first
      if (!isBig(isl.id)) {
        let dx0 = s.x - centroid.x;
        let dy0 = s.y - centroid.y;
        if (Math.hypot(dx0, dy0) < 4) {
          dx0 = 0;
          dy0 = -1;
        }
        base = Math.atan2(dy0, dx0);
      }
      let done = false;
      // Pass 0 keeps off every island disc, arc line and arrowhead; later passes give up one wish at a time.
      for (const pass of [0, 1, 2, 3]) {
        for (const sc of scales) {
          const w = l.w * sc;
          const h = l.h * sc;
          for (const g of REACH) {
            for (const da of ANGLES) {
              const a = base + (da * Math.PI) / 180;
              const dx = Math.cos(a);
              const dy = Math.sin(a);
              const p = beside(s, dx, dy, Math.max(g, TICK * 0.6), w, h);
              if (pass < 3 && !inView(p.x, p.y, w, h)) continue;
              const r = rectOf(p.x, p.y, w, h);
              if (!isFree(r)) continue;
              if (pass <= 1 && hitsIsland(r, null, false)) continue;
              if (pass === 2 && hitsIsland(r, null, true)) continue;
              if (pass === 0 && crossesArc(r)) continue;
              placed.push(r);
              show(l, p.x, p.y, sc, leaderTo(s, p.x, p.y, w, h), opacity);
              done = true;
              break;
            }
            if (done) break;
          }
          if (done) break;
        }
        if (done) break;
      }
      if (!done) {
        // Last resort: never leave an island unnamed. Put it above, overlapping if it must.
        const x = clamp(s.x - l.w / 2, MARGIN, Math.max(MARGIN, W - MARGIN - l.w));
        const y = clamp(s.y - s.r - TICK - l.h, MARGIN, Math.max(MARGIN, H - MARGIN - l.h));
        placed.push(rectOf(x, y, l.w, l.h));
        show(l, x, y, 1, leaderTo(s, x, y, l.w, l.h), opacity);
      }
    }

    // For tests and debugging: where the island discs and arrowhead boxes are on screen.
    this.overlay.setAttribute(
      "data-discs",
      JSON.stringify(
        [...scr].map(([id, d]) => ({ id, x: Math.round(d.x), y: Math.round(d.y), r: Math.round(d.r) })),
      ),
    );
    this.overlay.setAttribute(
      "data-heads",
      JSON.stringify(headRects.map((r) => [r.l, r.t, r.r, r.b].map(Math.round))),
    );

    // 2. Arc count pills.
    const visible = this.arcEntries.filter((a) => a.visible);
    let toLabel: ArcEntry[];
    if (active) toLabel = visible.filter((a) => this.arcTouches(a.arc, active));
    else {
      const ids = pillArcIds(visible.map((a) => a.arc));
      toLabel = visible.filter((a) => ids.has(a.arc.id));
    }
    toLabel.sort((a, b) => b.arc.weight - a.arc.weight || (a.arc.id < b.arc.id ? -1 : 1));
    const inIsland = (x: number, y: number): boolean => {
      for (const d of scr.values()) if (d.ok && Math.hypot(x - d.x, y - d.y) < d.r) return true;
      return false;
    };
    const SOURCE_HALF = [0.3, 0.22, 0.38, 0.15, 0.46, 0.1, 0.5];
    const ANY = [0.5, 0.56, 0.44, 0.62, 0.7, 0.8, 0.9];
    for (const a of toLabel) {
      const l = a.pill;
      // The active island's arcs try the long "A → B: N imports" form first, then fall back to the short pill.
      const forms = active !== null ? [true, false] : [false];
      let done = false;
      for (const full of forms) {
        const text = full ? (l.fullText as string) : (l.shortText as string);
        if (l.textEl && l.textEl.textContent !== text) l.textEl.textContent = text;
        l.el.classList.toggle("m3-full", full);
        const w = full ? (l.fullW ?? l.w) : l.w;
        const h = full ? (l.fullH ?? l.h) : l.h;
        const ts = full ? [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8] : SOURCE_HALF;
        for (const [pass, list] of [ts, ts, ANY].entries()) {
          for (const dy of [0, -h - 2, h + 2]) {
            for (const t of list) {
              const p = proj(a.curve.getPoint(t));
              if (!p.ok) continue;
              const x = p.x - w / 2;
              const y = p.y - h / 2 + dy;
              const r = rectOf(x, y, w, h);
              if (!inView(x, y, w, h) || !isFree(r)) continue;
              if (pass === 0 && inIsland(p.x, p.y + dy)) continue;
              placed.push(r);
              show(l, x, y, 1, null);
              if (l.glyph && !full) {
                const p1 = proj(a.curve.getPoint(Math.max(0, t - 0.04)));
                const p2 = proj(a.curve.getPoint(Math.min(1, t + 0.04)));
                const deg = Math.round((Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI);
                if (l.glyphDeg !== deg) {
                  l.glyph.style.transform = `rotate(${deg}deg)`;
                  l.glyphDeg = deg;
                }
              }
              done = true;
              break;
            }
            if (done) break;
          }
          if (done) break;
        }
        if (done) break;
      }
    }

    // 3. Folder captions, folder ring captions, file names.
    const discs: { x: number; y: number; r: number; island: string; l: Lbl }[] = [];
    for (const l of this.labels) {
      if ((l.kind !== "dir" && l.kind !== "cluster") || !l.world || !l.island) continue;
      const c = projR(l.world, l.worldR ?? 1);
      if (c.ok) discs.push({ x: c.x, y: c.y, r: c.r, island: l.island, l });
    }
    const hitsOtherDisc = (r: Rect, self: Lbl | null, island: string): boolean =>
      discs.some((d) => d.l !== self && d.island === island && rectHitsDisc(r, { x: d.x, y: d.y, r: d.r }));
    const COMPASS = [0, 45, -45, 90, -90, 135, -135, 180];
    const cand = this.labels
      .filter((l) => l.kind === "dir" || l.kind === "cluster" || l.kind === "file")
      .filter((l) => !l.dim && l.island && scr.get(l.island)?.ok)
      .sort(
        (a, b) =>
          Number(b.island === active) - Number(a.island === active) ||
          kindOrder(a.kind) - kindOrder(b.kind) ||
          b.prio - a.prio ||
          (a.el.textContent ?? "").localeCompare(b.el.textContent ?? ""),
      );
    for (const l of cand) {
      if (!l.world || !l.island) continue;
      const c = projR(l.world, l.worldR ?? 1);
      if (!c.ok) continue;
      const isActive = l.island === active;
      if (l.kind === "dir") {
        const rr = Math.max(c.r, 2);
        const vs = l.variants ?? [{ text: l.el.textContent ?? "", w: l.w, h: l.h }];
        const put = (v: (typeof vs)[number], x: number, y: number, lead: boolean): void => {
          if (l.el.textContent !== v.text) l.el.textContent = v.text;
          placed.push(rectOf(x, y, v.w, v.h));
          show(l, x, y, 1, lead ? leaderTo({ x: c.x, y: c.y, r: rr }, x, y, v.w, v.h) : null);
        };
        // Inside the sphere when the text fits it, one line first, then two.
        let done = false;
        for (const v of vs) {
          const half = Math.hypot(v.w / 2, v.h / 2);
          if (half > c.r * 1.2 + 4) continue;
          const x = c.x - v.w / 2;
          const y = c.y - v.h / 2;
          if (!inView(x, y, v.w, v.h) || !isFree(rectOf(x, y, v.w, v.h))) continue;
          put(v, x, y, false);
          done = true;
          break;
        }
        // Otherwise beside it, at most LEADER_MAX px away, clear of every other sphere.
        for (const v of vs) {
          if (done) break;
          for (const off of [5, 12, 18, LEADER_MAX]) {
            for (const deg of [0, 180, -90, 90, -45, 45, 135, -135, -22, 22, 158, -158]) {
              const a = (deg * Math.PI) / 180;
              const p = beside({ x: c.x, y: c.y, r: rr }, Math.cos(a), Math.sin(a), off, v.w, v.h);
              const r = rectOf(p.x, p.y, v.w, v.h);
              if (!inView(p.x, p.y, v.w, v.h) || !isFree(r)) continue;
              if (hitsOtherDisc(r, l, l.island) || hitsIsland(r, l.island, false)) continue;
              put(v, p.x, p.y, true);
              done = true;
              break;
            }
            if (done) break;
          }
        }
        continue;
      }
      if (l.kind === "cluster") {
        if (c.r < 14 && !isActive) continue;
        const w = l.w;
        const h = l.h;
        const spots = [
          { x: c.x - w / 2, y: c.y - c.r - h / 2, lead: false },
          { x: c.x - w / 2, y: c.y + c.r - h / 2, lead: false },
        ];
        for (const off of [4, 12, LEADER_MAX]) {
          for (const deg of [-90, 90, 0, 180, -45, 45, 135, -135]) {
            const a = (deg * Math.PI) / 180;
            const p = beside(c, Math.cos(a), Math.sin(a), off, w, h);
            spots.push({ x: p.x, y: p.y, lead: true });
          }
        }
        for (const sp of spots) {
          const r = rectOf(sp.x, sp.y, w, h);
          if (!inView(sp.x, sp.y, w, h) || !isFree(r) || hitsIsland(r, l.island, false)) continue;
          if (sp.lead && hitsOtherDisc(r, l, l.island)) continue;
          placed.push(r);
          show(l, sp.x, sp.y, 1, sp.lead ? leaderTo(c, sp.x, sp.y, w, h) : null);
          break;
        }
        continue;
      }
      // File names: the largest files of a folder ring, beside the ring with a leader to the dot.
      if (!l.ring || !l.variants) continue;
      const ring = projR(l.ring.center, l.ring.r);
      const multi = (this.islandClusters.get(l.island)?.length ?? 0) >= 2;
      if (multi && !isActive && (ring.r * 2 < BIG_RING_PX || l.ring.rank >= RINGS_NAMED)) continue;
      if (multi && isActive && ring.r * 2 < BIG_RING_PX * 0.65) continue;
      const dot = { x: c.x, y: c.y, r: Math.max(c.r, 1.5) };
      let dirx = dot.x - ring.x;
      let diry = dot.y - ring.y;
      if (Math.hypot(dirx, diry) < 3) {
        dirx = 1;
        diry = 0;
      }
      const base = Math.atan2(diry, dirx);
      let done = false;
      // Beside the ring, clear of the other rings (A); then allowed over their edges (B); last, over the dots of
      // its own ring, stacked above and below the middle (C). The full name goes before the one without extension.
      for (const pass of ["A", "B"]) {
        for (const v of l.variants) {
          for (const off of pass === "A" ? [4, 10, 18, LEADER_MAX] : [4, 10, 18, 26, 36]) {
            for (const deg of COMPASS) {
              const a = base + (deg * Math.PI) / 180;
              const p = beside(ring, Math.cos(a), Math.sin(a), off, v.w, v.h);
              const r = rectOf(p.x, p.y, v.w, v.h);
              if (!inView(p.x, p.y, v.w, v.h) || !isFree(r) || hitsIsland(r, l.island, false)) continue;
              if (pass === "A" && hitsOtherDisc(r, null, l.island)) continue;
              if (l.el.textContent !== v.text) l.el.textContent = v.text;
              placed.push(r);
              show(l, p.x, p.y, 1, leaderTo(dot, p.x, p.y, v.w, v.h));
              l.el.setAttribute("data-dot", `${Math.round(dot.x)},${Math.round(dot.y)}`);
              done = true;
              break;
            }
            if (done) break;
          }
          if (done) break;
        }
        if (done) break;
      }
      if (done || !multi) continue;
      for (const v of l.variants) {
        const x = ring.x - v.w / 2;
        const y = l.rank === 0 ? ring.y - dot.r - v.h - 3 : ring.y + dot.r + 3;
        const r = rectOf(x, y, v.w, v.h);
        if (!inView(x, y, v.w, v.h) || !isFree(r) || v.w > ring.r * 2.4) continue;
        if (l.el.textContent !== v.text) l.el.textContent = v.text;
        placed.push(r);
        show(l, x, y, 1, leaderTo(dot, x, y, v.w, v.h));
        break;
      }
    }

    for (const l of this.labels) {
      if (l.seen === frame) {
        if (!l.shown) {
          l.el.style.visibility = "visible";
          l.shown = true;
        }
      } else if (l.shown || l.el.style.visibility !== "hidden") {
        l.el.style.visibility = "hidden";
        if (l.leader) l.leader.style.visibility = "hidden";
        l.shown = false;
      }
    }
  }

  /** The single label that follows the hovered node (any node, at any level). */
  private syncHoverLabel(): void {
    const id = this.hoverNode;
    if (!id) return;
    const e = this.entries.get(id);
    const p = this.layout?.positions.get(id);
    if (!e || !p) return;
    if (!this.hoverLabel)
      this.hoverLabel = this.makeLabel("hover", null, 1e9, 0, () => {}, { leader: false });
    const l = this.hoverLabel;
    const text =
      e.node.kind === "dir" || e.node.kind === "file" || e.node.kind === "folded"
        ? folderCaption(e.node.label, e.node.size)
        : e.node.label;
    if (l.shortText !== text) {
      l.shortText = text;
      l.el.textContent = text;
      l.w = 0;
      this.measureLabels();
    }
    l.world = v3(p);
    l.worldR = this.layout?.nodeRadius.get(id) ?? 2;
  }

  private updateParticles(time: number): void {
    if (!this.particles) return;
    const pos = this.particles.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.particles.geometry.getAttribute("color") as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    const bg = new THREE.Color(this.theme.background);
    const tint = new THREE.Color(this.scheme === "dark" ? "#ffffff" : "#000000");
    this.particleSeeds.forEach((s, i) => {
      const ae = this.arcEntries[s.arc] as ArcEntry;
      const u = (s.phase + time * s.speed) % 1;
      ae.curve.getPoint(u, p);
      pos.setXYZ(i, p.x, p.y, p.z);
      const src = this.islandEntries.get(ae.arc.src)?.color as THREE.Color;
      const dst = this.islandEntries.get(ae.arc.dst)?.color as THREE.Color;
      c.copy(src).lerp(dst, u).lerp(tint, 0.25);
      if (!ae.visible) {
        pos.setXYZ(i, 1e9, 1e9, 1e9);
        return;
      }
      const act = this.activeIsland();
      if (act) {
        if (!this.arcTouches(ae.arc, act)) c.lerp(bg, 0.96);
      } else c.lerp(bg, 0.4);
      col.setXYZ(i, c.r, c.g, c.b);
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}
