import type { Store } from "@gantry/core";
import { HttpError } from "./api.js";
import { getView } from "./views/index.js";

/** Largest accepted PUT body. 30k nodes at ~60 bytes each is ~2 MB; leave headroom. */
export const MAX_LAYOUT_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_LAYOUT_NODES = 200_000;
const MAX_ID_LENGTH = 1024;
const MAX_COORD = 1e9;

export type LayoutPositions = Record<string, [number, number]>;

function checkView(view: string): void {
  if (!getView(view)) throw new HttpError(404, `Unknown view: ${view}`);
}

/** `GET /api/layout/:view` body: saved `{ nodeId: [x, y] }` positions (empty when none). */
export function getLayout(store: Store, view: string): { positions: LayoutPositions } {
  checkView(view);
  const rows = store.db.prepare("SELECT node_id, x, y FROM layouts WHERE view = ?").all(view) as {
    node_id: string;
    x: number;
    y: number;
  }[];
  const positions: LayoutPositions = Object.create(null);
  for (const r of rows) positions[r.node_id] = [r.x, r.y];
  return { positions };
}

/** Validates a parsed PUT body: `{ positions: { id: [x, y] } }` with finite coordinates. */
export function parseLayoutBody(body: unknown): [string, number, number][] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const positions = (body as { positions?: unknown }).positions;
  if (typeof positions !== "object" || positions === null || Array.isArray(positions)) {
    throw new HttpError(400, "positions must be an object of id -> [x, y]");
  }
  const entries = Object.entries(positions as Record<string, unknown>);
  if (entries.length > MAX_LAYOUT_NODES) throw new HttpError(413, "Too many positions");
  const rows: [string, number, number][] = [];
  for (const [id, value] of entries) {
    if (id.length === 0 || id.length > MAX_ID_LENGTH) throw new HttpError(400, "Bad node id");
    if (!Array.isArray(value) || value.length !== 2) throw new HttpError(400, `Bad position for ${id}`);
    const [x, y] = value as [unknown, unknown];
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > MAX_COORD ||
      Math.abs(y) > MAX_COORD
    ) {
      throw new HttpError(400, `Bad position for ${id}`);
    }
    rows.push([id, x, y]);
  }
  return rows;
}

/** `PUT /api/layout/:view`: replaces the saved positions of a view in one transaction. */
export function putLayout(store: Store, view: string, body: unknown): { saved: number } {
  checkView(view);
  const rows = parseLayoutBody(body);
  const del = store.db.prepare("DELETE FROM layouts WHERE view = ?");
  const ins = store.db.prepare("INSERT INTO layouts(view, node_id, x, y) VALUES (?, ?, ?, ?)");
  store.db
    .transaction(() => {
      del.run(view);
      for (const [id, x, y] of rows) ins.run(view, id, x, y);
    })
    .immediate();
  return { saved: rows.length };
}
