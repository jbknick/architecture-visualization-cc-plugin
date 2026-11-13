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
}

export interface LayoutEdge {
  src: string;
  dst: string;
  weight: number;
}

export interface LayoutInput {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  hint: string;
  focus: string | null;
  /** Saved positions to keep. Unknown nodes are placed near their parent. */
  saved?: Positions;
}

export interface LayoutResult {
  positions: Positions;
  /** True when some nodes had no saved position (so the caller should persist). */
  changed: boolean;
  ms: number;
  /** Which strategy ran, for the status line. */
  strategy: string;
}
