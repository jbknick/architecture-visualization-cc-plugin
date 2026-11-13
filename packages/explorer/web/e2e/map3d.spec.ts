import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

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
    if (level === "files") {
      // File names show only for the hovered or selected island's biggest files.
      await page.getByRole("button", { name: /^api/ }).hover();
      await page.waitForTimeout(600);
      await page.screenshot({ path: resolve(shots, "map-3d-large-files-hover.png") });
    }
  });
}

test("3D map, large scenario, folders level (dark), hovering the web island", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openLarge(page, "dirs");
  await page.screenshot({ path: resolve(shots, "map-3d-large-folders-dark.png") });
  // Hovering a legend row highlights its island and reveals its arcs with "A -> B: N imports" labels.
  await page.getByRole("button", { name: /^web/ }).hover();
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(shots, "map-3d-large-hover-dark.png") });
});

async function openLarge(page: import("playwright/test").Page, level: string): Promise<void> {
  await page.goto(`/#/map-3d?level=${level}&scenario=large`);
  await expect(page.getByTestId("map3d-canvas").locator("canvas")).toBeVisible();
  await expect(page.locator(".map3d[data-ready='true']")).toBeVisible();
  await page.waitForTimeout(2500);
}
