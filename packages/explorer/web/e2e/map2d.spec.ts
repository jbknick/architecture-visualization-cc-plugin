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
  await expect(canvas(page).locator(".gc-status")).toContainText("treemap");
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
  await page.waitForTimeout(1200);
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
      expect(r.y).toBeGreaterThanOrEqual(56 - 1); // below the strip with the controls
      expect(r.x + r.w).toBeLessThanOrEqual(box.width);
      expect(r.y + r.h).toBeLessThanOrEqual(box.height - 40 + 1); // above the status chip
    }
    // Every title sits inside its box (a title that did not fit would be beside it or hidden).
    expect(Object.values(p.titles), level).toHaveLength(11);
    expect(
      Object.entries(p.titles).filter(([, where]) => where !== "inside"),
      level,
    ).toEqual([]);
    expect(p.hiddenTitles, level).toEqual([]);
    expect(p.scale).toBeCloseTo(p.fitScale, 5);
  }
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
