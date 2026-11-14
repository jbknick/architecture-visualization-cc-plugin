// Imperative three.js side of the 3D map. 3d-force-graph supplies the renderer, orbit camera, picking and node
// objects; everything else (islands, bundled arcs, particles, faint intra-island links) is added to its scene.
// Positions are frozen: the force engine never runs (cooldownTicks 0), the layout comes from layout.ts.
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject } from "3d-force-graph";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import type { GraphEdge, GraphNode } from "../api.ts";
import type { Scheme } from "../theme.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import {
  type Arc,
  arcWidthPx,
  computeLayout,
  type Island,
  islandLabelPx,
  type Layout,
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

interface NodeEntry {
  node: GraphNode;
  island: string;
  color: THREE.Color;
  material: THREE.MeshLambertMaterial;
  label: LabelItem | null;
}

interface IslandEntry {
  island: Island;
  color: THREE.Color;
  shell: THREE.Mesh;
  halo: THREE.Mesh;
  ring: THREE.LineLoop;
  labels: SpriteText[];
  pick: THREE.Mesh;
  name: LabelItem;
  sub: LabelItem;
}

interface ArcEntry {
  arc: Arc;
  mesh: THREE.Mesh;
  head: THREE.Mesh;
  curve: THREE.QuadraticBezierCurve3;
  radius: number;
  /** False for declared-dependency-only arcs while "Show declared dependencies" is off. */
  visible: boolean;
}

type LabelKind = "name" | "sub" | "node" | "arc" | "hover";

/** One text sprite taking part in screen-space de-collision. */
interface LabelItem {
  sprite: SpriteText;
  /** On-screen height in pixels at full size. */
  px: number;
  aspect: number;
  kind: LabelKind;
  /** Island the label belongs to (arcs: null). */
  island: string | null;
  /** Higher wins a collision within a kind (islands: function count). */
  prio: number;
  arc?: ArcEntry;
  nodeId?: string;
}

/** Island labels may shrink to this fraction of their size before they are hidden instead. */
const SHRINK_STEPS = [1, 0.85, 0.72] as const;
const MIN_LABEL_PX = 10.5;
/** An island must be at least this many pixels in radius on screen to show its "N functions" line unprompted. */
const SUB_MIN_RADIUS_PX = 100;
const NODE_LABEL_MIN_RADIUS_PX = 70;
const FILE_LABELS_PER_ISLAND = 8;

const v3 = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p.x, p.y, p.z);

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
  private links: THREE.LineSegments | null = null;
  private linkEdges: { a: string; b: string; island: string }[] = [];
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
  private labelItems: LabelItem[] = [];
  private hoverLabel: LabelItem | null = null;
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
        this.updateTip();
      })
      .onNodeClick((n) => this.handleNodeClick(n as N))
      .onBackgroundClick(() => this.handleBackgroundClick());
    this.graph.scene().add(this.extras);
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
    if (this.layout) this.rebuild(this.layout);
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
    const d = this.layout?.viewDir ?? { x: 0.3, y: 0.4, z: 0.85 };
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
            .addScaledVector(up, sy * isl.radius * 1.3) // headroom for the island label above the sphere
            .project(cam);
          m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
        }
      }
      dist = Math.max(layout.extent * 0.6, dist * (m / 0.9));
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
    this.labelItems = [];
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
    this.links = null;
    this.particles = null;
    this.particleSeeds = [];
  }

  private islandColor(i: Island): THREE.Color {
    return new THREE.Color(workspaceColorAt(i.index, this.scheme));
  }

  /** Labels keep a constant on-screen size: `layoutLabels` rescales and de-collides them every frame. */
  private label(
    text: string,
    px: number,
    kind: LabelKind,
    island: string | null,
    prio: number,
    extra: Partial<LabelItem> = {},
  ): LabelItem {
    const s = new SpriteText(text, 10, this.theme.labelText); // padding is relative to this height; real size is set per frame
    s.backgroundColor = this.theme.labelBg;
    s.fontWeight = kind === "name" || kind === "arc" ? "700" : "500";
    s.padding = [3, 1.5];
    s.borderRadius = 3;
    s.material.depthWrite = false;
    s.material.depthTest = false;
    s.raycast = () => {}; // labels never intercept the pointer
    const item: LabelItem = { sprite: s, px, aspect: s.scale.x / s.scale.y, kind, island, prio, ...extra };
    this.labelItems.push(item);
    return item;
  }

  private rebuild(layout: Layout): void {
    this.clearExtras();
    this.entries = new Map();
    const nodeLabelCount = new Map<string, Set<string>>();
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
    for (const [iid, list] of byIsland) {
      // The island label already names a lone node, so only multi-node islands get per-node labels.
      if (list.length < 2) continue;
      const top = [...list].sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
      const n =
        this.level === "files" ? FILE_LABELS_PER_ISLAND : clamp(Math.round(Math.sqrt(list.length)), 2, 6);
      nodeLabelCount.set(iid, new Set(top.slice(0, n).map((x) => x.id)));
    }
    this.pendingLabels = nodeLabelCount;
    this.islandOfNode = islandOf;
    this.graph.graphData({ nodes: graphNodes, links: [] });

    // Islands: translucent shell + back-face halo + equator ring + big always-facing label.
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

      // Name above the sphere's top; the "N functions" line stacks above it (see layoutLabels). Size follows
      // the island's importance (sqrt of its function count).
      const nameItem = this.label(isl.label, islandLabelPx(isl.functions), "name", isl.id, isl.functions);
      const name = nameItem.sprite;
      name.color = this.scheme === "dark" ? "#ffffff" : "#0b0e14";
      name.borderColor = `#${color.getHexString()}`;
      name.borderWidth = 1.2;
      const subItem = this.label(
        `${isl.functions} functions · ${isl.files} files · ${isl.wsKind}`,
        15,
        "sub",
        isl.id,
        isl.functions,
      );
      const sub = subItem.sprite;
      name.center.set(0.5, -0.15);
      sub.center.set(0.5, -0.15);
      name.position.set(0, isl.radius, 0);
      sub.position.set(0, isl.radius, 0);
      for (const s of [name, sub]) {
        s.renderOrder = 20;
        group.add(s);
      }
      // Invisible pick sphere so the pointer can hit an island between its nodes.
      const pick = new THREE.Mesh(
        new THREE.SphereGeometry(isl.radius, 16, 12),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      group.add(pick);
      this.extras.add(group);
      this.islandEntries.set(isl.id, {
        island: isl,
        color,
        shell,
        halo,
        ring,
        labels: [name, sub],
        pick,
        name: nameItem,
        sub: subItem,
      });
    }

    // Faint links inside islands: one LineSegments for all of them.
    const linkPos: number[] = [];
    this.linkEdges = [];
    for (const e of this.edges) {
      const a = layout.positions.get(e.src);
      const b = layout.positions.get(e.dst);
      const ia = islandOf.get(e.src);
      const ib = islandOf.get(e.dst);
      if (!a || !b || !ia || ia !== ib) continue;
      linkPos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      this.linkEdges.push({ a: e.src, b: e.dst, island: ia.id });
    }
    if (this.linkEdges.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(linkPos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(linkPos.length).fill(1), 3));
      this.links = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
      this.extras.add(this.links);
    }

    // Bundled arcs between islands.
    for (const arc of layout.arcs) {
      const src = this.islandEntries.get(arc.src);
      const dst = this.islandEntries.get(arc.dst);
      if (!src || !dst) continue;
      const curve = new THREE.QuadraticBezierCurve3(v3(arc.p0), v3(arc.p1), v3(arc.p2));
      const radius = this.px(arcWidthPx(arc.weight) / 2);
      const geo = new THREE.TubeGeometry(curve, 56, radius, 8, false);
      const colors: number[] = [];
      const ringVerts = 9;
      const c = new THREE.Color();
      for (let i = 0; i <= 56; i++) {
        c.copy(src.color).lerp(dst.color, i / 56);
        for (let k = 0; k < ringVerts; k++) colors.push(c.r, c.g, c.b);
      }
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4 }),
      );
      const tangent = curve.getTangent(1).normalize();
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(radius * 2, radius * 5, 12),
        new THREE.MeshBasicMaterial({ color: dst.color, transparent: true, opacity: 0.9 }),
      );
      head.position.copy(curve.getPoint(1).addScaledVector(tangent, -radius * 2.5));
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
      this.extras.add(mesh, head);
      const ae: ArcEntry = { arc, mesh, head, curve, radius, visible: true };
      this.syncArcVisibility(ae);
      this.arcEntries.push(ae);
      // "A → B: N imports" at the midpoint; only shown while an endpoint island is hovered or selected.
      const from = src.island.label;
      const to = dst.island.label;
      const text = `${from} → ${to}: ${arc.dependsOnly ? "declared dependency" : `${arc.weight} imports`}`;
      const item = this.label(text, 13, "arc", null, arc.weight, { arc: ae });
      item.sprite.center.set(0.5, 0.5);
      item.sprite.position.copy(curve.getPoint(0.5));
      item.sprite.renderOrder = 25;
      this.extras.add(item.sprite);
    }

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
    this.applyHighlight();
  }

  private pendingLabels = new Map<string, Set<string>>();
  private islandOfNode = new Map<string, Island>();

  private makeNodeObject(n: N): THREE.Object3D {
    const isl = this.islandOfNode.get(n.id) as Island;
    const color = this.islandColor(isl);
    const r = this.layout?.nodeRadius.get(n.id) ?? 2;
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(this.unitSphere, material);
    mesh.scale.setScalar(r);
    const group = new THREE.Group();
    group.add(mesh);
    let label: LabelItem | null = null;
    if (this.pendingLabels.get(isl.id)?.has(n.id)) {
      label = this.label(n.gnode.label, clamp(11 + r * 0.5, 11, 14), "node", isl.id, n.gnode.size, {
        nodeId: n.id,
      });
      label.sprite.center.set(0.5, -0.15);
      label.sprite.position.set(0, r, 0);
      label.sprite.renderOrder = 15;
      group.add(label.sprite);
    }
    this.entries.set(n.id, { node: n.gnode, island: isl.id, color, material, label });
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
    if (!act) return { tube: 0.38, head: 0.5 };
    return this.arcTouches(ae.arc, act) ? { tube: 1, head: 0.95 } : { tube: 0.035, head: 0.035 };
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
      if (e.label) e.label.sprite.material.opacity = lit ? 1 : 0.15;
    }
    this.applyIslandsAndArcs();
    if (this.links) {
      const attr = this.links.geometry.getAttribute("color") as THREE.BufferAttribute;
      const faint = new THREE.Color(this.theme.faintLink);
      this.linkEdges.forEach((l, i) => {
        const lit = !sel || (sel.nodes.has(l.a) && sel.nodes.has(l.b));
        const base = this.entries.get(l.a)?.color ?? faint;
        c.copy(base)
          .lerp(faint, 0.35)
          .lerp(bg, lit ? (sel ? 0.1 : 0.5) : 0.93);
        attr.setXYZ(i * 2, c.r, c.g, c.b);
        attr.setXYZ(i * 2 + 1, c.r, c.g, c.b);
      });
      attr.needsUpdate = true;
    }
  }

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
      for (const l of ie.labels) l.material.opacity = lit || hot ? 1 : 0.25;
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
        { title: i.fullLabel, lines: [`${i.wsKind} · ${i.functions} functions · ${i.files} files`] },
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

  /**
   * Every frame: size each label to its on-screen pixel height, decide which labels are eligible (detail lines
   * only for big or active islands, file labels only for the active island), then place them greedily by
   * priority in screen space. A label that would overlap an already placed one shrinks a little, else is hidden.
   * Order: the active (hovered or selected) island's labels and arcs, island names by function count, island
   * detail lines, then file and folder labels.
   */
  private layoutLabels(): void {
    const cam = this.graph.camera() as THREE.PerspectiveCamera;
    const W = this.el.clientWidth || 1200;
    const H = this.el.clientHeight || 800;
    cam.updateMatrixWorld();
    const k = (2 * Math.tan(((cam.fov || 50) * Math.PI) / 360)) / H;
    const active = this.activeIsland();
    this.syncHoverLabel();
    const world = new THREE.Vector3();
    const ndc = new THREE.Vector3();

    const eligible = (it: LabelItem): boolean => {
      if (!it.sprite.parent) return false;
      const isl = it.island ? this.islandEntries.get(it.island)?.island : undefined;
      switch (it.kind) {
        case "name":
          return true;
        case "sub":
          if (it.island === active) return true;
          return !!isl && this.islandScreenRadius(isl, cam, k) >= SUB_MIN_RADIUS_PX;
        case "arc":
          return !!it.arc?.visible && active !== null && this.arcTouches(it.arc.arc, active);
        case "hover":
          return this.hoverNode !== null;
        default:
          // file and folder labels
          if (this.level === "files") return it.island === active;
          if (it.island === active) return true;
          return !!isl && this.islandScreenRadius(isl, cam, k) >= NODE_LABEL_MIN_RADIUS_PX;
      }
    };
    const tier = (it: LabelItem): number => {
      if (it.kind === "hover" || it.kind === "arc") return 0;
      if (it.kind === "node") return it.island === active ? 2 : 3;
      if (it.island !== null && it.island === active) return 0;
      return it.kind === "name" ? 1 : 2;
    };

    this.labelItems = this.labelItems.filter((it) => it.sprite.parent !== null || it === this.hoverLabel);
    const items = this.labelItems.filter(eligible);
    for (const it of this.labelItems) if (!items.includes(it)) it.sprite.visible = false;
    const rank = (it: LabelItem): number => (it.kind === "name" ? 0 : it.kind === "sub" ? 1 : 2);
    items.sort(
      (a, b) =>
        tier(a) - tier(b) || b.prio - a.prio || rank(a) - rank(b) || (a.sprite.text < b.sprite.text ? -1 : 1),
    );

    interface Rect {
      l: number;
      r: number;
      b: number;
      t: number;
    }
    const placed: Rect[] = [];
    const PAD = 3;
    const nameH = new Map<string, number>(); // placed height of an island's name label, for stacking its detail line
    for (const it of items) {
      it.sprite.getWorldPosition(world);
      ndc.copy(world).project(cam);
      if (ndc.z > 1 || ndc.z < -1) {
        it.sprite.visible = false;
        continue;
      }
      const x = ((ndc.x + 1) / 2) * W;
      const y = ((ndc.y + 1) / 2) * H; // y grows upward
      const dist = cam.position.distanceTo(world);
      const steps = it.kind === "name" || it.kind === "sub" ? SHRINK_STEPS : ([1] as const);
      let done = false;
      for (const f of steps) {
        const hPx = it.px * f;
        if (f < 1 && hPx < MIN_LABEL_PX) break;
        const wPx = hPx * it.aspect;
        // Detail lines stack above their island's name when it is shown.
        const lift = it.kind === "sub" && it.island ? (nameH.get(it.island) ?? 0) : 0;
        const cx = 0.5;
        const cy = it.kind === "arc" ? 0.5 : -0.15 - lift / hPx;
        const rect: Rect = {
          l: x - cx * wPx - PAD,
          r: x - cx * wPx + wPx + PAD,
          b: y - cy * hPx - PAD,
          t: y - cy * hPx + hPx + PAD,
        };
        const onScreen = rect.r >= 0 && rect.l <= W && rect.t >= 0 && rect.b <= H;
        if (onScreen && placed.some((p) => rect.l < p.r && rect.r > p.l && rect.b < p.t && rect.t > p.b))
          continue;
        if (onScreen) placed.push(rect);
        it.sprite.center.set(cx, cy);
        it.sprite.scale.set(hPx * k * dist * it.aspect, hPx * k * dist, 1);
        it.sprite.visible = true;
        if (it.kind === "name" && it.island) nameH.set(it.island, hPx * 1.15 + PAD * 2 + 2);
        done = true;
        break;
      }
      if (!done) it.sprite.visible = false;
    }
  }

  private islandScreenRadius(isl: Island, cam: THREE.PerspectiveCamera, k: number): number {
    return isl.radius / (cam.position.distanceTo(v3(isl.center)) * k);
  }

  /** The single label that follows the hovered node (any node, at any level). */
  private syncHoverLabel(): void {
    const id = this.hoverNode;
    if (!id) return;
    const e = this.entries.get(id);
    const p = this.layout?.positions.get(id);
    if (!e || !p) return;
    if (!this.hoverLabel) {
      const item = this.label(e.node.label, 14, "hover", null, 1e9);
      item.sprite.center.set(0.5, -0.15);
      item.sprite.renderOrder = 30;
      this.extras.add(item.sprite);
      this.hoverLabel = item;
    }
    const sp = this.hoverLabel.sprite;
    if (sp.text !== e.node.label) {
      sp.text = e.node.label;
      this.hoverLabel.aspect = sp.scale.x / sp.scale.y;
    }
    const r = this.layout?.nodeRadius.get(id) ?? 2;
    sp.position.set(p.x, p.y + r, p.z);
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
