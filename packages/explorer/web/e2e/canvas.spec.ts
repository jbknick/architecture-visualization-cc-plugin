import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// Runs against the in-repo mock API: a synthetic 5-workspace pnpm-turbo-like hierarchy (mock/hierarchy.ts).
test.use({ colorScheme: "light", viewport: { width: 1440, height: 900 } });

const canvas = (page: Page) => page.getByTestId("graph-canvas");
const sigmaBox = (page: Page) => canvas(page).locator(".gc-sigma");

interface Probe {
  hash: string;
  edges: { key: string; x: number; y: number; weight: number }[];
  regions: { id: string; x: number; y: number; w: number; h: number }[];
}

async function openMap(page: Page, hash = "#/canvas-demo") {
  await page.goto(`/${hash}`);
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 20_000 });
}

async function zoomTo(page: Page, id: string, level: string) {
  await canvas(page).evaluate((el, target) => {
    el.dispatchEvent(new CustomEvent("gantry:zoom-to", { detail: { id: target } }));
  }, id);
  await expect(sigmaBox(page)).toHaveAttribute("data-level", level, { timeout: 5000 });
  await page.waitForTimeout(700); // camera animation
}

/** Hit geometry of the last frame, in canvas-local pixels. */
async function probe(page: Page): Promise<Probe> {
  await page.waitForTimeout(150);
  return JSON.parse(
    await sigmaBox(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as Probe;
}

async function origin(page: Page) {
  const box = await sigmaBox(page).boundingBox();
  if (!box) throw new Error("canvas has no box");
  return box;
}

test("far zoom shows labelled workspace regions with weighted arrows", async ({ page }) => {
  await openMap(page);
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "far");
  // The key starts collapsed in the strip above the diagram, so it never covers the fitted picture.
  const legend = page.getByRole("complementary", { name: "Legend" });
  await expect(legend).toContainText("Legend");
  await expect(legend).not.toContainText("@acme/web");
  await legend.getByRole("button").click();
  await expect(legend).toContainText("@acme/web");
  await legend.getByRole("button").click();
  await page.waitForTimeout(300);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "canvas-far.png") });
});

test("mid zoom shows directories and files inside the workspace", async ({ page }) => {
  await openMap(page);
  await zoomTo(page, "ws:@acme/web", "mid");
  await page.screenshot({ path: resolve(shots, "canvas-mid.png") });
});

test("near zoom shows file regions with labelled symbols", async ({ page }) => {
  await openMap(page);
  await zoomTo(page, "file:packages/web/src/components/Modal.ts", "near");
  await page.screenshot({ path: resolve(shots, "canvas-near.png") });
});

test("selecting a workspace highlights it and shows edge counts; Esc clears", async ({ page }) => {
  await openMap(page);
  const { regions } = await probe(page);
  const box = await origin(page);
  const web = regions.find((r) => r.id === "ws:@acme/web");
  if (!web) throw new Error("web region missing");
  // The title strip at the top of the box holds no cell, so a click there selects the workspace itself.
  await page.mouse.click(box.x + web.x + 14, box.y + web.y + 8);
  await expect(page).toHaveURL(/sel=ws%3A%40acme%2Fweb/);
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(shots, "canvas-selected.png") });
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/sel=/);
});

async function press(page: Page, key: string, times: number) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(320); // let the zoom animation finish
  }
}

test("keyboard: + and - zoom through the levels, 0 fits", async ({ page }) => {
  await openMap(page);
  await sigmaBox(page).hover();
  await press(page, "+", 2);
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "mid", { timeout: 4000 });
  await press(page, "+", 2);
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "near", { timeout: 4000 });
  await press(page, "-", 4);
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "far", { timeout: 4000 });
  await press(page, "+", 2);
  await press(page, "0", 1);
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "far", { timeout: 4000 });
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(320);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "mid", { timeout: 4000 });
  await page.getByRole("button", { name: "Fit" }).click();
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "far", { timeout: 4000 });
});

test("hovering an aggregated arrow shows 'A → B: N imports'", async ({ page }) => {
  await openMap(page);
  const { edges } = await probe(page);
  const box = await origin(page);
  const edge = edges.find((e) => e.weight === 38);
  if (!edge) throw new Error("38-import edge missing");
  // Move off the count pill (drawn at the midpoint) onto the arrow body.
  let found = "";
  // (Boxes are close together, so the arrow body is short: step a little at first, along either axis.)
  for (const [dx, dy] of [
    [-28, 0],
    [28, 0],
    [-22, 0],
    [22, 0],
    [0, -28],
    [0, 28],
    [-60, 0],
    [60, 0],
    [0, -60],
    [0, 60],
  ] as const) {
    await page.mouse.move(box.x + edge.x + dx, box.y + edge.y + dy);
    const tip = page.getByRole("tooltip");
    if (await tip.isVisible()) {
      found = (await tip.textContent()) ?? "";
      if (found.includes("→")) break;
    }
  }
  expect(found).toContain("@acme/web → @acme/ui: 38 imports");
});

test("the layout is deterministic: same positions after reload and re-layout", async ({ page }) => {
  await openMap(page);
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 20_000 });
  const first = (await probe(page)).hash;
  await page.reload();
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 20_000 });
  expect((await probe(page)).hash).toBe(first);
  await page.getByRole("button", { name: "Re-layout" }).click();
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible();
  expect((await probe(page)).hash).toBe(first);
});

test("the project map at workspace level draws one box per workspace", async ({ page }) => {
  await openMap(page, "#/project-map?level=workspaces");
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "far");
  const { regions } = await probe(page);
  expect(regions.filter((r) => r.id.startsWith("ws:"))).toHaveLength(5);
  await page.screenshot({ path: resolve(shots, "canvas-workspaces.png") });
});

test("List and Graph toggle swaps renderers", async ({ page }) => {
  await openMap(page);
  await page.getByRole("button", { name: "List" }).click();
  await expect(page.getByRole("listbox", { name: "Graph nodes" })).toBeVisible();
  await page.getByRole("button", { name: "Graph" }).click();
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 20_000 });
});

test("a flat graph (no parents) uses the hinted force layout", async ({ page }) => {
  await openMap(page, "#/flat");
  await expect(canvas(page).locator(".gc-status")).toContainText("force");
  await expect(sigmaBox(page)).toHaveAttribute("data-level", "near");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(shots, "canvas-flat.png") });
});

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });
  test("far zoom stays legible in the dark theme", async ({ page }) => {
    await openMap(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(shots, "canvas-far-dark.png") });
  });
});
