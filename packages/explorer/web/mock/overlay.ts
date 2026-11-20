// Mock of the overlay routes (spec section 11): the same shapes as packages/explorer/server/overlay.ts, kept in memory.
// Labels, hidden parts and groups are not applied to the mock's views; only the stored state round-trips.
import type { Group, Label, OverlayResponse, SavedView, Selector } from "../src/api.ts";

interface MockResponse {
  status: number;
  body: unknown;
}

let state: { labels: Label[]; hidden: Selector[]; groups: Group[]; views: SavedView[] } = {
  labels: [],
  hidden: [],
  groups: [],
  views: [],
};

/** Back to an empty overlay (component tests call this between tests). */
export function resetMockOverlay(): void {
  state = { labels: [], hidden: [], groups: [], views: [] };
}

export function mockOverlay(): OverlayResponse {
  return { ...state, unresolved: [] };
}

const ID_ROUTE = /^\/api\/overlay\/(groups|views)\/([^/]+)$/;

export function isMockOverlayRoute(pathname: string): boolean {
  return pathname === "/api/overlay" || pathname.startsWith("/api/overlay/");
}

/** Handles a write to an overlay route; null when the path is not one. GET /api/overlay is `mockOverlay()`. */
export function handleMockOverlayWrite(method: string, pathname: string, body: unknown): MockResponse | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (method === "PUT" && pathname === "/api/overlay/labels") {
    const label = b as unknown as Label;
    state.labels = state.labels.filter((l) => l.nodeId !== label.nodeId);
    if (label.text !== "") state.labels.push({ nodeId: label.nodeId, text: label.text });
    state.labels.sort((a, c) => (a.nodeId < c.nodeId ? -1 : 1));
    return { status: 200, body: { labels: state.labels } };
  }
  if (method === "PUT" && pathname === "/api/overlay/hidden") {
    state.hidden = (b.selectors as Selector[]) ?? [];
    return { status: 200, body: { hidden: state.hidden } };
  }
  if (method === "POST" && pathname === "/api/overlay/reset") {
    resetMockOverlay();
    return { status: 200, body: mockOverlay() };
  }
  const m = ID_ROUTE.exec(pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[2] as string);
  if (m[1] === "groups") {
    if (method === "DELETE") {
      if (!state.groups.some((g) => g.id === id))
        return { status: 404, body: { error: `Unknown group: ${id}` } };
      state.groups = state.groups.filter((g) => g.id !== id);
      return { status: 200, body: { deleted: id } };
    }
    const group = { mayUse: null, ...(b as object), id } as Group;
    state.groups = [...state.groups.filter((g) => g.id !== id), group].sort((a, c) => (a.id < c.id ? -1 : 1));
    return { status: 200, body: { group } };
  }
  if (method === "DELETE") {
    if (!state.views.some((v) => v.id === id))
      return { status: 404, body: { error: `Unknown saved view: ${id}` } };
    state.views = state.views.filter((v) => v.id !== id);
    return { status: 200, body: { deleted: id } };
  }
  const view = { ...(b as object), id } as SavedView;
  state.views = [...state.views.filter((v) => v.id !== id), view].sort((a, c) => (a.id < c.id ? -1 : 1));
  return { status: 200, body: { view } };
}
