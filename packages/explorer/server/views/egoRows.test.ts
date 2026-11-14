import { describe, expect, it } from "vitest";
import {
  folderLabel,
  type GroupItem,
  type GroupPlan,
  planRows,
  type Row,
  type WorkspaceInfo,
} from "./egoGroups.js";

// A shared component shaped like a real monorepo hit: 221 direct callers, 201 in one workspace spread thinly
// (104 files in 30 folders, at most 11 callers per folder, most files with 1-3), 20 in another over 16 files.
const A = "ws:@acme/customer-portal-web";
const B = "ws:@acme/internal-admin-console";
const WS = new Map<string, WorkspaceInfo>([
  [A, { dir: "apps/customer-portal-web", short: "customer-portal-web" }],
  [B, { dir: "apps/internal-admin-console", short: "internal-admin-console" }],
]);

const AREAS = [
  "billing/invoices",
  "billing/payments",
  "billing/plans",
  "orders/list",
  "orders/detail",
  "orders/returns",
  "customers/profile",
  "customers/search",
  "customers/segments",
  "catalog/browse",
  "catalog/product",
  "catalog/reviews",
  "checkout/cart",
  "checkout/shipping",
  "checkout/payment",
  "account/settings",
  "account/security",
  "account/notifications",
  "support/tickets",
  "support/chat",
  "support/knowledge-base",
  "reports/sales",
  "reports/inventory",
  "reports/exports",
  "onboarding/identity-verification/steps",
  "onboarding/company-details/steps",
  "marketing/campaigns",
  "marketing/audiences",
  "shared/layout",
  "shared/forms",
];

function thin(flat = false): GroupItem[] {
  const sizes = [
    11, 11, 11, 10, 10, 10, 9, 9, 9, 8, 8, 8, 8, 7, 7, 7, 7, 6, 6, 6, 6, 5, 5, 5, 5, 4, 4, 4, 3, 3,
  ];
  let sum = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; sum > 201; i = (i + 1) % sizes.length) {
    if ((sizes[i] as number) > 3) {
      (sizes[i] as number)--;
      sum--;
    }
  }
  const items: GroupItem[] = [];
  AREAS.forEach((area, f) => {
    const n = sizes[f] as number;
    const nf = Math.max(1, Math.min(n, Math.round(n / 2.1)));
    for (let k = 0; k < n; k++) {
      const dir = flat ? `src/${area.replace("/", "-")}` : `src/features/${area}`;
      const path = `apps/customer-portal-web/${dir}/Part${k % nf}.tsx`;
      items.push({ id: `sym:${path}#Caller${k}`, path, ws: A });
    }
  });
  for (let i = 0; i < 20; i++) {
    const dir = ["users", "roles", "audit", "billing"][i % 4];
    const path = `apps/internal-admin-console/src/pages/${dir}/Page${i % 16}.tsx`;
    items.push({ id: `sym:${path}#Admin${i}`, path, ws: B });
  }
  return items;
}

type Opts = Parameters<typeof planRows>[4];
const plan = (items: GroupItem[], over: Partial<Opts> = {}) =>
  planRows("in", 1, items, WS, { maxRows: 18, pageRows: 14, expand: new Set(), nodeBudget: 400, ...over });

type GroupRow = Extract<Row, { group: GroupPlan }>;
const groupsOf = (rows: Row[]): GroupPlan[] =>
  rows.filter((r): r is GroupRow => "group" in r).map((r) => r.group);
const find = (rows: Row[], id: string): GroupRow =>
  rows.find((r): r is GroupRow => "group" in r && r.group.id === id) as GroupRow;
const total = (rows: Row[]): number =>
  rows.reduce((n, r) => n + ("item" in r ? 1 : r.expanded ? total(r.rows) : r.group.members.length), 0);

describe("ego row budget", () => {
  it("the thin distribution is the shape we mean", () => {
    const items = thin();
    expect(items).toHaveLength(221);
    expect(items.filter((i) => i.ws === A)).toHaveLength(201);
    expect(new Set(items.filter((i) => i.ws === A).map((i) => i.path)).size).toBeGreaterThanOrEqual(80);
  });

  it("returns at most 18 group rows for 221 callers, and the counts add up", () => {
    const { rows } = plan(thin());
    expect(rows.length).toBeLessThanOrEqual(18);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.every((r) => "group" in r)).toBe(true);
    expect(total(rows)).toBe(221);
    const ids = groupsOf(rows).map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("honours maxRows from 8 to 40", () => {
    for (const maxRows of [8, 12, 24, 40]) {
      const { rows } = plan(thin(), { maxRows });
      expect(rows.length, `maxRows ${maxRows}`).toBeLessThanOrEqual(maxRows);
      expect(total(rows)).toBe(221);
    }
  });

  it("flat folders: the biggest are rows, the others sit behind one rest row", () => {
    const { rows } = plan(thin(true));
    expect(rows.length).toBeLessThanOrEqual(18);
    expect(total(rows)).toBe(221);
    const rest = groupsOf(rows).find((g) => g.level === "rest");
    expect(rest?.id).toBe("group:in:1:rest:ws:@acme/customer-portal-web");
    expect(rest?.label).toMatch(/^customer-portal-web · \d+ other callers in \d+ files$/);
    // Expanding the rest group pages its folders.
    const open = find(
      plan(thin(true), { pageRows: 6, expand: new Set([rest?.id as string]) }).rows,
      rest?.id as string,
    );
    expect(open.rows).toHaveLength(6);
    expect((open.rows.at(-1) as GroupRow).group.level).toBe("more");
  });

  it("is deterministic, whatever the input order", () => {
    const a = plan(thin());
    const b = plan([...thin()].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("labels say what a row is", () => {
    const labels = groupsOf(plan(thin()).rows).map((g) => g.label);
    expect(labels.some((l) => /^customer-portal-web › [\w/…-]+ — \d+ callers in \d+ files$/.test(l))).toBe(
      true,
    );
    for (const l of labels) expect(l).not.toContain("src/");
  });

  it("merges small siblings into one rest row per parent", () => {
    const items: GroupItem[] = [];
    const add = (dir: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const path = `apps/customer-portal-web/src/${dir}/f.tsx`;
        items.push({ id: `sym:${path}#c${i}`, path, ws: A });
      }
    };
    add("alpha", 8);
    add("beta", 6);
    for (let i = 0; i < 12; i++) add(`small${i}`, 2);
    const { rows } = plan(items, { maxRows: 8 });
    const rest = groupsOf(rows).find((g) => g.level === "rest");
    expect(rest?.id).toBe("group:in:1:rest:ws:@acme/customer-portal-web");
    expect(rest?.members).toHaveLength(24);
    expect(rest?.label).toBe("customer-portal-web · 24 other callers in 12 files");
    expect(total(rows)).toBe(38);
  });

  it("shows nodes one by one when the side has maxRows nodes or fewer", () => {
    const { rows } = plan(thin().slice(0, 18));
    expect(rows.every((r) => "item" in r)).toBe(true);
    expect(rows).toHaveLength(18);
  });

  it("expanding a group shows its children, within one page", () => {
    const big = [...groupsOf(plan(thin()).rows)].sort(
      (a, b) => b.members.length - a.members.length,
    )[0] as GroupPlan;
    const { rows, added } = plan(thin(), { expand: new Set([big.id]) });
    const open = find(rows, big.id);
    expect(open.expanded).toBe(true);
    expect(open.rows.length).toBeGreaterThan(0);
    expect(open.rows.length).toBeLessThanOrEqual(14);
    expect(added).toBe(open.rows.length);
    expect(total(open.rows)).toBe(big.members.length);
  });

  it("pages a group with many children behind a '+N more' row", () => {
    const flat = thin(true);
    const rest = groupsOf(plan(flat).rows).find((g) => g.level === "rest") as GroupPlan;
    const open = find(plan(flat, { pageRows: 6, expand: new Set([rest.id]) }).rows, rest.id);
    expect(open.rows).toHaveLength(6);
    const last = open.rows.at(-1) as GroupRow;
    expect(last.group.level).toBe("more");
    expect(last.group.id).toBe(`group:in:1:more:rest:ws:@acme/customer-portal-web:5`);
    expect(last.group.label).toMatch(/^\+\d+ more callers in \d+ files$/);
    expect(total(open.rows)).toBe(rest.members.length);
    // The next page replaces the "+N more" row by its own rows.
    const next = find(plan(flat, { pageRows: 6, expand: new Set([rest.id, last.group.id]) }).rows, rest.id);
    const more = next.rows.at(-1) as GroupRow;
    expect(more.group.id).toBe(last.group.id);
    expect(more.expanded).toBe(true);
    expect(more.rows).toHaveLength(6);
    expect(total(next.rows)).toBe(rest.members.length);
  });

  it("a file group expands to its callers", () => {
    const items: GroupItem[] = [];
    for (let f = 0; f < 4; f++)
      for (let k = 0; k < 5; k++) {
        const path = `apps/customer-portal-web/src/ui/File${f}.tsx`;
        items.push({ id: `sym:${path}#c${k}`, path, ws: A });
      }
    const rows = plan(items, { maxRows: 8 }).rows;
    const file = groupsOf(rows)[0] as GroupPlan;
    expect(file.level).toBe("file");
    expect(file.label).toBe("File0.tsx — 5 callers");
    const open = find(plan(items, { maxRows: 8, expand: new Set([file.id]) }).rows, file.id);
    expect(open.rows.every((r) => "item" in r)).toBe(true);
    expect(open.rows).toHaveLength(5);
  });

  it("skips an expansion that would pass the node budget", () => {
    const big = groupsOf(plan(thin()).rows)[0] as GroupPlan;
    const { rows, added } = plan(thin(), { expand: new Set([big.id]), nodeBudget: 3 });
    expect(added).toBe(0);
    expect(rows.every((r) => "group" in r && !r.expanded)).toBe(true);
  });
});

describe("folder labels", () => {
  it("drops a leading src/ and shortens only long paths, keeping the last two folders", () => {
    expect(folderLabel("src/components/review")).toBe("components/review");
    expect(folderLabel("lib/a")).toBe("lib/a");
    const long = "src/features/customer-onboarding/steps/identity-verification/components";
    expect(folderLabel(long)).toBe("…/identity-verification/components");
  });
});
