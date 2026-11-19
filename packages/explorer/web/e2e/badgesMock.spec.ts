import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// M2 badges against the in-repo mock API (pnpm-turbo-like data), which includes a description that says
// `formatRelativeDate` is misleading, a case the real fixture has no description for.
test.use({ viewport: { width: 1440, height: 900 } });

test("map tiles show dup, misleading and undescribed marks; the legend names all three", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await page.goto("/#/project-map?level=symbols&focus=ws%3A%40acme%2Futils");
  const canvas = page.getByTestId("graph-canvas");
  await expect(canvas.locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  const probe = JSON.parse(
    await canvas.locator(".gc-sigma").evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as { badged: { id: string; badges: string[] }[] };
  const by = new Map(probe.badged.map((b) => [b.id, b.badges]));
  expect(by.get("sym:pnpm-turbo:packages/utils/src/date.ts#formatRelativeDate")).toEqual([
    "dup",
    "misleading",
  ]);
  expect(by.get("sym:pnpm-turbo:packages/utils/src/slug.ts#slugify")).toEqual(["dup", "undescribed"]);
  expect([...by.values()].some((b) => b.includes("undescribed"))).toBe(true);
  const key = page.getByTestId("badge-key");
  for (const word of ["duplicate", "undescribed", "misleading name"]) {
    await expect(key.getByText(word)).toBeVisible();
  }
  await page.mouse.move(2, 2);
  await page.screenshot({ path: resolve(shots, "badges-project-map-mock.png") });
});
