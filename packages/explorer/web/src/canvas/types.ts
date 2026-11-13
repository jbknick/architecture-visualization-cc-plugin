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
  /** Saved positions to keep. Unknown nodes are placed near their parent. Ignored by the map layout. */
  saved?: Positions;
  /** CSS size of the canvas the map will be fitted to; the map layout sizes titles and gaps for it. */
  viewport?: { w: number; h: number };
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
  /** Routed workspace links, keyed `srcId>dstId`: polylines in layout units. */
  routes: Record<string, [number, number][]>;
  /** Bounding box of the boxes and routes. */
  bounds: Rect;
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
