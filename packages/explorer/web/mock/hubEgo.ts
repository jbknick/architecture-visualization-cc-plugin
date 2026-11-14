// Mock-only ego scenarios. Entirely synthetic. Both serve a shared UI component with 221 direct callers and one
// callee, grouped by the real server's row budget (a copy of server/views/egoGroups.ts, see ./egoRows.ts):
//   `#/ego?focus=<hubFocus>&scenario=hub`       callers concentrated in a few big folders (3 workspaces)
//   `#/ego?focus=<thinFocus>&scenario=hub-thin` callers spread thinly: 201 in one workspace over 104 files in 30
//                                               folders (at most 11 per folder), 20 in another over 16 files
import type { GraphEdge, GraphNode, NodeDetail, ViewData } from "../src/api.ts";
import { type GroupItem, type GroupPlan, planRows, type Row, type WorkspaceInfo } from "./egoRows.ts";
import type { Counts } from "./largeMap.ts";

export const hubFocus = "sym:packages/ui/src/DataTable/DataTable.tsx#DataTable";
const CALLEE = "sym:packages/ui/src/DataTable/useTableState.ts#useTableState";
const EGO_MAX = 400;
export const thinFocus = "sym:packages/design-system-ui/src/components/Button/Button.tsx#Button";
const THIN_CALLEE = "sym:packages/design-system-ui/src/components/Button/useButtonStyles.ts#useButtonStyles";

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

// ---- the thin scenario: 201 callers in one workspace over 104 files in 30 folders, 20 in another over 16 files ----

const THIN_WS: Ws[] = [
  {
    id: "ws:@acme-platform/customer-portal-web",
    short: "customer-portal-web",
    dir: "apps/customer-portal-web",
    files: [],
  },
  {
    id: "ws:@acme-platform/internal-admin-console",
    short: "internal-admin-console",
    dir: "apps/internal-admin-console",
    files: [],
  },
];
const THIN_UI: Ws = {
  id: "ws:@acme-platform/design-system-ui",
  short: "design-system-ui",
  dir: "packages/design-system-ui",
  files: [],
};

const THIN_FOLDERS = [
  "components/review",
  "components/billing/invoices",
  "components/billing/payments",
  "components/orders/list",
  "components/orders/detail",
  "components/customers",
  "components/catalog",
  "components/checkout",
  "components/account",
  "components/support",
  "components/reports",
  "components/onboarding/identity-verification/steps",
  "components/onboarding/company-details",
  "components/marketing",
  "components/shared/layout",
  "components/shared/forms",
  "features/search",
  "features/notifications",
  "features/analytics/dashboards",
  "features/analytics/exports",
  "features/settings",
  "features/inventory",
  "pages/dashboard",
  "pages/orders",
  "pages/customers",
  "pages/billing",
  "pages/support",
  "pages/reports",
  "hooks",
  "lib/tables",
];
const THIN_SIZES = [
  11, 11, 11, 10, 10, 10, 9, 9, 9, 8, 8, 8, 8, 7, 7, 7, 7, 6, 6, 6, 6, 5, 5, 5, 5, 4, 4, 4, 3, 3,
];
const NOUNS = [
  "composer",
  "list",
  "card",
  "summary",
  "toolbar",
  "filters",
  "header",
  "footer",
  "panel",
  "table",
  "dialog",
  "form",
];
const SYMS = [
  "Composer",
  "List",
  "Card",
  "Summary",
  "Toolbar",
  "Filters",
  "Header",
  "Footer",
  "Panel",
  "Table",
  "Dialog",
  "Form",
];
const cap = (s: string): string => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`;

function thinCallers(): Caller[] {
  const sizes = [...THIN_SIZES];
  let sum = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; sum > 201; i = (i + 1) % sizes.length) {
    if ((sizes[i] as number) > 3) {
      (sizes[i] as number)--;
      sum--;
    }
  }
  // Files per folder: about one per two callers, adjusted to 104 files in all.
  const nf = sizes.map((n) => Math.max(1, Math.min(n, Math.round(n / 2.1))));
  let files = nf.reduce((a, b) => a + b, 0);
  for (let i = 0; files !== 104; i = (i + 1) % nf.length) {
    if (files < 104 && (nf[i] as number) < (sizes[i] as number)) {
      (nf[i] as number)++;
      files++;
    } else if (files > 104 && (nf[i] as number) > 1) {
      (nf[i] as number)--;
      files--;
    }
  }
  const ws = THIN_WS[0] as Ws;
  const out: Caller[] = [];
  THIN_FOLDERS.forEach((folder, f) => {
    const stem = (folder.split("/").at(-1) as string).replace(/s$/, "");
    for (let k = 0; k < (sizes[f] as number); k++) {
      const file = k % (nf[f] as number);
      const noun = (file + f) % NOUNS.length;
      const path = `${ws.dir}/src/${folder}/${stem}-${NOUNS[noun]}.tsx`;
      const name = `${cap(stem)}${SYMS[noun]}${k >= (nf[f] as number) ? k : ""}`;
      out.push({
        id: `sym:${path}#${name}`,
        ws,
        path,
        folder,
        name,
        line: 10 + k * 12,
        count: k % 5 === 0 ? 2 : 1,
      });
    }
  });
  const admin = THIN_WS[1] as Ws;
  const dirs = ["users", "roles", "audit", "settings"];
  for (let i = 0; i < 20; i++) {
    const d = dirs[i % 4] as string;
    const file = Math.min(i, 15);
    const noun = (Math.floor(file / 4) + (i % 4)) % NOUNS.length;
    const path = `${admin.dir}/src/pages/${d}/${d}-${NOUNS[noun]}${file >= 12 ? "-v2" : ""}.tsx`;
    const name = `Admin${cap(d)}${SYMS[noun]}${i}`;
    out.push({ id: `sym:${path}#${name}`, ws: admin, path, folder: `pages/${d}`, name, line: 8, count: 1 });
  }
  return out;
}
const THIN: Caller[] = thinCallers();

// ---- the server's row budget over a scenario ---------------------------------------------------------------------

interface Scenario {
  focus: string;
  focusLabel: string;
  focusPath: string;
  focusWs: Ws;
  callee: string;
  calleeLabel: string;
  calleePath: string;
  callers: Caller[];
  workspaces: Ws[];
}

const HUB: Scenario = {
  focus: hubFocus,
  focusLabel: "DataTable",
  focusPath: "packages/ui/src/DataTable/DataTable.tsx",
  focusWs: { id: "ws:@acme/ui", short: "ui", dir: "packages/ui", files: [] },
  callee: CALLEE,
  calleeLabel: "useTableState",
  calleePath: "packages/ui/src/DataTable/useTableState.ts",
  callers: CALLERS,
  workspaces: WS,
};
const THIN_SCN: Scenario = {
  focus: thinFocus,
  focusLabel: "Button",
  focusPath: "packages/design-system-ui/src/components/Button/Button.tsx",
  focusWs: THIN_UI,
  callee: THIN_CALLEE,
  calleeLabel: "useButtonStyles",
  calleePath: "packages/design-system-ui/src/components/Button/useButtonStyles.ts",
  callers: THIN,
  workspaces: THIN_WS,
};

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

function build(scn: Scenario, expand: string[], maxRows: number, pageRows: number): ViewData {
  const info = new Map<string, WorkspaceInfo>(
    scn.workspaces.map((w) => [w.id, { dir: w.dir, short: w.short }]),
  );
  const byId = new Map(scn.callers.map((c) => [c.id, c]));
  const items: GroupItem[] = scn.callers.map((c) => ({ id: c.id, path: c.path, ws: c.ws.id }));
  const { rows } = planRows("in", 1, items, info, {
    maxRows,
    pageRows,
    expand: new Set(expand),
    nodeBudget: EGO_MAX - 2,
  });
  const nodes: GraphNode[] = [
    {
      id: scn.focus,
      kind: "component",
      label: scn.focusLabel,
      size: 1,
      path: scn.focusPath,
      stats: { functions: 1, loc: 140 },
      badges: ["exported"],
      workspace: scn.focusWs.id,
      side: "focus",
      hop: 0,
    },
    {
      id: scn.callee,
      kind: "hook",
      label: scn.calleeLabel,
      size: 1,
      path: scn.calleePath,
      stats: { functions: 1, loc: 62 },
      workspace: scn.focusWs.id,
      side: "out",
      hop: 1,
    },
  ];
  const owner = new Map<string, string>(); // caller id -> node that stands for it
  const groupNode = (g: GroupPlan, parent: string | undefined, expanded: boolean): GraphNode => ({
    id: g.id,
    kind: "group",
    label: g.label,
    size: g.members.length,
    path: g.path,
    ...(g.ws ? { workspace: g.ws } : {}),
    ...(parent ? { group: parent } : {}),
    side: "in",
    hop: 1,
    stats: { members: g.members.length, files: g.files },
    badges: [`${g.members.length} ${g.members.length === 1 ? "caller" : "callers"}`],
    members: g.members.map((m) => {
      const c = byId.get(m.id) as Caller;
      return { id: c.id, label: c.name, path: c.path, line: c.line };
    }),
    ...(expanded ? { expanded: true } : {}),
  });
  const emit = (list: Row[], parent?: string) => {
    for (const r of list) {
      if ("item" in r) {
        nodes.push(fnNode(byId.get(r.item.id) as Caller, parent ? { group: parent } : {}));
        owner.set(r.item.id, r.item.id);
      } else if (r.expanded) {
        nodes.push(groupNode(r.group, parent, true));
        emit(r.rows, r.group.id);
      } else {
        nodes.push(groupNode(r.group, parent, false));
        for (const m of r.group.members) owner.set(m.id, r.group.id);
      }
    }
  };
  emit(rows);
  const agg = new Map<string, GraphEdge>();
  for (const c of scn.callers) {
    const src = owner.get(c.id) as string;
    const id = `${src}|calls|${scn.focus}`;
    const e = agg.get(id);
    if (e) e.weight += c.count;
    else agg.set(id, { id, src, dst: scn.focus, kind: "calls", weight: c.count, confidence: "high" });
  }
  agg.set(`${scn.focus}|calls|${scn.callee}`, {
    id: `${scn.focus}|calls|${scn.callee}`,
    src: scn.focus,
    dst: scn.callee,
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

/** The mock's ego response for `scenario=hub` / `hub-thin`; `maxRows` and `pageRows` are the real server's options. */
export function egoHub(
  expand: string[],
  scenario: "hub" | "hub-thin" = "hub",
  maxRows = 18,
  pageRows = 14,
): ViewData {
  return build(scenario === "hub" ? HUB : THIN_SCN, expand, Math.max(8, Math.min(40, maxRows)), pageRows);
}

/** Real counts of an ego scenario's data (what `/api/meta` would report for a repo of that shape). */
export function hubCounts(scenario: "hub" | "hub-thin"): Counts {
  const s = scenario === "hub" ? HUB : THIN_SCN;
  const files = new Set([...s.callers.map((c) => c.path), s.focusPath, s.calleePath]);
  return {
    workspaces: s.workspaces.length + 1,
    files: files.size,
    symbols: s.callers.length + 2,
    edges: s.callers.length + 1,
  };
}

/** `/api/node` for the scenarios' functions, so selecting one in the inspector works. */
export function hubNode(id: string): NodeDetail | null {
  const c = [...CALLERS, ...THIN].find((x) => x.id === id);
  const known = new Set([hubFocus, CALLEE, thinFocus, THIN_CALLEE]);
  if (!c && !known.has(id)) return null;
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
    fan_in: id === hubFocus ? CALLERS.length : id === thinFocus ? THIN.length : 0,
    fan_out: 1,
    neighbors: {},
    untrusted_description: null,
  };
}
