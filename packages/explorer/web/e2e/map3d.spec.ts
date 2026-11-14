import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// Headless Chromium has no GPU; software GL (SwiftShader) gives the page a WebGL context.
test.use({
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
});

// Runs against the mock API's synthetic map-3d dataset (5 workspaces, 60 files), never real repo data.
test("3D map: islands, labels and bundled arcs on fixture data", async ({ page }) => {
  await page.goto("/#/map-3d?level=files");
  const canvas = page.getByTestId("map3d-canvas");
  await expect(canvas.locator("canvas")).toBeVisible();
  await expect(page.locator(".map3d[data-ready='true']")).toBeVisible();

  // Legend lists every workspace with kind and counts.
  const legend = page.getByRole("button", { name: /^web/ });
  await expect(legend).toContainText("app");
  await expect(page.getByRole("button", { name: /^db/ })).toContainText("package");

  // Freeze the scene (no auto-rotate) and let the camera settle before the screenshot.
  await expect(page.getByLabel(/Auto-rotate/)).not.toBeChecked(); // off by default
  await page.waitForTimeout(2500);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "map-3d.png") });

  // Legend click selects the island (`sel`, not the view's `focus`) and opens the inspector for the workspace.
  await legend.click();
  await expect(page).toHaveURL(/sel=ws%3A%40acme%2Fweb/);
  await expect(page).not.toHaveURL(/focus=/);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();

  // Level switch refetches with the level param.
  const requested = page.waitForRequest(
    (r) => r.url().includes("/api/view/map-3d") && decodeURIComponent(r.url()).includes("level=workspaces"),
  );
  await page.getByLabel("Workspaces").click();
  await expect(page).toHaveURL(/level=workspaces/);
  await requested;
});

// Mock-only "large" scenario shaped like a real monorepo: 3 huge workspaces, 8 tiny ones, long scoped names.
// The hash flag `scenario=large` travels as a filter and is read by the mock API only.
interface Box {
  cls: string;
  text: string;
  island: string | null;
  l: number;
  t: number;
  r: number;
  b: number;
  fs: number;
}

/** Every label that is currently shown, with its on-screen box. */
async function shownLabels(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".m3-label")]
      .filter((e) => e.style.visibility === "visible")
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          cls: e.className,
          text: e.textContent ?? "",
          island: e.getAttribute("data-island"),
          l: r.left,
          t: r.top,
          r: r.right,
          b: r.bottom,
          fs: Number.parseFloat(getComputedStyle(e.querySelector(".m3-name") ?? e).fontSize),
        };
      }),
  );
}

const SHORT_NAMES = [
  "acme-platform-monorepo-root-app",
  "api",
  "config",
  "core",
  "db-client",
  "logger",
  "scripts",
  "testing",
  "types",
  "ui-kit",
  "web",
];
const BIG = [
  "ws:@acme-platform-monorepo/api",
  "ws:@acme-platform-monorepo/web",
  "ws:@acme-platform-monorepo/core",
];
/** Island label boxes per level, to compare the three levels (same camera, same islands). */
const boxesByLevel = new Map<string, Box[]>();

for (const [level, file] of [
  ["workspaces", "map-3d-large-workspaces.png"],
  ["dirs", "map-3d-large-folders.png"],
  ["files", "map-3d-large-files.png"],
] as const) {
  test(`3D map, large scenario, ${level} level (light)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openLarge(page, level);
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: resolve(shots, file) });
    await expect(page.getByRole("button", { name: /^api/ })).toContainText("1,700 fn");

    const boxes = await shownLabels(page);
    // Every island has one attached name + caption block.
    const islands = boxes.filter((b) => b.cls.includes("m3-island"));
    expect(islands.map((b) => b.text.split(/\d/)[0]?.trim()).sort()).toEqual(SHORT_NAMES);
    for (const b of islands) {
      expect(b.fs, b.text).toBeGreaterThanOrEqual(level === "files" ? 9.5 : 12);
      expect(b.text).toMatch(/\d+ functions · [\d,]+ files · (app|package)/);
    }
    const leaders = await page
      .locator(".m3-leader")
      .evaluateAll((els) => els.filter((e) => (e as SVGElement).style.visibility === "visible").length);
    expect(leaders).toBeGreaterThanOrEqual(11); // each island has its tick or leader line
    // No label covers another label.
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const hit = a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;
        expect(hit, `${a.text} / ${b.text}`).toBe(false);
      }
    }
    // Count pills on the heaviest arcs.
    const pills = boxes.filter((b) => b.cls.includes("m3-arc"));
    expect(pills.length).toBeGreaterThanOrEqual(5);
    for (const p of pills) expect(p.text).toMatch(/^[\d,]+$/);
    // The always-visible key.
    const key = page.getByTestId("map3d-key");
    await expect(key).toContainText("Island = workspace (size = functions)");
    await expect(key).toContainText("Arrow A → B = A imports from B (thicker = more imports)");
    await expect(key).toContainText("Tests hidden");

    if (level === "dirs") {
      const dirs = boxes.filter((b) => b.cls.includes("m3-dir"));
      expect(dirs.length).toBeGreaterThanOrEqual(12); // at least 6 on each of the biggest two islands
      for (const d of dirs) {
        expect(d.text).toMatch(/ · [\d,]+ fn$/);
        expect(d.text.startsWith("src/")).toBe(false);
      }
    }
    if (level === "files") {
      const clusters = boxes.filter((b) => b.cls.includes("m3-cluster"));
      expect(clusters.length).toBeGreaterThanOrEqual(5);
      for (const c of clusters) expect(c.text).toMatch(/ · [\d,]+ fn$/);
      expect(boxes.filter((b) => b.cls.includes("m3-file")).length).toBeGreaterThanOrEqual(3);
      // File names beyond the biggest three show on hover.
      await page.getByRole("button", { name: /^api/ }).hover();
      await page.waitForTimeout(600);
      await page.screenshot({ path: resolve(shots, "map-3d-large-files-hover.png") });
    }

    // Same picture at every level: the big islands' blocks sit where they sat at the Workspaces level.
    boxesByLevel.set(level, islands);
    const ws = boxesByLevel.get("workspaces");
    if (ws && level !== "workspaces") {
      for (const isl of ws.filter((b) => BIG.some((id) => b.island === id))) {
        const same = islands.find((b) => b.island === isl.island);
        expect(same, isl.text).toBeDefined();
        expect(Math.abs((same?.l ?? 0) - isl.l), isl.text).toBeLessThan(2);
        expect(Math.abs((same?.t ?? 0) - isl.t), isl.text).toBeLessThan(2);
      }
    }
  });
}

test("3D map, large scenario: the left panel leads with the legend and scrolls to the last workspace", async ({
  page,
}) => {
  await openLarge(page, "dirs");
  const left = page.getByRole("complementary", { name: "Filters" });
  // The 3D legend is right under the level switch; no function-kind legend is shown for this view.
  await expect(left.getByText("How to read it")).toBeVisible();
  await expect(left.getByText("Legend", { exact: true })).toHaveCount(0);
  const order = await left.evaluate((el) => {
    const y = (sel: string) => el.querySelector(sel)?.getBoundingClientRect().top ?? Number.NaN;
    return { levels: y(".map3d-levels"), howto: y(".map3d-howto"), list: y(".map3d-legend") };
  });
  expect(order.levels).toBeLessThan(order.howto);
  expect(order.howto).toBeLessThan(order.list);
  expect(await left.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const last = left.locator(".map3d-legend-row").last();
  await last.scrollIntoViewIfNeeded();
  const [row, panel] = await Promise.all([last.boundingBox(), left.boundingBox()]);
  expect((row?.y ?? 0) + (row?.height ?? 0)).toBeLessThanOrEqual((panel?.y ?? 0) + (panel?.height ?? 0) + 1);
  await expect(last).toBeInViewport();
});

test("3D map, large scenario, folders level (dark), hovering the web island", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openLarge(page, "dirs");
  await page.screenshot({ path: resolve(shots, "map-3d-large-folders-dark.png") });
  // Hovering a legend row highlights its island and reveals its arcs with "A -> B: N imports" labels.
  await page.getByRole("button", { name: /^web/ }).hover();
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(shots, "map-3d-large-hover-dark.png") });
  const boxes = await shownLabels(page);
  expect(boxes.some((b) => /^web → .+: [\d,]+ imports$/.test(b.text))).toBe(true);
});

test("3D map, large scenario: every island is still named in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openLarge(page, "workspaces");
  const boxes = await shownLabels(page);
  expect(boxes.filter((b) => b.cls.includes("m3-island"))).toHaveLength(11);
});

async function openLarge(page: Page, level: string): Promise<void> {
  await page.goto(`/#/map-3d?level=${level}&scenario=large`);
  await expect(page.getByTestId("map3d-canvas").locator("canvas")).toBeVisible();
  await expect(page.locator(".map3d[data-ready='true']")).toBeVisible();
  await page.waitForTimeout(2500);
}
