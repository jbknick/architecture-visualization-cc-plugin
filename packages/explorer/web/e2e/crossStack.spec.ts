import { expect, type Page, test } from "playwright/test";

// The cross-stack views (#48) against the mock API's synthetic shop app (mock/crossStack.ts), not the real server.
test.use({ colorScheme: "light", viewport: { width: 1440, height: 900 } });

interface Probe {
  nodes: { id: string; x: number; y: number; lane?: number }[];
  edges: { id: string; kind: string; color: string; dashed: boolean; x: number | null; y: number | null }[];
  lanes: string[];
  zoom: number;
}

const canvas = (page: Page) => page.getByTestId("flow-canvas").locator("canvas.flow-canvas");

async function open(page: Page, hash: string) {
  await page.goto(`/#/${hash}${hash.includes("?") ? "&" : "?"}scenario=crossstack`);
  await expect(page.locator("canvas.flow-canvas[data-ready=true]")).toBeVisible({ timeout: 20_000 });
}

async function probe(page: Page): Promise<Probe> {
  await page.waitForTimeout(150);
  return JSON.parse(
    await canvas(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as Probe;
}

/**
 * Inspector facts lay out as key/value rows: every row stays inside the inspector, and no value is squeezed into a
 * sliver (a value wrapping one character per line is a few pixels wide and many lines tall).
 */
async function expectFactsTidy(page: Page, label: string) {
  const bad = await page.evaluate((name) => {
    const out: string[] = [];
    const panel = document.querySelector("aside.inspector")?.getBoundingClientRect();
    const dl = document.querySelector(`dl[aria-label="${name}"]`);
    if (!panel || !dl) return ["no facts list"];
    for (const dd of dl.querySelectorAll("dd")) {
      const r = dd.getBoundingClientRect();
      const lineH = Number.parseFloat(getComputedStyle(dd).lineHeight) || 20;
      if (r.right > panel.right + 1 || r.left < panel.left - 1)
        out.push(`value leaves the inspector: ${dd.textContent}`);
      if ((dd.textContent ?? "").length > 6 && r.width < 80) out.push(`value squeezed: ${dd.textContent}`);
      if (r.height > lineH * 4) out.push(`value wraps too much: ${dd.textContent}`);
    }
    return out;
  }, label);
  expect(bad).toEqual([]);
}

async function at(page: Page, x: number, y: number) {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("canvas has no box");
  return { x: box.x + x, y: box.y + y };
}

test("the five tabs are enabled when adapters found nodes; endpoints are grouped by kind in lanes", async ({
  page,
}) => {
  await open(page, "endpoints");
  for (const name of ["Endpoints", "Page → API", "API → tables", "Feature path", "Table usage"])
    await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-disabled", "false");
  await expect(canvas(page)).toHaveAttribute("data-nodes", "17");
  const p = await probe(page);
  expect(p.lanes).toEqual(["Endpoint", "Middleware", "Handler", "Services, call 1"]);
  // Bands are stacked: rpc above http above server fn, and every endpoint sits in the first lane.
  const y = (id: string) => p.nodes.find((n) => n.id === id)?.y ?? 0;
  expect(y("ep:pnpm-turbo:@shop/api:rpc orders.list")).toBeLessThan(
    y("ep:pnpm-turbo:@shop/server:GET /api/users"),
  );
  expect(y("ep:pnpm-turbo:@shop/server:GET /api/users")).toBeLessThan(
    y("ep:pnpm-turbo:@shop/web:fn getStats"),
  );
  for (const n of p.nodes.filter((x) => x.id.startsWith("ep:"))) expect(n.lane).toBe(0);
  // Filters: only the server function.
  const panel = page.getByRole("complementary", { name: /filters/i }).or(page.locator(".filter-panel"));
  // Controlled boxes follow the URL a moment later, so click and then wait for the state.
  await panel.getByRole("checkbox", { name: /rpc/ }).click();
  await expect(panel.getByRole("checkbox", { name: /rpc/ })).not.toBeChecked();
  await panel.getByRole("checkbox", { name: /http/ }).click();
  await expect(panel.getByRole("checkbox", { name: /http/ })).not.toBeChecked();
  await expect(canvas(page)).toHaveAttribute("data-nodes", "3");
});

test("page -> API: a dashed low-confidence line, and the via count on hover", async ({ page }) => {
  await open(page, "page-api");
  const p = await probe(page);
  expect(p.lanes).toEqual(["Pages (routes)", "Endpoints"]);
  const cart = p.edges.find(
    (e) => e.id === "route:pnpm-turbo:@shop/web:/orders/$orderId|requests|ep:@shop/server:POST /api/cart",
  );
  expect(cart?.dashed).toBe(true);
  const get = p.edges.find(
    (e) => e.id === "route:pnpm-turbo:@shop/web:/orders/$orderId|requests|ep:@shop/api:rpc orders.get",
  );
  expect(get?.dashed).toBe(false);
  const pt = await at(page, get?.x ?? 0, get?.y ?? 0);
  await page.mouse.move(pt.x, pt.y);
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("requests");
  await expect(tip).toContainText("via 2 places in the page");
  await expect(tip).toContainText("OrderPage, useOrders");
});

test("API -> tables: reads are blue, writes orange; services expand on request", async ({ page }) => {
  await open(page, "api-tables");
  const p = await probe(page);
  expect(p.lanes).toEqual(["Endpoints", "Database calls", "Tables"]);
  const reads = p.edges.filter((e) => e.kind === "reads");
  const writes = p.edges.filter((e) => e.kind === "writes");
  expect(reads.length).toBeGreaterThan(0);
  expect(writes.length).toBeGreaterThan(0);
  for (const e of reads) expect(e.color).toBe("#1d5fd6");
  for (const e of writes) expect(e.color).toBe("#c2510c");
  expect(
    p.edges.find((e) => e.id === "sym:pnpm-turbo:packages/db/src/cart.ts#addItem|reads|table:orders")?.dashed,
  ).toBe(true);
  await expect(page.locator(".flow-key")).toContainText("writes");
  expect(p.edges.some((e) => e.kind === "handles")).toBe(false);
  await page.getByRole("checkbox", { name: "Every service function on the way" }).click();
  await expect(page).toHaveURL(/services/);
  await expect.poll(async () => (await probe(page)).edges.some((e) => e.kind === "handles")).toBe(true);
  expect((await probe(page)).lanes).toEqual(["Endpoints", "Services", "Tables"]);
});

test("feature path: asks for a focus, then lays the feature out in five swimlanes", async ({ page }) => {
  await page.goto("/#/feature-path?scenario=crossstack");
  const prompt = page.getByTestId("flow-focus-prompt");
  await expect(prompt.getByRole("heading", { name: "Pick a page or an endpoint" })).toBeVisible();
  await prompt.getByRole("searchbox").fill("orderId");
  await prompt.getByRole("button", { name: "/orders/$orderId" }).click();
  await expect(page.locator("canvas.flow-canvas[data-ready=true]")).toBeVisible({ timeout: 20_000 });
  const p = await probe(page);
  expect(p.lanes).toEqual(["Page", "Client", "Endpoint", "Service", "Table"]);
  const lane = (id: string) => p.nodes.find((n) => n.id === id)?.lane;
  expect(lane("route:pnpm-turbo:@shop/web:/orders/$orderId")).toBe(0);
  expect(lane("sym:pnpm-turbo:apps/web/src/hooks/useCart.ts#useCart")).toBe(1);
  expect(lane("ep:pnpm-turbo:@shop/api:rpc orders.cancel")).toBe(2);
  expect(lane("table:pnpm-turbo:orders")).toBe(4);
  await expect(page.locator(".filter-panel")).toContainText("unmatched client call");
});

test("table usage: writers above readers, and the inspector of a table and an endpoint", async ({ page }) => {
  await open(page, "table-usage?focus=table%3Aorders&sel=");
  const p = await probe(page);
  const table = p.nodes.find((n) => n.id === "table:pnpm-turbo:orders");
  expect(table?.lane).toBe(Math.max(...p.nodes.map((n) => n.lane ?? 0)));
  const y = (id: string) => p.nodes.find((n) => n.id === id)?.y ?? 0;
  expect(y("sym:pnpm-turbo:packages/db/src/orders.ts#cancelOrder")).toBeLessThan(
    y("sym:pnpm-turbo:packages/db/src/orders.ts#loadOrders"),
  );
  expect(p.nodes.some((n) => n.id === "route:pnpm-turbo:@shop/web:/orders")).toBe(true);

  const pt = await at(page, table?.x ?? 0, table?.y ?? 0);
  await page.mouse.click(pt.x, pt.y);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const section = inspector.getByRole("region", { name: "Table" });
  await expect(section).toContainText("Columns (4)");
  await expect(section).toContainText("id, userId, status, total");
  await expect(section).toContainText("Writers1");
  await expectFactsTidy(page, "Table facts");
  // The code itself is listed once, under Connections ("Written by", "Read by").
  await expect(inspector.getByRole("heading", { name: /^Read by/ })).toHaveCount(1);
  await inspector.getByRole("button", { name: "cancelOrder" }).first().click();
  await expect(inspector.getByRole("heading", { name: "cancelOrder" })).toBeVisible();

  // The inspector took room from the canvas, which fitted again: measure anew.
  await page.waitForTimeout(300);
  const ep = (await probe(page)).nodes.find((n) => n.id === "ep:pnpm-turbo:@shop/api:rpc orders.cancel");
  const pe = await at(page, ep?.x ?? 0, ep?.y ?? 0);
  await page.mouse.click(pe.x, pe.y);
  const facts = inspector.getByRole("region", { name: "Endpoint" });
  await expect(facts).toContainText("orders.cancel");
  await expect(facts).toContainText("ordersRouter");
  await expect(facts).toContainText("RPC");
  await expect(facts).toContainText("Requested from1 place");
  await expectFactsTidy(page, "Endpoint facts");
  await inspector.getByRole("button", { name: "Show feature path" }).click();
  await expect(page).toHaveURL(/#\/feature-path\?focus=ep/);
  await expect(page.locator("canvas.flow-canvas[data-ready=true]")).toBeVisible({ timeout: 20_000 });
});

test("a deep link to a tab off the strip scrolls it into sight, and hidden tabs have a scroll button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await open(page, "table-usage?focus=table%3Aorders&sel=");
  const strip = page.locator(".tab-strip > nav");
  const nav = await strip.boundingBox();
  const active = await page.getByRole("tab", { name: "Table usage" }).boundingBox();
  if (!nav || !active) throw new Error("no tab strip");
  expect(active.x).toBeGreaterThanOrEqual(nav.x - 1);
  expect(active.x + active.width).toBeLessThanOrEqual(nav.x + nav.width + 1);
  // The first tabs are scrolled away: a button brings them back.
  const back = page.getByRole("button", { name: "Show earlier views" });
  await expect(back).toBeVisible();
  for (let i = 0; i < 8 && (await back.count()) > 0; i++) {
    await back.click();
    await page.waitForTimeout(100);
  }
  await expect(page.getByRole("button", { name: "Show earlier views" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show more views" })).toBeVisible();
  const first = await page.getByRole("tab", { name: "Project map" }).boundingBox();
  const navNow = await strip.boundingBox();
  expect(first?.x ?? 0).toBeGreaterThanOrEqual((navNow?.x ?? 0) - 1);
});
