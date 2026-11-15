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

test("a 3D map folder id is normalised by the server and its cached overview shows", async ({ page }) => {
  await page.goto("/#/map-3d?level=dirs&sel=dir%3Aws%3A%40acme%2Fdb%3Asrc");
  const overview = page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("region", { name: "Overview" });
  await expect(overview.getByText("Overview — generated, may be wrong")).toBeVisible();
  await expect(overview).toContainText("schema, queries and the client");
});

test("switching to a node without an overview does not keep the previous text", async ({ page }) => {
  await page.goto("/#/project-map?sel=ws%3A%40acme%2Futils");
  const overview = page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("region", { name: "Overview" });
  await expect(overview).toContainText("formatRelativeDate in src/date.ts");
  await page.goto("/#/project-map?sel=ws%3A%40acme%2Fapi");
  await expect(overview.getByText("No overview yet.")).toBeVisible();
  await expect(overview).not.toContainText("formatRelativeDate");
});
