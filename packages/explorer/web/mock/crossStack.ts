// Mock of the cross-stack views (#48): a synthetic shop app (pages, client hooks, oRPC procedures, a Hono route, a
// server function, Drizzle tables). Response shapes mirror packages/explorer/server/views/{endpoints,pageApi,
// apiTables,featurePath,tableUsage,adapterNode}.ts; the data is invented. `#/<view>?scenario=crossstack` also makes
// /api/meta list the five views as enabled.
import type { FocusChoice, GraphEdge, GraphNode, NodeDetail, ViewData } from "../src/api.ts";

interface MNode {
  id: string;
  kind: string;
  label: string;
  path: string;
  ws: string;
  line: number;
  data?: Record<string, unknown>;
}
interface MEdge {
  src: string;
  dst: string;
  kind: string;
  low?: boolean;
}

const WEB = "ws:@shop/web";
const API = "ws:@shop/api";
const SRV = "ws:@shop/server";
const DB = "ws:@shop/db";

const sym = (path: string, name: string, kind: string, ws: string, line: number): MNode => ({
  id: `sym:pnpm-turbo:${path}#${name}`,
  kind,
  label: name,
  path,
  ws,
  line,
});
const route = (url: string, file: string, line = 1): MNode => ({
  id: `route:pnpm-turbo:@shop/web:${url}`,
  kind: "route",
  label: url,
  path: `apps/web/src/routes/${file}`,
  ws: WEB,
  line,
});
const ep = (
  id: string,
  label: string,
  ws: string,
  path: string,
  line: number,
  data: Record<string, unknown>,
): MNode => ({
  id,
  kind: "endpoint",
  label,
  path,
  ws,
  line,
  data,
});

const HOME = sym("apps/web/src/routes/index.tsx", "HomePage", "component", WEB, 6);
const ORDERS_PAGE = sym("apps/web/src/routes/orders.tsx", "OrdersPage", "component", WEB, 5);
const ORDER_PAGE = sym("apps/web/src/routes/orders.$orderId.tsx", "OrderPage", "component", WEB, 7);
const USERS_PAGE = sym("apps/web/src/routes/admin/users.tsx", "UsersAdmin", "component", WEB, 4);
const USE_ORDERS = sym("apps/web/src/hooks/useOrders.ts", "useOrders", "hook", WEB, 3);
const USE_CART = sym("apps/web/src/hooks/useCart.ts", "useCart", "hook", WEB, 4);
const ORDERS_ROUTER = sym("packages/api/src/orders.ts", "ordersRouter", "const", API, 8);
const CART_FILE: MNode = {
  id: "file:pnpm-turbo:apps/server/src/cart.ts",
  kind: "file",
  label: "cart.ts",
  path: "apps/server/src/cart.ts",
  ws: SRV,
  line: 1,
};
const LIST_USERS = sym("apps/server/src/users.ts", "listUsers", "function", SRV, 9);
const STATS_HANDLER = sym("apps/web/src/server/stats.ts", "statsHandler", "function", WEB, 3);
const LOAD_ORDERS = sym("packages/db/src/orders.ts", "loadOrders", "function", DB, 4);
const CANCEL_ORDER = sym("packages/db/src/orders.ts", "cancelOrder", "function", DB, 18);
const ADD_ITEM = sym("packages/db/src/cart.ts", "addItem", "function", DB, 5);
const QUERY_USERS = sym("packages/db/src/users.ts", "queryUsers", "function", DB, 6);
const COUNT_ORDERS = sym("packages/db/src/orders.ts", "countOrders", "function", DB, 30);
const T_ORDERS: MNode = {
  id: "table:pnpm-turbo:orders",
  kind: "table",
  label: "orders",
  path: "packages/db/src/schema.ts",
  ws: DB,
  line: 10,
  data: { columns: ["id", "userId", "status", "total"], dialect: "sqlite", exportName: "orders" },
};
const T_ITEMS: MNode = {
  id: "table:pnpm-turbo:order_items",
  kind: "table",
  label: "order_items",
  path: "packages/db/src/schema.ts",
  ws: DB,
  line: 20,
  data: { columns: ["id", "orderId", "sku", "qty"], dialect: "sqlite", exportName: "orderItems" },
};
const T_USERS: MNode = {
  id: "table:pnpm-turbo:users",
  kind: "table",
  label: "users",
  path: "packages/db/src/schema.ts",
  ws: DB,
  line: 3,
  data: { columns: ["id", "name", "email"], dialect: "sqlite", exportName: "users" },
};
const MW_AUTH: MNode = {
  id: "mw:pnpm-turbo:@shop/server:/api/* auth",
  kind: "middleware",
  label: "auth /api/*",
  path: "apps/server/src/app.ts",
  ws: SRV,
  line: 12,
};

const R_HOME = route("/", "index.tsx");
const R_ORDERS = route("/orders", "orders.tsx");
const R_ORDER = route("/orders/$orderId", "orders.$orderId.tsx");
const R_USERS = route("/admin/users", "admin/users.tsx");
const R_SETTINGS = route("/settings", "settings.tsx");

const orpc = (path: string, line: number) =>
  ep(
    `ep:pnpm-turbo:@shop/api:rpc orders.${path}`,
    `rpc orders.${path}`,
    API,
    "packages/api/src/orders.ts",
    line,
    {
      adapter: "orpc",
      path: `orders.${path}`,
      protocol: "rpc",
      handler: "inline",
    },
  );
const E_LIST = orpc("list", 9);
const E_GET = orpc("get", 10);
const E_CANCEL = orpc("cancel", 11);
const E_CART = ep(
  "ep:pnpm-turbo:@shop/server:POST /api/cart",
  "POST /api/cart",
  SRV,
  "apps/server/src/cart.ts",
  6,
  {
    adapter: "hono",
    method: "POST",
    path: "/api/cart",
    handler: "inline",
  },
);
const E_USERS = ep(
  "ep:pnpm-turbo:@shop/server:GET /api/users",
  "GET /api/users",
  SRV,
  "apps/server/src/users.ts",
  14,
  {
    adapter: "hono",
    method: "GET",
    path: "/api/users",
    handler: "listUsers",
  },
);
const E_STATS = ep(
  "ep:pnpm-turbo:@shop/web:fn getStats",
  "fn getStats",
  WEB,
  "apps/web/src/server/stats.ts",
  8,
  {
    adapter: "tanstack-start",
    method: "GET",
    name: "getStats",
    handler: "statsHandler",
  },
);
const E_EXPORT = ep(
  "ep:pnpm-turbo:@shop/server:GET /api/export",
  "GET /api/export",
  SRV,
  "apps/server/src/export.ts",
  4,
  {
    adapter: "hono",
    method: "GET",
    path: "/api/export",
    handler: "inline",
  },
);

const NODES: MNode[] = [
  HOME,
  ORDERS_PAGE,
  ORDER_PAGE,
  USERS_PAGE,
  USE_ORDERS,
  USE_CART,
  ORDERS_ROUTER,
  CART_FILE,
  LIST_USERS,
  STATS_HANDLER,
  LOAD_ORDERS,
  CANCEL_ORDER,
  ADD_ITEM,
  QUERY_USERS,
  COUNT_ORDERS,
  T_ORDERS,
  T_ITEMS,
  T_USERS,
  MW_AUTH,
  R_HOME,
  R_ORDERS,
  R_ORDER,
  R_USERS,
  R_SETTINGS,
  E_LIST,
  E_GET,
  E_CANCEL,
  E_CART,
  E_USERS,
  E_STATS,
  E_EXPORT,
];
const BY_ID = new Map(NODES.map((n) => [n.id, n]));

const EDGES: MEdge[] = [
  { src: R_HOME.id, dst: HOME.id, kind: "serves" },
  { src: R_ORDERS.id, dst: ORDERS_PAGE.id, kind: "serves" },
  { src: R_ORDER.id, dst: ORDER_PAGE.id, kind: "serves" },
  { src: R_USERS.id, dst: USERS_PAGE.id, kind: "serves" },
  { src: ORDERS_PAGE.id, dst: USE_ORDERS.id, kind: "uses_hook" },
  { src: ORDER_PAGE.id, dst: USE_ORDERS.id, kind: "uses_hook" },
  { src: ORDER_PAGE.id, dst: USE_CART.id, kind: "uses_hook" },
  { src: HOME.id, dst: E_STATS.id, kind: "requests" },
  { src: USE_ORDERS.id, dst: E_LIST.id, kind: "requests" },
  { src: ORDER_PAGE.id, dst: E_GET.id, kind: "requests" },
  { src: USE_ORDERS.id, dst: E_GET.id, kind: "requests" },
  { src: ORDER_PAGE.id, dst: E_CANCEL.id, kind: "requests" },
  { src: USE_CART.id, dst: E_CART.id, kind: "requests", low: true },
  { src: USERS_PAGE.id, dst: E_USERS.id, kind: "requests" },
  { src: MW_AUTH.id, dst: E_CART.id, kind: "serves" },
  { src: MW_AUTH.id, dst: E_USERS.id, kind: "serves" },
  { src: MW_AUTH.id, dst: E_EXPORT.id, kind: "serves" },
  { src: E_LIST.id, dst: ORDERS_ROUTER.id, kind: "handles" },
  { src: E_GET.id, dst: ORDERS_ROUTER.id, kind: "handles" },
  { src: E_CANCEL.id, dst: ORDERS_ROUTER.id, kind: "handles" },
  { src: E_CART.id, dst: CART_FILE.id, kind: "handles" },
  { src: E_USERS.id, dst: LIST_USERS.id, kind: "handles" },
  { src: E_STATS.id, dst: STATS_HANDLER.id, kind: "handles" },
  { src: ORDERS_ROUTER.id, dst: LOAD_ORDERS.id, kind: "calls" },
  { src: ORDERS_ROUTER.id, dst: CANCEL_ORDER.id, kind: "calls" },
  { src: CART_FILE.id, dst: ADD_ITEM.id, kind: "calls" },
  { src: LIST_USERS.id, dst: QUERY_USERS.id, kind: "calls" },
  { src: STATS_HANDLER.id, dst: COUNT_ORDERS.id, kind: "calls" },
  { src: LOAD_ORDERS.id, dst: T_ORDERS.id, kind: "reads" },
  { src: LOAD_ORDERS.id, dst: T_ITEMS.id, kind: "reads" },
  { src: CANCEL_ORDER.id, dst: T_ORDERS.id, kind: "writes" },
  { src: ADD_ITEM.id, dst: T_ITEMS.id, kind: "writes" },
  { src: ADD_ITEM.id, dst: T_ORDERS.id, kind: "reads", low: true },
  { src: QUERY_USERS.id, dst: T_USERS.id, kind: "reads" },
  { src: COUNT_ORDERS.id, dst: T_ORDERS.id, kind: "reads" },
];

/** What each endpoint's own handler span calls (the shared router's procedures call different services). */
const OWN_SERVICES: Record<string, string[]> = {
  [E_LIST.id]: [LOAD_ORDERS.id],
  [E_GET.id]: [LOAD_ORDERS.id],
  [E_CANCEL.id]: [CANCEL_ORDER.id],
  [E_CART.id]: [ADD_ITEM.id],
  [E_USERS.id]: [QUERY_USERS.id],
  [E_STATS.id]: [COUNT_ORDERS.id],
  [E_EXPORT.id]: [],
};
const UNMATCHED: Record<string, number> = { [R_ORDER.id]: 1 };

const GROUP = (n: MNode) =>
  n.data?.adapter === "orpc" ? "rpc" : n.data?.adapter === "tanstack-start" ? "fn" : "http";
const GROUP_LABEL: Record<string, string> = { rpc: "rpc", http: "http", fn: "server fn" };
const METHOD = (n: MNode) => (n.data?.adapter === "orpc" ? "RPC" : String(n.data?.method ?? "ALL"));
const WS_SHORT: Record<string, string> = { [WEB]: "web", [API]: "api", [SRV]: "server", [DB]: "db" };

function gnode(id: string, lane: number, extra: Partial<GraphNode> = {}): GraphNode {
  const n = BY_ID.get(id);
  if (!n) throw new Error(`mock: unknown ${id}`);
  const badges: string[] = [];
  if (n.kind === "endpoint") badges.push(GROUP_LABEL[GROUP(n)] as string, METHOD(n));
  if (n.kind === "table") badges.push("sqlite");
  return {
    id,
    kind: n.kind,
    label: n.label,
    size: 1,
    path: n.path,
    workspace: n.ws,
    lane,
    ...(badges.length > 0 ? { badges } : {}),
    ...extra,
  };
}

class Builder {
  nodes = new Map<string, GraphNode>();
  edges = new Map<string, GraphEdge>();
  node(id: string, lane: number, extra: Partial<GraphNode> = {}): GraphNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = gnode(id, lane, extra);
      this.nodes.set(id, n);
    }
    return n;
  }
  edge(src: string, dst: string, kind: string, low = false, extra: Partial<GraphEdge> = {}): GraphEdge {
    const id = `${src}|${kind}|${dst}`;
    const cur = this.edges.get(id);
    if (cur) return cur;
    const e: GraphEdge = { id, src, dst, kind, weight: 1, confidence: low ? "low" : "high", ...extra };
    this.edges.set(id, e);
    return e;
  }
  out(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const ranks = new Map<number, number>();
    for (const n of [...nodes].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))) {
      if (n.rank !== undefined) continue;
      const lane = n.lane ?? 0;
      n.rank = ranks.get(lane) ?? 0;
      ranks.set(lane, n.rank + 1);
    }
    return { nodes, edges: [...this.edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
  }
}

const out = (id: string, kinds: string[]) => EDGES.filter((e) => e.src === id && kinds.includes(e.kind));
const into = (id: string, kinds: string[]) => EDGES.filter((e) => e.dst === id && kinds.includes(e.kind));
const ENDPOINTS = NODES.filter((n) => n.kind === "endpoint");
const ROUTES = NODES.filter((n) => n.kind === "route");
const TABLES = NODES.filter((n) => n.kind === "table");

/** A page's own code: its component and the hooks below it. */
function frontOf(routeId: string): string[] {
  const seen = new Set<string>();
  const stack = out(routeId, ["serves"]).map((e) => e.dst);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of out(id, ["renders", "uses_hook", "calls"])) stack.push(e.dst);
  }
  return [...seen].sort();
}

function dbEdges(endpoint: string): MEdge[] {
  return (OWN_SERVICES[endpoint] ?? []).flatMap((s) => out(s, ["reads", "writes"]));
}

const wsCounts = (nodes: MNode[], noun: string) => {
  void noun;
  const m = new Map<string, number>();
  for (const n of nodes) m.set(n.ws, (m.get(n.ws) ?? 0) + 1);
  return [...m]
    .sort()
    .map(([id, count]) => ({ id, name: id.slice(3), shortLabel: WS_SHORT[id] ?? id, count }));
};

type Opts = Record<string, string>;
const list = (o: Opts, k: string) => (o[k] ? o[k].split("|").filter(Boolean) : null);

function endpointsView(o: Opts): ViewData {
  const kinds = list(o, "kind");
  const methods = list(o, "method");
  const prefix = o.prefix ?? "";
  const shown = ENDPOINTS.filter(
    (n) =>
      (!kinds || kinds.includes(GROUP(n))) &&
      (!methods || methods.includes(METHOD(n))) &&
      (!prefix || String(n.data?.path ?? n.label).startsWith(prefix)),
  ).sort(
    (a, b) =>
      ["rpc", "http", "fn"].indexOf(GROUP(a)) - ["rpc", "http", "fn"].indexOf(GROUP(b)) ||
      (a.label < b.label ? -1 : 1),
  );
  const b = new Builder();
  shown.forEach((n, i) => {
    b.node(n.id, 0, { band: GROUP_LABEL[GROUP(n)], rank: i });
  });
  for (const n of shown) {
    const band = GROUP_LABEL[GROUP(n)];
    for (const e of into(n.id, ["serves"])) {
      b.node(e.src, 1, { band });
      b.edge(n.id, e.src, "middleware");
    }
    const h = out(n.id, ["handles"]);
    if (h.length === 0) {
      const g = b.nodes.get(n.id);
      if (g) g.badges = [...(g.badges ?? []), "no handler"];
    }
    for (const e of h) {
      b.node(e.dst, 2, { band });
      b.edge(n.id, e.dst, "handles");
      for (const s of OWN_SERVICES[n.id] ?? []) {
        b.node(s, 3, { band });
        b.edge(e.dst, s, "calls");
      }
    }
  }
  return {
    ...b.out(),
    layoutHint: "elk-layered",
    lanes: [
      { lane: 0, label: "Endpoint" },
      { lane: 1, label: "Middleware" },
      { lane: 2, label: "Handler" },
      { lane: 3, label: "Services, call 1" },
      { lane: 4, label: "Services, call 2" },
    ],
    groups: ["rpc", "http", "fn"].map((g) => ({
      id: g,
      label: GROUP_LABEL[g] as string,
      count: ENDPOINTS.filter((n) => GROUP(n) === g).length,
    })),
    methods: [...new Set(ENDPOINTS.map(METHOD))].sort(),
    wsCounts: wsCounts(ENDPOINTS, "endpoint"),
    totals: {
      endpoints: ENDPOINTS.length,
      shown: shown.length,
      middleware: 1,
      withoutHandler: 1,
      truncated: false,
    },
  };
}

function pageApiView(o: Opts): ViewData {
  const b = new Builder();
  const all = o.all === "true";
  for (const r of ROUTES) {
    const front = frontOf(r.id);
    const via = new Map<string, { places: string[]; low: boolean }>();
    for (const f of front)
      for (const e of out(f, ["requests"])) {
        const v = via.get(e.dst) ?? { places: [], low: true };
        v.places.push(BY_ID.get(f)?.label ?? f);
        if (!e.low) v.low = false;
        via.set(e.dst, v);
      }
    if (via.size > 0 || all) {
      const n = b.node(r.id, 0);
      if (UNMATCHED[r.id]) n.badges = [`${UNMATCHED[r.id]} unmatched`];
    }
    for (const [dst, v] of via) {
      b.node(dst, 1);
      b.edge(r.id, dst, "requests", v.low, {
        weight: v.places.length,
        via: v.places.length,
        viaSample: v.places.sort(),
      });
    }
  }
  if (all) for (const e of ENDPOINTS) b.node(e.id, 1);
  const res = b.out();
  return {
    ...res,
    layoutHint: "columns",
    lanes: [
      { lane: 0, label: "Pages (routes)" },
      { lane: 1, label: "Endpoints" },
    ],
    wsCounts: wsCounts(ROUTES, "route"),
    totals: {
      routes: ROUTES.length,
      endpoints: ENDPOINTS.length,
      links: res.edges.length,
      routesWithout: 1,
      endpointsWithout: 1,
      unmatched: 1,
    },
  };
}

function apiTablesView(o: Opts): ViewData {
  const expanded = o.services === "all";
  const b = new Builder();
  const rows: { endpoint: string; reads: string[]; writes: string[] }[] = [];
  let rank = 0;
  for (const n of ENDPOINTS) {
    const db = dbEdges(n.id);
    rows.push({
      endpoint: n.id,
      reads: [...new Set(db.filter((e) => e.kind === "reads").map((e) => e.dst))].sort(),
      writes: [...new Set(db.filter((e) => e.kind === "writes").map((e) => e.dst))].sort(),
    });
    if (db.length === 0 && o.all !== "true") continue;
    b.node(n.id, 0, { rank: rank++ });
    for (const e of db) {
      b.node(e.src, 1);
      b.node(e.dst, 2);
      b.edge(e.src, e.dst, e.kind, e.low);
    }
    if (expanded) {
      for (const h of out(n.id, ["handles"])) {
        b.node(h.dst, 1);
        b.edge(n.id, h.dst, "handles");
        for (const s of OWN_SERVICES[n.id] ?? []) b.edge(h.dst, s, "calls");
      }
    } else for (const s of OWN_SERVICES[n.id] ?? []) b.edge(n.id, s, "uses", false, { via: 1 });
  }
  const res = b.out();
  return {
    ...res,
    layoutHint: "columns",
    lanes: [
      { lane: 0, label: "Endpoints" },
      { lane: 1, label: expanded ? "Services" : "Database calls" },
      { lane: 2, label: "Tables" },
    ],
    wsCounts: wsCounts(ENDPOINTS, "endpoint"),
    endpointTables: rows,
    totals: {
      endpoints: ENDPOINTS.length,
      withTables: rows.filter((r) => r.reads.length + r.writes.length > 0).length,
      tables: TABLES.length,
      services: res.nodes.filter((x) => x.lane === 1).length,
      expanded,
    },
  };
}

const PATH_LANES = [
  { lane: 0, label: "Page" },
  { lane: 1, label: "Client" },
  { lane: 2, label: "Endpoint" },
  { lane: 3, label: "Service" },
  { lane: 4, label: "Table" },
];

function choicesFor(view: string): FocusChoice[] {
  if (view === "table-usage")
    return TABLES.map((t) => ({
      id: t.id,
      label: t.label,
      kind: "table",
      group: "Tables · db",
      note: `${into(t.id, ["writes"]).length} writers · ${into(t.id, ["reads"]).length} readers`,
    }));
  return [
    ...ROUTES.map((r) => ({ id: r.id, label: r.label, kind: "route", group: "Pages · web" })),
    ...ENDPOINTS.map((e) => ({
      id: e.id,
      label: e.label,
      kind: "endpoint",
      group: `Endpoints · ${GROUP_LABEL[GROUP(e)]}`,
    })),
  ];
}

function featurePathView(focus: string | null): ViewData | { status: number; error: string } {
  const base = { layoutHint: "elk-layered", lanes: PATH_LANES, gaps: [] as string[], truncated: false };
  if (!focus)
    return { ...base, nodes: [], edges: [], focus: null, choices: choicesFor("feature-path"), totals: {} };
  const start = BY_ID.get(focus);
  if (!start || (start.kind !== "route" && start.kind !== "endpoint"))
    return { status: 400, error: "focus must be a route or an endpoint" };
  const b = new Builder();
  const addEndpoint = (e: string) => {
    b.node(e, 2);
    for (const h of out(e, ["handles"])) {
      b.node(h.dst, 3);
      b.edge(e, h.dst, "handles");
      for (const s of OWN_SERVICES[e] ?? []) {
        b.node(s, 3);
        b.edge(h.dst, s, "calls");
        for (const d of out(s, ["reads", "writes"])) {
          b.node(d.dst, 4);
          b.edge(s, d.dst, d.kind, d.low);
        }
      }
    }
  };
  const addRoute = (r: string, only?: string) => {
    b.node(r, 0);
    for (const s of out(r, ["serves"])) {
      for (const f of frontOf(r)) {
        for (const q of out(f, ["requests"])) {
          if (only && q.dst !== only) continue;
          b.node(s.dst, 1);
          b.edge(r, s.dst, "serves");
          b.node(f, 1);
          if (f !== s.dst)
            for (const u of EDGES.filter((x) => x.dst === f && x.kind === "uses_hook"))
              if (b.nodes.has(u.src)) b.edge(u.src, f, "uses_hook");
          b.edge(f, q.dst, "requests", q.low);
          addEndpoint(q.dst);
        }
      }
    }
  };
  if (start.kind === "route") addRoute(start.id);
  else {
    addEndpoint(start.id);
    for (const r of ROUTES)
      if (frontOf(r.id).some((f) => out(f, ["requests"]).some((q) => q.dst === start.id)))
        addRoute(r.id, start.id);
  }
  const fnode = b.nodes.get(start.id);
  if (fnode) fnode.badges = [...(fnode.badges ?? []), "focus"];
  const res = b.out();
  const count = (k: string) => res.nodes.filter((n) => n.kind === k).length;
  return {
    ...base,
    ...res,
    focus: start.id,
    gaps:
      start.id === R_ORDER.id ? ['unmatched client call "rpc orders.track" (no_endpoint) in useCart'] : [],
    totals: {
      routes: count("route"),
      endpoints: count("endpoint"),
      tables: count("table"),
      steps: res.nodes.length,
    },
  };
}

function tableUsageView(focus: string | null): ViewData | { status: number; error: string } {
  const base = { layoutHint: "tree-lr", gaps: [] as string[], truncated: false, table: null };
  if (!focus)
    return {
      ...base,
      nodes: [],
      edges: [],
      lanes: [],
      focus: null,
      choices: choicesFor("table-usage"),
      totals: {},
    };
  const t = BY_ID.get(focus) ?? BY_ID.get(`table:pnpm-turbo:${focus}`);
  if (t?.kind !== "table") return { status: 400, error: "focus must be a table" };
  // Depth from the table: 1 writers/readers, 2 handlers, 3 endpoints, 4 client code, 5 routes.
  const depth = new Map<string, number>([[t.id, 0]]);
  const b = new Builder();
  let seq = 0;
  const rank = new Map<string, number>([[t.id, seq++]]);
  const users = into(t.id, ["writes", "reads"]).sort((a, c) =>
    a.kind === c.kind ? 0 : a.kind === "writes" ? -1 : 1,
  );
  const edgesUp: MEdge[] = [];
  for (const u of users) {
    if (!depth.has(u.src)) {
      depth.set(u.src, 1);
      rank.set(u.src, seq++);
    }
    edgesUp.push(u);
    for (const [epId, svcs] of Object.entries(OWN_SERVICES)) {
      if (!svcs.includes(u.src)) continue;
      for (const h of out(epId, ["handles"])) {
        if (!depth.has(h.dst)) {
          depth.set(h.dst, 2);
          rank.set(h.dst, seq++);
        }
        edgesUp.push({ src: h.dst, dst: u.src, kind: "calls" }, h);
        if (!depth.has(epId)) {
          depth.set(epId, 3);
          rank.set(epId, seq++);
        }
        for (const r of ROUTES)
          for (const f of frontOf(r.id))
            for (const q of out(f, ["requests"])) {
              if (q.dst !== epId) continue;
              if (!depth.has(f)) {
                depth.set(f, 4);
                rank.set(f, seq++);
              }
              if (!depth.has(r.id)) {
                depth.set(r.id, 5);
                rank.set(r.id, seq++);
              }
              edgesUp.push(q, { src: r.id, dst: f, kind: "serves" });
            }
      }
    }
  }
  const deepest = Math.max(1, ...depth.values());
  for (const [id, d] of depth) {
    const n = b.node(id, deepest - d, { rank: rank.get(id) ?? 0 });
    if (d === 1) {
      const w = users.some((u) => u.src === id && u.kind === "writes");
      n.badges = [...(n.badges ?? []), w ? "writes" : "reads"];
    }
  }
  for (const e of edgesUp) b.edge(e.src, e.dst, e.kind, e.low);
  const res = b.out();
  const lanes = Array.from({ length: deepest + 1 }, (_, lane) => {
    const d = deepest - lane;
    return { lane, label: d === 0 ? "Table" : d === 1 ? "Writes / reads it" : `${d} steps away` };
  });
  const count = (k: string) => res.nodes.filter((n) => n.kind === k).length;
  return {
    ...base,
    ...res,
    lanes,
    focus: t.id,
    table: { name: t.label, columns: (t.data?.columns as string[]) ?? [], dialect: "sqlite" },
    totals: {
      writers: users.filter((u) => u.kind === "writes").length,
      readers: users.filter((u) => u.kind === "reads").length,
      endpoints: count("endpoint"),
      routes: count("route"),
      steps: res.nodes.length,
    },
  };
}

export const CROSS_STACK_VIEWS = [
  { id: "endpoints", title: "Endpoints", enabled: true },
  { id: "page-api", title: "Page → API", enabled: true },
  { id: "api-tables", title: "API → tables", enabled: true },
  { id: "feature-path", title: "Feature path", enabled: true },
  { id: "table-usage", title: "Table usage", enabled: true },
];

/** One of the five views, or null for any other view id. */
export function crossStackView(
  id: string,
  focus: string | null,
  options: Opts,
): ViewData | { status: number; error: string } | null {
  if (id === "endpoints") return endpointsView(options);
  if (id === "page-api") return pageApiView(options);
  if (id === "api-tables") return apiTablesView(options);
  if (id === "feature-path") return featurePathView(focus);
  if (id === "table-usage") return tableUsageView(focus);
  return null;
}

const ref = (id: string) => {
  const n = BY_ID.get(id);
  return { id, label: n?.label ?? id, path: n?.path ?? null, line: n?.line ?? null };
};

/** `/api/node/:id` for the mock shop's nodes. */
export function crossStackNode(id: string): NodeDetail | null {
  const n = BY_ID.get(id);
  if (!n) return null;
  const neighbors: NodeDetail["neighbors"] = {};
  for (const e of EDGES) {
    if (e.src !== id && e.dst !== id) continue;
    const other = e.src === id ? e.dst : e.src;
    const list = neighbors[e.kind] ?? [];
    list.push({
      id: other,
      direction: e.src === id ? "out" : "in",
      kind: e.kind,
      label: BY_ID.get(other)?.label ?? other,
      confidence: e.low ? "low" : "high",
      count: 1,
    });
    neighbors[e.kind] = list;
  }
  const node: NodeDetail["node"] = {
    id,
    kind: n.kind,
    name: n.label,
    path: n.path,
    workspaceId: n.ws,
    line: n.line,
  };
  if (n.kind === "endpoint") {
    const db = dbEdges(id);
    const h = out(id, ["handles"])[0];
    node.endpoint = {
      adapter: String(n.data?.adapter ?? ""),
      group: GROUP_LABEL[GROUP(n)] as string,
      method: METHOD(n),
      path:
        n.data?.adapter === "orpc"
          ? `/rpc/${String(n.data.path).replace(".", "/")}`
          : String(n.data?.path ?? n.data?.name ?? n.label),
      rpcPath: n.data?.adapter === "orpc" ? String(n.data.path) : null,
      protocol: n.data?.adapter === "orpc" ? "rpc" : null,
      handler: h ? ref(h.dst) : null,
      handlerName: String(n.data?.handler ?? ""),
      middleware: into(id, ["serves"]).map((e) => BY_ID.get(e.src)?.label ?? e.src),
      requestedBy: into(id, ["requests"]).length,
      reads: [...new Set(db.filter((e) => e.kind === "reads").map((e) => e.dst))].map(ref),
      writes: [...new Set(db.filter((e) => e.kind === "writes").map((e) => e.dst))].map(ref),
    };
  }
  if (n.kind === "table") {
    const readers = into(id, ["reads"]).map((e) => e.src);
    const writers = into(id, ["writes"]).map((e) => e.src);
    node.table = {
      name: n.label,
      exportName: String(n.data?.exportName ?? n.label),
      dialect: "sqlite",
      columns: (n.data?.columns as string[]) ?? [],
      readers: readers.length,
      writers: writers.length,
      readerSample: readers.map(ref),
      writerSample: writers.map(ref),
    };
  }
  const isCode = n.id.startsWith("sym:");
  return {
    node,
    signature: isCode ? `function ${n.label}()` : null,
    fan_in: into(id, ["requests", "calls", "handles", "uses_hook", "serves", "reads", "writes"]).length,
    fan_out: out(id, ["requests", "calls", "handles", "uses_hook", "serves", "reads", "writes"]).length,
    neighbors,
    untrusted_description: null,
  };
}
