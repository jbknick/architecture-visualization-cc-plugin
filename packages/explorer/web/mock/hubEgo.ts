// Mock-only "hub" ego scenario (`#/ego?focus=<hubFocus>&scenario=hub`): a shared UI component with 221 callers in
// three workspaces and one callee. Entirely synthetic. Grouping follows the real server's rules
// (server/views/egoGroups.ts: a side over 24 nodes is grouped by workspace, then folder, then file; 3 or fewer
// members stay individual; `expand` returns the members) so the screenshots show what the server would send.
import type { GraphEdge, GraphNode, NodeDetail, ViewData } from "../src/api.ts";

export const hubFocus = "sym:packages/ui/src/DataTable/DataTable.tsx#DataTable";
const CALLEE = "sym:packages/ui/src/DataTable/useTableState.ts#useTableState";
const EGO_MAX = 400;

interface Ws {
  id: string;
  short: string;
  dir: string;
  /** [folder relative to the workspace, file name, callers in that file] */
  files: [string, string, number][];
}

const WS: Ws[] = [
  {
    id: "ws:@acme/web",
    short: "web",
    dir: "apps/web",
    files: [
      ["src/routes/orders", "OrdersPage.tsx", 7],
      ["src/routes/orders", "OrderDetailPage.tsx", 6],
      ["src/routes/orders", "OrderFilters.tsx", 5],
      ["src/routes/customers", "CustomersPage.tsx", 9],
      ["src/routes/customers", "CustomerCard.tsx", 5],
      ["src/routes/billing", "InvoicesPage.tsx", 11],
      ["src/routes/billing", "PaymentsPage.tsx", 12],
      ["src/routes/settings", "SettingsPage.tsx", 9],
      ["src/routes/orders", "OrderExport.tsx", 8],
      ["src/routes/reports", "ReportsPage.tsx", 10],
      ["src/routes/reports", "ReportBuilder.tsx", 8],
      ["src/routes/inventory", "StockTable.tsx", 14],
      ["src/components/dashboards", "SalesBoard.tsx", 5],
      ["src/components/dashboards", "SupportBoard.tsx", 4],
      ["src/components/dashboards", "OpsBoard.tsx", 2],
      ["src/components/dashboards", "FinanceBoard.tsx", 2],
      ["src/components/search", "SearchResults.tsx", 6],
      ["src/hooks", "useExportRows.tsx", 4],
      ["src/lib", "tableColumns.tsx", 3],
    ],
  },
  {
    id: "ws:@acme/admin",
    short: "admin",
    dir: "apps/admin",
    files: [
      ["src/pages/users", "UsersPage.tsx", 12],
      ["src/pages/users", "RoleMatrix.tsx", 11],
      ["src/pages/roles", "RolesPage.tsx", 5],
      ["src/pages/roles", "RoleEditor.tsx", 4],
      ["src/pages/audit", "AuditLog.tsx", 13],
      ["src/pages/settings", "FeatureFlags.tsx", 6],
      ["src/pages/settings", "Integrations.tsx", 5],
      ["src/components/forms", "BulkEdit.tsx", 3],
      ["src/components/forms", "ImportWizard.tsx", 2],
    ],
  },
  {
    id: "ws:@acme/marketing",
    short: "marketing",
    dir: "apps/marketing",
    files: [
      ["src/sections", "Pricing.tsx", 5],
      ["src/sections", "Compare.tsx", 4],
      ["src/sections", "Changelog.tsx", 4],
      ["src/sections", "Footer.tsx", 3],
      ["src/pages", "Careers.tsx", 5],
      ["src/pages", "Blog.tsx", 6],
      ["src/pages", "Status.tsx", 3],
    ],
  },
];

const SUFFIX = ["Table", "Panel", "List", "Summary", "Toolbar", "Grid", "Card", "Section", "Drawer", "Row"];

interface Caller {
  id: string;
  ws: Ws;
  path: string;
  folder: string;
  name: string;
  line: number;
  count: number;
}

const CALLERS: Caller[] = [];
for (const ws of WS) {
  for (const [folder, file, n] of ws.files) {
    const base = file.replace(/\.tsx?$/, "");
    const path = `${ws.dir}/${folder}/${file}`;
    for (let i = 0; i < n; i++) {
      const name = `${base.replace(/Page$/, "")}${SUFFIX[i % SUFFIX.length]}${i >= SUFFIX.length ? i : ""}`;
      CALLERS.push({
        id: `sym:${path}#${name}`,
        ws,
        path,
        folder,
        name,
        line: 12 + i * 14,
        count: i % 4 === 0 ? 2 : 1,
      });
    }
  }
}

interface Group {
  id: string;
  label: string;
  ws: Ws;
  path: string;
  members: Caller[];
}

/** The server's grouping rules (see server/views/egoGroups.ts). */
function plan(): { groups: Group[]; singles: Caller[] } {
  const groups: Group[] = [];
  const singles: Caller[] = [];
  const emit = (g: Group) => (g.members.length <= 3 ? singles.push(...g.members) : groups.push(g));
  for (const ws of WS) {
    const mine = CALLERS.filter((c) => c.ws === ws);
    if (mine.length <= 12) {
      emit({ id: `group:in:1:${ws.id}`, label: ws.short, ws, path: ws.dir, members: mine });
      continue;
    }
    const byFolder = new Map<string, Caller[]>();
    for (const c of mine) {
      const top = c.folder.split("/").slice(0, 2).join("/");
      byFolder.set(top, [...(byFolder.get(top) ?? []), c]);
    }
    for (const [folder, members] of [...byFolder].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const path = `${ws.dir}/${folder}`;
      if (members.length <= 12) {
        emit({ id: `group:in:1:dir:${path}`, label: `${ws.short} · ${folder}`, ws, path, members });
        continue;
      }
      const byFile = new Map<string, Caller[]>();
      for (const c of members) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
      for (const [file, fm] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
        emit({
          id: `group:in:1:file:${file}`,
          label: `${ws.short} · ${file.slice(ws.dir.length + 1)}`,
          ws,
          path: file,
          members: fm,
        });
    }
  }
  return {
    groups: groups.sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1)),
    singles,
  };
}

const fnNode = (c: Caller, extra: Partial<GraphNode>): GraphNode => ({
  id: c.id,
  kind: "component",
  label: c.name,
  size: 1,
  path: c.path,
  stats: { functions: 1, loc: 14 },
  badges: ["exported"],
  workspace: c.ws.id,
  side: "in",
  hop: 1,
  ...extra,
});

export function egoHub(expand: string[]): ViewData {
  const { groups, singles } = plan();
  const nodes: GraphNode[] = [
    {
      id: hubFocus,
      kind: "component",
      label: "DataTable",
      size: 1,
      path: "packages/ui/src/DataTable/DataTable.tsx",
      stats: { functions: 1, loc: 140 },
      badges: ["exported"],
      workspace: "ws:@acme/ui",
      side: "focus",
      hop: 0,
    },
    {
      id: CALLEE,
      kind: "hook",
      label: "useTableState",
      size: 1,
      path: "packages/ui/src/DataTable/useTableState.ts",
      stats: { functions: 1, loc: 62 },
      workspace: "ws:@acme/ui",
      side: "out",
      hop: 1,
    },
  ];
  const owner = new Map<string, string>(); // caller id -> node that stands for it
  for (const s of singles) {
    nodes.push(fnNode(s, {}));
    owner.set(s.id, s.id);
  }
  let budget = EGO_MAX - nodes.length - groups.length;
  const sorted = [...expand].sort();
  for (const g of groups) {
    const members = [...g.members].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line,
    );
    const open = sorted.includes(g.id) && budget >= 2;
    nodes.push({
      id: g.id,
      kind: "group",
      label: g.label,
      size: members.length,
      path: g.path,
      workspace: g.ws.id,
      side: "in",
      hop: 1,
      stats: { members: members.length, files: new Set(members.map((m) => m.path)).size },
      badges: [`${members.length} callers`],
      members: members.map((m) => ({ id: m.id, label: m.name, path: m.path, line: m.line })),
      ...(open ? { expanded: true } : {}),
    });
    if (!open) {
      for (const m of members) owner.set(m.id, g.id);
      continue;
    }
    const shown = members.length <= budget ? members : members.slice(0, budget - 1);
    for (const m of shown) {
      nodes.push(fnNode(m, { group: g.id }));
      owner.set(m.id, m.id);
    }
    budget -= shown.length;
    if (shown.length < members.length) {
      const moreId = `more:in:1:${g.id}`;
      nodes.push({
        id: moreId,
        kind: "more",
        label: `+${members.length - shown.length} more`,
        size: members.length - shown.length,
        side: "in",
        hop: 1,
        group: g.id,
        stats: { functions: members.length - shown.length },
      });
      for (const m of members.slice(shown.length)) owner.set(m.id, moreId);
      budget -= 1;
    }
  }
  const agg = new Map<string, GraphEdge>();
  for (const c of CALLERS) {
    const src = owner.get(c.id) as string;
    const id = `${src}|calls|${hubFocus}`;
    const e = agg.get(id);
    if (e) e.weight += c.count;
    else agg.set(id, { id, src, dst: hubFocus, kind: "calls", weight: c.count, confidence: "high" });
  }
  agg.set(`${hubFocus}|calls|${CALLEE}`, {
    id: `${hubFocus}|calls|${CALLEE}`,
    src: hubFocus,
    dst: CALLEE,
    kind: "calls",
    weight: 1,
    confidence: "high",
  });
  return {
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges: [...agg.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    layoutHint: "bowtie",
  };
}

/** `/api/node` for the hub's functions, so selecting one in the inspector works. */
export function hubNode(id: string): NodeDetail | null {
  const c = CALLERS.find((x) => x.id === id);
  if (!c && id !== hubFocus && id !== CALLEE) return null;
  const name = c ? c.name : (id.split("#")[1] ?? id);
  const path = c ? c.path : (id.slice(4).split("#")[0] ?? "");
  return {
    node: {
      id,
      kind: "component",
      name,
      path,
      line: c?.line ?? 1,
      endLine: (c?.line ?? 1) + 10,
      exported: true,
      loc: 11,
    },
    signature: `function ${name}(props)`,
    fan_in: id === hubFocus ? CALLERS.length : 0,
    fan_out: id === hubFocus ? 1 : 1,
    neighbors: {},
    untrusted_description: null,
  };
}
