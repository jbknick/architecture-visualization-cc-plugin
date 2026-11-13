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
  const legend = page.getByRole("button", { name: /@acme\/web/ });
  await expect(legend).toContainText("app");
  await expect(page.getByRole("button", { name: /@acme\/db/ })).toContainText("package");

  // Freeze the scene (no auto-rotate) and let the camera settle before the screenshot.
  await page.getByLabel(/Auto-rotate/).uncheck();
  await page.waitForTimeout(2500);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "map-3d.png") });

  // Legend click focuses an island and opens the inspector for the workspace.
  await legend.click();
  await expect(page).toHaveURL(/focus=ws%3A%40acme%2Fweb/);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();

  // Level switch refetches with the level param.
  const requested = page.waitForRequest(
    (r) => r.url().includes("/api/view/map-3d") && decodeURIComponent(r.url()).includes("level=workspaces"),
  );
  await page.getByLabel("Workspaces").click();
  await expect(page).toHaveURL(/level=workspaces/);
  await requested;
});
