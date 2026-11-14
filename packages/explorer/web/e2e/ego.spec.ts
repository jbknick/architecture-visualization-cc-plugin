import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";
import { ids } from "../mock/fixture.ts";
import { hubFocus, thinFocus } from "../mock/hubEgo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// The ego view's bow-tie on the mock API: the fixture-sized Button graph, and two synthetic scenarios (mock-only):
// `scenario=hub`, one shared component with 221 callers concentrated in a few big folders, and `scenario=hub-thin`,
// the same 221 callers spread thinly (201 in one workspace over 104 files in 30 folders, 20 in another over 16
// files). The thin one is the shape of a real monorepo, where a first version drew one column of 151 slivers.
test.use({ viewport: { width: 1440, height: 900 } });

const canvas = (page: Page) => page.getByTestId("graph-canvas");
const hubUrl = (extra = "") => `/#/ego?focus=${encodeURIComponent(hubFocus)}&scenario=hub${extra}`;
const thinUrl = (extra = "") => `/#/ego?focus=${encodeURIComponent(thinFocus)}&scenario=hub-thin${extra}`;

interface Label {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Rect {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Probe {
  k: number;
  labels: Label[];
  rects: Rect[];
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
  await page.waitForTimeout(700);
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Rows and labels of the caller side (left of the focus), checked the way a reader would. */
function expectReadable(p: Probe, focusId: string) {
  const focus = p.rects.find((r) => r.id === focusId) as Rect;
  expect(focus).toBeTruthy();
  const callerRows = p.rects.filter((r) => r.id !== focusId && r.x + r.w <= focus.x + 1);
  // Every row is at least 18px tall, no two row labels overlap.
  for (const r of p.rects)
    if (r.type !== "focus") expect(r.h, `${r.id} is ${r.h}px`).toBeGreaterThanOrEqual(18);
  for (let i = 0; i < p.labels.length; i++)
    for (let j = i + 1; j < p.labels.length; j++)
      expect(
        overlaps(p.labels[i] as Label, p.labels[j] as Label),
        `${p.labels[i]?.text} / ${p.labels[j]?.text}`,
      ).toBe(false);
  // The focus card is vertically centred in the canvas area (below the 72px title band).
  const mid = focus.y + focus.h / 2;
  expect(mid).toBeGreaterThan(300);
  expect(mid).toBeLessThan(560);
  return callerRows;
}

test("hub, grouped (light)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, hubUrl());
  const p = await probe(page);
  expect(p.labels.find((l) => l.id === hubFocus)?.text).toBe("DataTable");
  const groups = p.labels.filter((l) => l.id.startsWith("group:"));
  expect(groups.length).toBeGreaterThanOrEqual(8);
  expect(groups.length).toBeLessThanOrEqual(24);
  expect(groups.every((g) => /\d+ (other )?callers/.test(g.text) && !g.text.includes("…"))).toBe(true);
  const rows = expectReadable(p, hubFocus);
  expect(rows.every((r) => r.h >= 26)).toBe(true);
  // Callers are on the left of the focus, the callee on the right.
  const focusX = p.labels.find((l) => l.id === hubFocus)?.x ?? Number.NaN;
  expect(groups.every((g) => g.x < focusX)).toBe(true);
  await expect(page.getByText(/221 callers in 3 workspaces · \d+ files/)).toBeVisible();
  await expect(page.getByText("1 callee", { exact: true })).toBeVisible();
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "ego-hub-grouped.png") });
});

test("hub-thin: 221 thinly spread callers stay within the row budget and readable", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, thinUrl());
  const p = await probe(page);
  const asked = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name));
  const view = asked.filter((u) => u.includes("/api/view/ego")).at(-1) ?? "";
  const maxRows = Number(JSON.parse(new URL(view).searchParams.get("filters") ?? "{}").maxRows);
  expect(maxRows).toBeGreaterThanOrEqual(8);
  expect(maxRows).toBeLessThanOrEqual(24);
  const rows = expectReadable(p, thinFocus);
  // Caller side: at most maxRows rows, every one a group with a count in its words, none cut short.
  expect(rows.length).toBeGreaterThanOrEqual(8);
  expect(rows.length).toBeLessThanOrEqual(maxRows);
  expect(rows.every((r) => r.type === "group")).toBe(true);
  const groupLabels = p.labels.filter((l) => l.id.startsWith("group:"));
  expect(groupLabels).toHaveLength(rows.length);
  expect(groupLabels.every((g) => /\d+ (other )?callers/.test(g.text) && !g.text.includes("…"))).toBe(true);
  // One column, rows at least 26px at the fit zoom.
  expect(new Set(rows.map((r) => r.x)).size).toBe(1);
  expect(rows.every((r) => r.h >= 26)).toBe(true);
  await expect(page.getByText(/221 callers in 2 workspaces · \d+ files/)).toBeVisible();
  await page.screenshot({ path: resolve(shots, "ego-hub-thin-grouped.png") });
});

test("hub-thin: expanding the largest group adds at most 15 rows and keeps every row readable", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, thinUrl());
  const before = await probe(page);
  const focus = before.rects.find((r) => r.id === thinFocus) as Rect;
  const groups = before.rects.filter((r) => r.id.startsWith("group:") && r.x < focus.x);
  // The largest group is the one with the biggest count in its label.
  const count = (id: string) =>
    Number(/— (\d+) callers/.exec(before.labels.find((l) => l.id === id)?.text ?? "")?.[1]);
  const largest = [...groups].sort((a, b) => count(b.id) - count(a.id))[0] as Rect;
  const box = (await canvas(page).locator("canvas").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + largest.x + 30, box.y + largest.y + largest.h / 2);
  await expect(page).toHaveURL(/expand=group%3Ain%3A1%3A/);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1200);
  const after = await probe(page);
  const rowsBefore = before.rects.filter((r) => r.id !== thinFocus && r.x < focus.x).length;
  const f2 = after.rects.find((r) => r.id === thinFocus) as Rect;
  const rowsAfter = after.rects.filter((r) => r.id !== thinFocus && r.x < f2.x).length;
  expect(rowsAfter - rowsBefore).toBeGreaterThan(0);
  expect(rowsAfter - rowsBefore).toBeLessThanOrEqual(15);
  for (const r of after.rects) if (r.type !== "focus") expect(r.h, `${r.id}`).toBeGreaterThanOrEqual(18);
  for (let i = 0; i < after.labels.length; i++)
    for (let j = i + 1; j < after.labels.length; j++)
      expect(overlaps(after.labels[i] as Label, after.labels[j] as Label)).toBe(false);
  // The header became a block of its own, with its children under it.
  expect(after.rects.some((r) => r.type === "head")).toBe(true);
  // Clearing the selection closes the inspector; the block stays open and the canvas gets its width back.
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  const wide = await probe(page);
  for (const r of wide.rects) if (r.type !== "focus") expect(r.h, `${r.id}`).toBeGreaterThanOrEqual(18);
  await page.screenshot({ path: resolve(shots, "ego-hub-thin-expanded.png") });
});

test("hub, one group expanded by clicking it (light)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, hubUrl());
  const p = await probe(page);
  const target = p.labels.find((l) => l.id.startsWith("group:in:1:") && l.text.includes("callers"));
  expect(target).toBeTruthy();
  const box = (await canvas(page).locator("canvas").boundingBox()) as { x: number; y: number };
  await page.mouse.click(box.x + (target as Label).x + 40, box.y + (target as Label).y + 6);
  // The group is linkable: the hash route carries it.
  await expect(page).toHaveURL(/expand=group%3Ain%3A1%3A/);
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
