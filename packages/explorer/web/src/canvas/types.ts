export type Positions = Record<string, [number, number]>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The subset of a GraphNode the layout needs. */
export interface LayoutNode {
  id: string;
  kind: string;
  parent?: string;
  size: number;
  /** Functions under the node (`stats.functions`); sizes workspace boxes and treemap cells. */
  functions?: number;
  /** Files under the node (`stats.files`); tells a folder with files of its own from one that only holds a folder. */
  files?: number;
  /** Workspace boxes: the name and the parts of the detail line ("app", "1,700 functions", "260 files"). */
  title?: string;
  subtitle?: string[];
  /** Cross-stack views (#48): the column or swimlane; with it the flat layouts place nodes in lanes. */
  lane?: number;
  /** Cross-stack views: order inside the lane. */
  rank?: number;
  /** Endpoints view: nodes of one band are laid out together and the bands stacked. */
  band?: string;
}

export interface LayoutEdge {
  src: string;
  dst: string;
  weight: number;
  /** Edge kind; `depends_on` links are placed after the import links (see `layoutMap`). */
  kind?: string;
}

export interface LayoutInput {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  hint: string;
  focus: string | null;
  /** Map layout: repo containers; each holds the boxes of the root nodes it names. */
  groups?: { id: string; label: string; members: string[] }[];
  /** Map layout: the lifted (headerless) folders, as the scene decided them. Absent: decided from the counts. */
  transparent?: string[];
  /** Saved positions to keep. Unknown nodes are placed near their parent. Ignored by the map layout. */
  saved?: Positions;
  /**
   * Map layout only: the previous layout to keep after a refresh (spec section 11 (c)). When the workspaces are the
   * same, their boxes are reused as they were and every node that was there keeps its weight, so nothing outside a
   * changed file moves; added nodes are placed inside their parent. Built by `keepFrom`.
   */
  keep?: KeepLayout;
  /** CSS size of the canvas the map will be fitted to; the map layout sizes titles and gaps for it. */
  viewport?: { w: number; h: number };
  /**
   * Level-independent box sizes: every workspace is sized as if it had contents. Without it a workspace with no
   * children (the Workspaces level) can be a pixel or two smaller than the same one at the Folders level, which
   * would move its neighbours. The 3D city sets it so its districts stay put when the level changes.
   */
  stableBoxes?: boolean;
  /**
   * Tiny workspaces (see `tiny.ts`) get a larger minimum slab and a free strip under it for their title; their
   * rectangle in the geometry is the slab. The 3D city sets it; the 2D map never does.
   */
  tinyBoxes?: boolean;
}

/** What a refresh keeps of the previous map layout, by node id. */
export interface KeepLayout {
  /** Workspace boxes: x, y, w, h. */
  boxes: Record<string, [number, number, number, number]>;
  /** Workspace title block heights. */
  heads: Record<string, number>;
  /** Repo containers: x, y, w, h. */
  groups?: Record<string, [number, number, number, number]>;
  /** The weight every node was laid out with. */
  weights: Record<string, number>;
}

/** Geometry of a hierarchical map (workspace boxes with a treemap inside). Indexed like the sorted-id tree. */
export interface MapGeometry {
  /**
   * x, y, w, h of every node, four numbers per tree index. Workspace boxes are in layout units; everything inside
   * is laid out in a "normalized" content rectangle (the parent's rectangle minus `TM_PAD`, headers not
   * reserved): the renderer maps it into the parent's real content area, which is the parent minus the header
   * that is a constant size on screen (see `mapGeom.ts`).
   */
  rects: Float64Array;
  /** Design height of a workspace's title block in layout units (roots only, 0 elsewhere); capped on screen. */
  heads: Float32Array;
  /** Repo containers around the workspace boxes, in layout units. */
  groups?: { id: string; label: string; x: number; y: number; w: number; h: number }[];
  /** Routed workspace links, keyed `srcId>dstId`: polylines in layout units. */
  routes: Record<string, [number, number][]>;
  /** Bounding box of the boxes and routes. */
  bounds: Rect;
  /** The weight every node was laid out with (tree index order); a refresh keeps them (`keepFrom`). */
  weights?: Float64Array;
}

export interface LayoutResult {
  positions: Positions;
  /** True when some nodes had no saved position (so the caller should persist). */
  changed: boolean;
  ms: number;
  /** Which strategy ran, for the status line. */
  strategy: string;
  /** Present for hierarchical maps. */
  map?: MapGeometry;
}
