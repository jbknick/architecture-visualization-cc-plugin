import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// Runs against the in-repo mock API with pnpm-turbo-like data (mock/fixture.ts), not the real server.
test("search Button, open the inspector, deep link survives reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("pnpm-turbo")).toBeVisible();
  await expect(page.getByRole("option", { name: /@acme\/web/ })).toBeVisible();

  const search = page.getByRole("combobox", { name: "Search symbols" });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search).toBeFocused();
  await search.fill("Button");
  await expect(page.getByRole("option", { name: /Button/ })).toBeVisible();
  await page.keyboard.press("Enter");

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "Button" })).toBeVisible();
  await expect(inspector.getByText("Generated description — may be wrong")).toBeVisible();
  await expect(inspector.getByLabel(/Source of/)).toContainText("export function Button");
  await expect(page).toHaveURL(/#\/project-map\?sel=sym%3Apackages%2Fui%2Fsrc%2Fbutton\.tsx%23Button/);

  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "explorer-shell.png") });

  await page.reload();
  await expect(inspector.getByRole("heading", { name: "Button" })).toBeVisible();
});
