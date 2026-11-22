import {
  deleteGroup,
  deleteView,
  type FilterSpec,
  GroupSchema,
  isFileId,
  isSymId,
  LabelSchema,
  matchAny,
  type OverlayState,
  readOverlay,
  repoOfId,
  resetOverlay,
  SavedViewSchema,
  type SelectableNode,
  SelectorSchema,
  type Store,
  saveGroup,
  saveView,
  setHidden,
  setLabel,
} from "@gantry/core";
import { z } from "zod";
import { HttpError } from "./errors.js";
import type { ApiContext, GraphNode, ViewResult } from "./types.js";
import { getView } from "./views/index.js";

/** Overlay writes carry small JSON bodies (spec section 11). */
export const MAX_OVERLAY_BODY_BYTES = 64 * 1024;

export interface OverlayInfo {
  /** Nodes removed by the global hidden list and the spec's hidden list, descendants included. */
  hidden: number;
  groups: { id: string; name: string; members: string[] }[];
}

/** Resolves what a selector needs (path, workspace) from the store, never from the shape of an id. */
function selectableOf(store: Store, wsDirs: { id: string; dir: string }[]) {
  const workspaceOfPath = (p: string): string | undefined => {
    let best: { id: string; dir: string } | undefined;
    for (const w of wsDirs) {
      const inside = w.dir === "." || p === w.dir || p.startsWith(`${w.dir}/`);
      if (inside && (!best || w.dir.length > best.dir.length)) best = w;
    }
    return best?.id;
  };
  const wsById = new Map(wsDirs.map((w) => [w.id, w]));
  return (n: GraphNode): SelectableNode => {
    if (n.kind === "workspace") {
      const w = wsById.get(n.id);
      return { id: n.id, kind: n.kind, workspace: n.id, ...(w ? { path: w.dir } : {}) };
    }
    if (isSymId(n.id)) {
      const s = store.getSymbol(n.id);
      const f = s ? store.effectiveFile(s.fileId) : undefined;
      if (f)
        return {
          id: n.id,
          kind: n.kind,
          path: f.path,
          ...(f.workspaceId ? { workspace: f.workspaceId } : {}),
        };
    } else if (isFileId(n.id)) {
      const f = store.effectiveFile(n.id);
      if (f)
        return {
          id: n.id,
          kind: n.kind,
          path: f.path,
          ...(f.workspaceId ? { workspace: f.workspaceId } : {}),
        };
    }
    const ws = n.workspace ?? (n.path !== undefined ? workspaceOfPath(n.path) : undefined);
    return {
      id: n.id,
      kind: n.kind,
      ...(n.path !== undefined ? { path: n.path } : {}),
      ...(ws ? { workspace: ws } : {}),
    };
  };
}

/**
 * Applies the overlay to a built view (spec section 11, "Overlay at view time"): labels first, then hidden parts
 * (global list plus the spec's own, with their descendants and every edge that touches one), then the members of
 * each group among the nodes that remain. The same input always gives the same output.
 */
export function applyOverlay(
  ctx: ApiContext,
  result: ViewResult,
  state: OverlayState,
  spec?: FilterSpec,
): ViewResult & { overlay: OverlayInfo } {
  const toSelectable = selectableOf(
    ctx.store,
    ctx.store.listWorkspaces().map((w) => ({ id: w.id, dir: w.dir })),
  );
  const labels = new Map(state.labels.map((l) => [l.nodeId, l.text]));
  const hiddenSelectors = [...state.hidden, ...(spec?.hidden ?? [])];

  const removed = new Set<string>();
  if (hiddenSelectors.length > 0) {
    for (const n of result.nodes) if (matchAny(hiddenSelectors, toSelectable(n))) removed.add(n.id);
    // Descendants by `parent`, until nothing new is added.
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of result.nodes) {
        if (!removed.has(n.id) && n.parent !== undefined && removed.has(n.parent)) {
          removed.add(n.id);
          grew = true;
        }
      }
    }
  }

  const nodes: GraphNode[] = [];
  for (const n of result.nodes) {
    if (removed.has(n.id)) continue;
    const text = labels.get(n.id);
    nodes.push(text === undefined ? n : { ...n, label: text, labelOriginal: n.label });
  }
  const edges =
    removed.size === 0
      ? result.edges
      : result.edges.filter((e) => !removed.has(e.src) && !removed.has(e.dst));

  const wanted = spec && spec.groups.length > 0 ? new Set(spec.groups) : undefined;
  const groups = state.groups
    .filter((g) => !wanted || wanted.has(g.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((g) => ({
      id: g.id,
      name: g.name,
      members: nodes
        .filter((n) => matchAny(g.selectors, toSelectable(n)))
        .map((n) => n.id)
        .sort(),
    }));

  return { ...result, nodes, edges, overlay: { hidden: removed.size, groups } };
}

// ---- Routes ----

function firstIssue(err: z.ZodError): HttpError {
  const issue = err.issues[0];
  const path = issue?.path.join(".") ?? "";
  return new HttpError(400, `${path === "" ? "body" : path}: ${issue?.message ?? "invalid"}`);
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw firstIssue(r.error);
  return r.data;
}

/** Whether a node id names something in the effective graph. */
function nodeExists(ctx: ApiContext, id: string): boolean {
  const { store } = ctx;
  if (isSymId(id)) return store.getSymbol(id) !== undefined;
  if (isFileId(id)) return store.effectiveFile(id) !== undefined;
  if (id.startsWith("ws:")) return store.listWorkspaces().some((w) => w.id === id);
  if (id.startsWith("dir:")) {
    // `dir:<path>`, or `dir:<repo>:<path>` in a store of several repos (a path has no colon before its first slash).
    const rest = id.slice(4);
    const colon = rest.indexOf(":");
    const repo = store.listRepos().length > 1 && colon > 0 ? rest.slice(0, colon) : undefined;
    const dir = repo === undefined ? rest : rest.slice(colon + 1);
    return store
      .effectiveFiles()
      .some((f) => f.path.startsWith(`${dir}/`) && (repo === undefined || repoOfId(f.id) === repo));
  }
  return store.effectiveAdapterNodes().some((n) => n.id === id);
}

const GroupBodySchema = GroupSchema.omit({ id: true });
const ViewBodySchema = SavedViewSchema.omit({ id: true });
const HiddenBodySchema = z.object({ selectors: z.array(SelectorSchema).max(50) }).strict();
const ResetBodySchema = z.object({}).strict();
const ID_ROUTE = /^\/api\/overlay\/(groups|views)\/([^/]+)$/;

/** Whether `method pathname` is one of the overlay write routes. DELETE is only allowed on these. */
export function isOverlayWrite(method: string, pathname: string): boolean {
  if (method === "PUT")
    return (
      pathname === "/api/overlay/labels" || pathname === "/api/overlay/hidden" || ID_ROUTE.test(pathname)
    );
  if (method === "POST") return pathname === "/api/overlay/reset";
  if (method === "DELETE") return ID_ROUTE.test(pathname);
  return false;
}

/** Runs an overlay write (`isOverlayWrite` was true). `body` is the parsed JSON, undefined for DELETE. */
export function overlayWrite(ctx: ApiContext, method: string, pathname: string, body: unknown): unknown {
  const { store } = ctx;
  if (pathname === "/api/overlay/labels") {
    const label = parse(LabelSchema, body);
    if (!nodeExists(ctx, label.nodeId)) throw new HttpError(404, `Unknown node: ${label.nodeId}`);
    setLabel(store, label);
    return { labels: readOverlay(store).labels };
  }
  if (pathname === "/api/overlay/hidden") {
    const { selectors } = parse(HiddenBodySchema, body);
    setHidden(store, selectors);
    return { hidden: readOverlay(store).hidden };
  }
  if (pathname === "/api/overlay/reset") {
    parse(ResetBodySchema, body);
    resetOverlay(store);
    return readOverlay(store);
  }
  const m = ID_ROUTE.exec(pathname);
  if (!m) throw new HttpError(404, "Unknown API route");
  let id: string;
  try {
    id = decodeURIComponent(m[2] as string);
  } catch {
    throw new HttpError(400, "Malformed id");
  }
  if (m[1] === "groups") {
    if (method === "DELETE") {
      if (!deleteGroup(store, id)) throw new HttpError(404, `Unknown group: ${id}`);
      return { deleted: id };
    }
    const group = parse(GroupSchema, { ...parse(GroupBodySchema, body), id });
    saveGroup(store, group);
    return { group: readOverlay(store).groups.find((g) => g.id === id) };
  }
  if (method === "DELETE") {
    if (!deleteView(store, id)) throw new HttpError(404, `Unknown saved view: ${id}`);
    return { deleted: id };
  }
  const view = parse(SavedViewSchema, { ...parse(ViewBodySchema, body), id });
  if (!getView(view.spec.view)) throw new HttpError(400, `spec.view: unknown view ${view.spec.view}`);
  saveView(store, view);
  return { view: readOverlay(store).views.find((v) => v.id === id) };
}
