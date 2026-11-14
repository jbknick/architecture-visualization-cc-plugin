import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// The 2D project map on the mock API's synthetic "large" scenario (`scenario=large`, mock-only): 11 workspaces,
// three big (1,700 / 980 / 960 functions) and eight tiny, long scoped names, ~880 files, ~3,700 functions.
test.use({ viewport: { width: 1440, height: 900 } });

const canvas = (page: Page) => page.getByTestId("graph-canvas");
const surface = (page: Page) => canvas(page).locator(".gc-sigma");

interface Probe {
  scale: number;
  fitScale: number;
  hiddenTitles: string[];
  titles: Record<string, "inside" | "beside" | "hidden">;
  titleTexts: Record<string, string>;
  pills: { key: string; count: string; text: string }[];
  regions: { id: string; x: number; y: number; w: number; h: number }[];
  edges: { key: string; x: number; y: number; weight: number }[];
}

async function probe(page: Page): Promise<Probe> {
  await page.waitForTimeout(150);
  return JSON.parse(
    await surface(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as Probe;
}

async function openLarge(page: Page, level: string, extra = "") {
  await page.goto(`/#/project-map?level=${level}&scenario=large${extra}`);
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  // The layout/timing chip is debug text: not shown to users.
  await expect(canvas(page).locator(".gc-status")).toHaveCount(0);
  // Folders level: the faint file mosaic arrives in the background and the map is laid out again.
  if (level === "dirs") await expect(canvas(page).locator(".gc-sigma[data-mosaic=true]")).toBeVisible();
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
}

for (const [level, name] of [
  ["workspaces", "workspaces"],
  ["dirs", "folders"],
  ["files", "files"],
  ["symbols", "functions"],
] as const) {
  test(`large scenario, ${name} level (light)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openLarge(page, level);
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: resolve(shots, `map-2d-large-${name}.png`) });
  });
}

test("large scenario, folders level (dark)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openLarge(page, "dirs");
  await page.screenshot({ path: resolve(shots, "map-2d-large-dark.png") });
});

/** Zooms the camera to a node by id (the canvas listens for `gantry:zoom-to`) and waits for the animation. */
async function zoomTo(page: Page, id: string) {
  await canvas(page).evaluate((el, nodeId) => {
    el.dispatchEvent(new CustomEvent("gantry:zoom-to", { detail: { id: nodeId } }));
  }, id);
  await page.waitForTimeout(900);
  await page.mouse.move(2, 2);
}

for (const scheme of ["light", "dark"] as const) {
  test(`large scenario, files level zoomed in (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openLarge(page, "files");
    // Into the biggest workspace, then one zoom step further: file names are readable, headers stay slim.
    await zoomTo(page, "ws:@acme-platform-monorepo/api");
    const { regions } = await probe(page);
    const api = regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
    const box = await surface(page).boundingBox();
    if (!api || !box) throw new Error("api box missing");
    // Wheel about the top-left corner of the box, so its title and the first folder strips stay in view.
    await page.mouse.move(box.x + api.x + 10, box.y + api.y + 10);
    await page.mouse.wheel(0, -420);
    await page.waitForTimeout(500);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(shots, `map-2d-large-zoomed${scheme === "dark" ? "-dark" : ""}.png`),
    });
  });
}

test("large scenario, workspace selected", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openLarge(page, "dirs");
  // The inspector opens beside the canvas on selection; fold the filters away so the map keeps its room.
  await page.getByRole("button", { name: "Collapse filters" }).click();
  await page.waitForTimeout(900);
  const { regions } = await probe(page);
  const api = regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
  if (!api) throw new Error("api box missing");
  const box = await surface(page).boundingBox();
  if (!box) throw new Error("no canvas");
  // Click the title strip of the box (no cell there), so the workspace itself is selected.
  await page.mouse.click(box.x + api.x + 30, box.y + api.y + 10);
  await expect(page).toHaveURL(/sel=ws%3A%40acme-platform-monorepo%2Fapi/);
  await page.mouse.move(box.x + 4, box.y + box.height - 4);
  await page.waitForTimeout(2200); // the canvas was resized twice and laid out again each time
  await page.screenshot({ path: resolve(shots, "map-2d-large-selected.png") });
});

test("large scenario: the whole diagram fits the canvas and every workspace title is inside its box", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const level of ["workspaces", "dirs", "files", "symbols"]) {
    await openLarge(page, level);
    const box = await surface(page).boundingBox();
    if (!box) throw new Error("no canvas");
    const p = await probe(page);
    expect(p.regions).toHaveLength(11);
    for (const r of p.regions) {
      expect(r.x, `${level} ${r.id}`).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(44 - 1); // below the strip with the controls
      expect(r.x + r.w).toBeLessThanOrEqual(box.width);
      expect(r.y + r.h).toBeLessThanOrEqual(box.height - 34 + 1); // above the status chip
    }
    // Every title sits inside its box (a title that did not fit would be beside it or hidden).
    expect(Object.values(p.titles), level).toHaveLength(11);
    expect(
      Object.entries(p.titles).filter(([, where]) => where !== "inside"),
      level,
    ).toEqual([]);
    expect(p.hiddenTitles, level).toEqual([]);
    // The repo-root workspace (id `ws:.`, a 31-character unscoped name) always shows a title, at every level.
    expect(p.titles["ws:."], level).not.toBe("hidden");
    expect(p.titleTexts["ws:."], level).toMatch(
      /\(repo root\)|acme-platform-monorepo-root-app|acme-platform/,
    );
    expect(p.scale).toBeCloseTo(p.fitScale, 5);
  }
});

test("large scenario: the diagram fills the canvas and the biggest workspace is big", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const level of ["workspaces", "dirs", "symbols"]) {
    await openLarge(page, level);
    const box = await surface(page).boundingBox();
    if (!box) throw new Error("no canvas");
    const { regions } = await probe(page);
    const x0 = Math.min(...regions.map((r) => r.x));
    const x1 = Math.max(...regions.map((r) => r.x + r.w));
    const y0 = Math.min(...regions.map((r) => r.y));
    const y1 = Math.max(...regions.map((r) => r.y + r.h));
    const wide = (x1 - x0) / box.width;
    const tall = (y1 - y0) / box.height;
    expect(Math.max(wide, tall), `${level}: ${wide.toFixed(2)} x ${tall.toFixed(2)}`).toBeGreaterThanOrEqual(
      0.88,
    );
    expect(wide * tall, level).toBeGreaterThanOrEqual(0.6);
    const biggest = Math.max(...regions.map((r) => r.w));
    expect(biggest / box.width, level).toBeGreaterThanOrEqual(0.22);
  }
});

test("large scenario: hovering a workspace row outlines its box, clicking the row selects it", async ({
  page,
}) => {
  await openLarge(page, "dirs");
  const row = page.getByRole("checkbox", { name: /^core/ }).locator("xpath=ancestor::label");
  await row.hover();
  await page.waitForTimeout(250);
  const hovered = JSON.parse(
    await surface(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as { panelHover?: string };
  expect(hovered.panelHover).toBe("ws:@acme-platform-monorepo/core");
  await row.locator(".check-label").click();
  await expect(page).toHaveURL(/sel=ws%3A%40acme-platform-monorepo%2Fcore/);
  // The checkbox itself still toggles visibility and is left alone by the row click.
  await expect(page.getByRole("checkbox", { name: /^core/ })).toBeChecked();
});

test("large scenario: declared-only dependencies are hidden until the toggle is on", async ({ page }) => {
  await openLarge(page, "dirs");
  const before = (await probe(page)).edges.length;
  expect(before).toBe(22); // the real import links only
  await page.getByLabel("Show declared dependencies").check();
  await page.waitForTimeout(300);
  const after = (await probe(page)).edges.length;
  expect(after).toBe(53); // plus the 31 declared-only ones
  await page.getByLabel("Show declared dependencies").uncheck();
});

test("large scenario: hover shows a tooltip, click selects a cell, double-click drills into a workspace", async ({
  page,
}) => {
  await openLarge(page, "files");
  const box = await surface(page).boundingBox();
  if (!box) throw new Error("no canvas");
  const { regions } = await probe(page);
  const api = regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
  if (!api) throw new Error("api box missing");
  // A point inside the treemap part of the box (below the title strip).
  const x = box.x + api.x + api.w / 2;
  const y = box.y + api.y + api.h - 12;
  await page.mouse.move(x, y);
  await expect(page.getByRole("tooltip")).toContainText(/functions|src/);
  await page.mouse.click(x, y);
  await expect(page).toHaveURL(/sel=(dir|file)%3Aapps%2Fapi/);
  // The inspector opened, so the canvas was resized and laid out again: find the box again.
  await page.waitForTimeout(900);
  const moved = (await probe(page)).regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
  if (!moved) throw new Error("api box missing after resize");
  await page.mouse.dblclick(box.x + moved.x + 14, box.y + moved.y + 8);
  await expect(page).toHaveURL(/focus=ws%3A%40acme-platform-monorepo%2Fapi/);
  // Drilling in shows that workspace alone, fitted.
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible();
  await expect.poll(async () => (await probe(page)).regions.length).toBe(1);
});

test("large scenario: every count pill shows the import weight of its pair, never the sum with a declared dependency", async ({
  page,
}) => {
  const { projectMapLarge } = await import("../mock/largeMap.ts");
  const view = projectMapLarge({ focus: null, level: "workspaces", options: {} });
  if ("error" in view) throw new Error(view.error);
  const imports = new Map(
    view.edges.filter((e) => e.kind === "imports").map((e) => [`${e.src}>${e.dst}`, e.weight]),
  );
  // The mock has pairs with an imports edge and a depends_on edge side by side (the case that showed N + 1).
  const both = view.edges.filter((e) => e.kind === "depends_on" && imports.has(`${e.src}>${e.dst}`));
  expect(both.length).toBeGreaterThan(0);

  await openLarge(page, "dirs");
  await page.getByLabel("Show declared dependencies").check();
  await page.waitForTimeout(300);
  const check = async (label: string) => {
    const p = await probe(page);
    expect(p.pills.length, label).toBeGreaterThan(0);
    for (const pill of p.pills) {
      const expected = imports.get(pill.key);
      if (pill.count === "declared") {
        expect(expected, `${label}: ${pill.key} is declared only, so it has no number`).toBeUndefined();
        continue;
      }
      expect(expected, `${label}: ${pill.key} has an imports edge`).toBeDefined();
      expect(Number(pill.count.replace(/,/g, "")), `${label}: ${pill.key}`).toBe(expected);
    }
    for (const e of p.edges) {
      const expected = imports.get(e.key);
      if (expected !== undefined) expect(e.weight, `${label}: arrow ${e.key}`).toBe(expected);
    }
  };
  await check("overview");
  // Hovering a workspace row shows all of its links with a pill each.
  await page.getByRole("checkbox", { name: /^core/ }).locator("xpath=ancestor::label").hover();
  await page.waitForTimeout(300);
  await check("core highlighted");
  await page.getByLabel("Show declared dependencies").uncheck();
});

test("large scenario: the layout/timing chip appears only with ?debug=1", async ({ page }) => {
  await page.goto("/#/project-map?level=workspaces&scenario=large");
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await expect(canvas(page).locator(".gc-status")).toHaveCount(0);
  await page.goto("/?debug=1#/project-map?level=workspaces&scenario=large");
  await expect(canvas(page).locator(".gc-status")).toContainText("treemap");
});
