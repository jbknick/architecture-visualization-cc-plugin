import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";
import { ids } from "../mock/fixture.ts";
import { hubFocus } from "../mock/hubEgo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// The ego view's bow-tie on the mock API: the fixture-sized Button graph, and the synthetic "hub" scenario
// (`scenario=hub`, mock-only): one shared component with 221 callers in three workspaces and one callee.
test.use({ viewport: { width: 1440, height: 900 } });

const canvas = (page: Page) => page.getByTestId("graph-canvas");
const hubUrl = (extra = "") => `/#/ego?focus=${encodeURIComponent(hubFocus)}&scenario=hub${extra}`;

interface Label {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Probe {
  k: number;
  labels: Label[];
}

async function probe(page: Page): Promise<Probe> {
  await page.waitForTimeout(150);
  return JSON.parse(
    await canvas(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as Probe;
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(canvas(page).locator("canvas[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(500);
}

function overlaps(a: Label, b: Label): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("hub, grouped (light)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, hubUrl());
  const p = await probe(page);
  // The focus and every group have a readable label, and no two labels overlap.
  expect(p.labels.find((l) => l.id === hubFocus)?.text).toBe("DataTable");
  const groups = p.labels.filter((l) => l.id.startsWith("group:"));
  expect(groups.length).toBeGreaterThanOrEqual(10);
  expect(groups.every((g) => g.text.length > 3)).toBe(true);
  for (let i = 0; i < p.labels.length; i++)
    for (let j = i + 1; j < p.labels.length; j++)
      expect(
        overlaps(p.labels[i] as Label, p.labels[j] as Label),
        `${p.labels[i]?.text} / ${p.labels[j]?.text}`,
      ).toBe(false);
  // Callers are on the left of the focus, the callee on the right.
  const left = (id: string) => p.labels.find((l) => l.id === id)?.x ?? Number.NaN;
  const focusX = left(hubFocus);
  expect(groups.every((g) => g.x < focusX)).toBe(true);
  await expect(page.getByText(/221 callers in 3 workspaces · \d+ files/)).toBeVisible();
  await expect(page.getByText("1 callee", { exact: true })).toBeVisible();
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "ego-hub-grouped.png") });
});

test("hub, one group expanded by clicking it (light)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, hubUrl());
  const p = await probe(page);
  const target = p.labels.find((l) => l.id === "group:in:1:file:apps/web/src/routes/orders/OrdersPage.tsx");
  expect(target).toBeTruthy();
  const box = (await canvas(page).locator("canvas").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + (target as Label).x + 40, box.y + (target as Label).y + 6);
  // The group is linkable: the hash route carries it.
  await expect(page).toHaveURL(
    /expand=group%3Ain%3A1%3Afile%3Aapps%2Fweb%2Fsrc%2Froutes%2Forders%2FOrdersPage\.tsx/,
  );
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("Members");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(shots, "ego-hub-expanded.png") });

  // Reloading keeps it open; Collapse all closes it.
  await page.reload();
  await expect(canvas(page).locator("canvas[data-ready=true]")).toBeVisible();
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(page).not.toHaveURL(/expand=/);
});

test("hub, grouped (dark)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, hubUrl());
  await page.screenshot({ path: resolve(shots, "ego-hub-dark.png") });
});

test("small graph, nothing grouped (light)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, `/#/ego?focus=${encodeURIComponent(ids.button)}`);
  const p = await probe(page);
  expect(p.labels.some((l) => l.id.startsWith("group:"))).toBe(false);
  const focus = p.labels.find((l) => l.id === ids.button);
  expect(focus?.text).toBe("Button");
  // Every node is labelled, and the callers (the pages that render Button) sit left of the focus.
  const callers = p.labels.filter((l) => l.id !== ids.button && l.x < (focus?.x ?? 0));
  expect(callers.map((l) => l.text).sort()).toEqual(["PostList", "buttonTest"]);
  await page.screenshot({ path: resolve(shots, "ego-small.png") });
});
