import type { ApiContext } from "../types.js";
import {
  crossCtx,
  describeNode,
  endpointGroup,
  endpointMethod,
  endpointPath,
  endpointTables,
  GROUP_LABEL,
} from "./crossStack.js";
import { tableUsers } from "./tableUsage.js";

export interface NodeRef {
  id: string;
  label: string;
  path: string | null;
  line: number | null;
}

/** Inspector facts of an endpoint (#48): what it answers, what handles it, what it touches. */
export interface EndpointFacts {
  adapter: string;
  group: string;
  method: string;
  /** URL path, or the server function's name. */
  path: string;
  /** oRPC only: the dotted procedure path. */
  rpcPath: string | null;
  protocol: string | null;
  handler: NodeRef | null;
  /** `inline` when the handler is written in place, else its name as the code passes it. */
  handlerName: string | null;
  middleware: string[];
  requestedBy: number;
  reads: NodeRef[];
  writes: NodeRef[];
}

export interface TableFacts {
  name: string;
  exportName: string | null;
  dialect: string | null;
  columns: string[];
  readers: number;
  writers: number;
  readerSample: NodeRef[];
  writerSample: NodeRef[];
}

const SAMPLE = 8;

/**
 * A middleware an oRPC procedure or server function names (`data.middleware`), drawn by the endpoints view as
 * `mwref:<package>:<name>`: no adapter node stands behind it, so the body is its name and the endpoints that use it.
 */
function middlewareRefBody(ctx: ApiContext, id: string): Record<string, unknown> | null {
  const c = crossCtx(ctx.store);
  const rest = id.slice("mwref:".length);
  const cut = rest.lastIndexOf(":");
  if (cut < 0) return null;
  const pkg = rest.slice(0, cut);
  const name = rest.slice(cut + 1);
  const users = (c.byKind.get("endpoint") ?? []).filter(
    (e) =>
      (e.ws ? (c.wsName.get(e.ws) ?? e.ws) : "") === pkg &&
      Array.isArray(e.data.middleware) &&
      e.data.middleware.map(String).includes(name),
  );
  if (users.length === 0) return null;
  const ws = users[0]?.ws ?? null;
  return {
    id,
    kind: "middleware",
    name,
    path: null,
    workspaceId: ws,
    middlewareRef: { name, endpoints: users.map((e) => ref(ctx, e.id)) },
  };
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function ref(ctx: ApiContext, id: string): NodeRef {
  const c = crossCtx(ctx.store);
  const n = describeNode(c, id);
  const s = id.startsWith("sym:") ? c.snap.getSymbol(id) : undefined;
  const a = c.adapters.get(id);
  const line = s?.startLine ?? (typeof a?.data.line === "number" ? a.data.line : null);
  return { id, label: n.label, path: n.path ?? null, line };
}

/**
 * `/api/node/:id` body of an adapter node (endpoint, table, middleware, unmatched client call). Names, paths and
 * counts only: an adapter node has no description, so nothing here is model-written text.
 */
export function adapterNodeBody(ctx: ApiContext, id: string): Record<string, unknown> | null {
  const c = crossCtx(ctx.store);
  if (id.startsWith("mwref:")) return middlewareRefBody(ctx, id);
  const a = c.adapters.get(id);
  if (!a) return null;
  const d = a.data;
  const body: Record<string, unknown> = {
    id: a.id,
    kind: a.kind,
    name: a.label,
    path: str(d.file),
    workspaceId: a.ws,
    ...(typeof d.line === "number" ? { line: d.line } : {}),
  };
  if (a.kind === "endpoint") {
    const handles = c.snap.effectiveEdges({ src: id, kind: ["handles"] });
    const mw = c.snap
      .effectiveEdges({ dst: id, kind: ["serves"] })
      .filter((e) => c.adapters.get(e.src)?.kind === "middleware")
      .map((e) => c.adapters.get(e.src)?.label ?? e.src);
    const named = Array.isArray(d.middleware) ? d.middleware.map(String) : [];
    const et = endpointTables(c, id);
    const facts: EndpointFacts = {
      adapter: str(d.adapter) ?? "",
      group: GROUP_LABEL[endpointGroup(a)],
      method: endpointMethod(a),
      path: endpointPath(a),
      rpcPath: d.adapter === "orpc" ? str(d.path) : null,
      protocol: str(d.protocol),
      handler: handles[0] ? ref(ctx, handles[0].dst) : null,
      handlerName: str(d.handler),
      middleware: [...mw, ...named],
      requestedBy: new Set(c.snap.effectiveEdges({ dst: id, kind: ["requests"] }).map((e) => e.src)).size,
      reads: et.reads.map((t) => ref(ctx, t)),
      writes: et.writes.map((t) => ref(ctx, t)),
    };
    body.endpoint = facts;
  } else if (a.kind === "table") {
    const u = tableUsers(c, id);
    const facts: TableFacts = {
      name: a.label,
      exportName: str(d.exportName),
      dialect: str(d.dialect),
      columns: Array.isArray(d.columns) ? d.columns.map(String) : [],
      readers: u.readers.length,
      writers: u.writers.length,
      readerSample: u.readers.slice(0, SAMPLE).map((x) => ref(ctx, x)),
      writerSample: u.writers.slice(0, SAMPLE).map((x) => ref(ctx, x)),
    };
    body.table = facts;
  }
  return body;
}
