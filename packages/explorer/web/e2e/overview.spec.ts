import { expect, test } from "playwright/test";

// Runs against the in-repo mock API (mock/fixture.ts): synthetic overviews, no model, no private data.
test("a workspace shows its cached overview as plain text, a workspace without one shows the hint", async ({
  page,
}) => {
  await page.goto("/#/project-map?sel=ws%3A%40acme%2Futils");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const overview = inspector.getByRole("region", { name: "Overview" });
  await expect(overview.getByText("Overview — generated, may be wrong")).toBeVisible();
  await expect(overview).toContainText("formatRelativeDate in src/date.ts");

  await page.goto("/#/project-map?sel=ws%3A%40acme%2Fapi");
  await expect(overview.getByText("No overview yet.")).toBeVisible();
  await expect(overview.locator("code")).toHaveText("/gantry:overview ws:@acme/api");
});

test("overview text is never parsed as HTML", async ({ page }) => {
  await page.goto("/#/project-map?sel=ws%3A%40acme%2Fdb");
  const overview = page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("region", { name: "Overview" });
  await expect(overview.getByText("Overview — generated, may be wrong")).toBeVisible();
  await expect(overview.locator(".description-text")).toContainText(
    '<img src=x onerror="window.__overviewXss=1">',
  );
  await expect(overview.locator("img, b")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __overviewXss?: number }).__overviewXss),
  ).toBeUndefined();
});
