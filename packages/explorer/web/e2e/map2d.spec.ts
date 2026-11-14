import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// The 2D project map on the mock API's synthetic "large" scenario (`scenario=large`, mock-only): 11 workspaces,
// three big (1,700 / 980 / 960 functions) and eight tiny, long scoped names, ~880 files, ~3,700 functions.
test.use({ viewport: { width: 1440, height: 900 } });

const canvas = (page: Page) => page.getByTestId("graph-canvas");
const surface = (page: Page) => canvas(page).locator(".gc-sigma");

interface Probe {
  scale: number;
  fitScale: number;
  hiddenTitles: string[];
  titles: Record<string, "inside" | "beside" | "hidden">;
  titleTexts: Record<string, string>;
  pills: { key: string; count: string; text: string }[];
  markers: { rank: number; id: string; x: number; y: number; r: number }[];
  crumb: string[] | null;
  regions: { id: string; x: number; y: number; w: number; h: number }[];
  edges: {
    key: string;
    x: number;
    y: number;
    weight: number;
    route: [number, number][];
    width: number;
    colour: string;
  }[];
}

async function probe(page: Page): Promise<Probe> {
  await page.waitForTimeout(150);
  return JSON.parse(
    await surface(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as Probe;
}

async function openLarge(page: Page, level: string, extra = "") {
  await page.goto(`/#/project-map?level=${level}&scenario=large${extra}`);
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  // The layout/timing chip is debug text: not shown to users.
  await expect(canvas(page).locator(".gc-status")).toHaveCount(0);
  // Folders level: the faint file mosaic arrives in the background and the map is laid out again.
  if (level === "dirs") await expect(canvas(page).locator(".gc-sigma[data-mosaic=true]")).toBeVisible();
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
}

for (const [level, name] of [
  ["workspaces", "workspaces"],
  ["dirs", "folders"],
  ["files", "files"],
  ["symbols", "functions"],
] as const) {
  test(`large scenario, ${name} level (light)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openLarge(page, level);
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: resolve(shots, `map-2d-large-${name}.png`) });
  });
}

test("large scenario, folders level (dark)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openLarge(page, "dirs");
  await page.screenshot({ path: resolve(shots, "map-2d-large-dark.png") });
});

test("large scenario, files level (dark)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openLarge(page, "files");
  await page.screenshot({ path: resolve(shots, "map-2d-large-files-dark.png") });
});

test("large scenario, files level: 'Largest files' lists 15 files and the canvas numbers them the same way", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openLarge(page, "files");
  const list = page.getByTestId("largest-files");
  const rows = list.locator(".largest-row");
  await expect(rows).toHaveCount(15);
  const listed = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.file ?? ""));
  const counts = await rows.evaluateAll((els) =>
    els.map((e) => Number((e.querySelector(".largest-count")?.textContent ?? "").replace(/\D/g, ""))),
  );
  // Sorted by function count; the second line names the workspace and the folder.
  for (let i = 1; i < counts.length; i++) expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i] as number);
  await expect(rows.first().locator(".largest-where")).toContainText("›");
  // The canvas has one marker per row, numbered like the list, all on screen and apart from each other.
  const { markers } = await probe(page);
  expect(markers).toHaveLength(15);
  expect(markers.map((m) => m.id)).toEqual(listed);
  expect(markers.map((m) => m.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  const box = await surface(page).boundingBox();
  if (!box) throw new Error("no canvas");
  for (const [i, m] of markers.entries()) {
    expect(m.r * 2).toBeGreaterThanOrEqual(16);
    expect(m.x).toBeGreaterThan(m.r);
    expect(m.y).toBeGreaterThan(m.r);
    expect(m.x).toBeLessThan(box.width - m.r);
    expect(m.y).toBeLessThan(box.height - m.r);
    for (const o of markers.slice(i + 1))
      expect(Math.hypot(m.x - o.x, m.y - o.y)).toBeGreaterThanOrEqual(2 * m.r);
  }
  await expect(canvas(page).getByTestId("map-key")).toContainText(
    "Numbers = largest files, listed on the left",
  );
  // Hovering a marker shows the tooltip with name, counts and path.
  const m3 = markers[2] as (typeof markers)[number];
  await page.mouse.move(box.x + m3.x - 3, box.y + m3.y - 3);
  await page.mouse.move(box.x + m3.x, box.y + m3.y, { steps: 3 });
  const tip = canvas(page).getByRole("tooltip");
  await expect(tip).toContainText(/file · [\d,]+ functions/);
  await expect(tip).toContainText((await rows.nth(2).getAttribute("title")) ?? "");
  // Clicking a row selects the file (inspector) and zooms to it.
  const before = (await probe(page)).scale;
  await rows.nth(0).click();
  await expect(page).toHaveURL(/sel=file/);
  await page.waitForTimeout(1200);
  expect((await probe(page)).scale).toBeGreaterThan(before * 2);
});

test("large scenario, files level: 'Top files in' restricts the ranking to one workspace", async ({
  page,
}) => {
  await openLarge(page, "files");
  const list = page.getByTestId("largest-files");
  await list.getByLabel("Top files in").selectOption({ label: "web" });
  const rows = list.locator(".largest-row");
  await expect(rows).toHaveCount(15);
  const where = await rows.locator(".largest-where").allTextContents();
  for (const w of where) expect(w.trim().startsWith("web")).toBe(true);
  const { markers } = await probe(page);
  expect(markers.map((m) => m.id)).toEqual(
    await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.file ?? "")),
  );
});

/** Zooms the camera to a node by id (the canvas listens for `gantry:zoom-to`) and waits for the animation. */
async function zoomTo(page: Page, id: string) {
  await canvas(page).evaluate((el, nodeId) => {
    el.dispatchEvent(new CustomEvent("gantry:zoom-to", { detail: { id: nodeId } }));
  }, id);
  await page.waitForTimeout(900);
  await page.mouse.move(2, 2);
}

for (const scheme of ["light", "dark"] as const) {
  test(`large scenario, files level zoomed in (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openLarge(page, "files");
    // Into the biggest workspace, then one zoom step further: file names are readable, headers stay slim.
    await zoomTo(page, "ws:@acme-platform-monorepo/api");
    const { regions } = await probe(page);
    const api = regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
    const box = await surface(page).boundingBox();
    if (!api || !box) throw new Error("api box missing");
    // Wheel about the top-left corner of the box, so its title and the first folder strips stay in view.
    await page.mouse.move(box.x + api.x + 10, box.y + api.y + 10);
    await page.mouse.wheel(0, -420);
    await page.waitForTimeout(500);
    // Pan down into the folder: the workspace title scrolls out of view, folder strips stick to the top, and the
    // breadcrumb says where the canvas centre is.
    await page.mouse.move(box.x + 700, box.y + 520);
    await page.mouse.down();
    await page.mouse.move(box.x + 560, box.y + 250, { steps: 10 });
    await page.mouse.up();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
    await expect(canvas(page).getByTestId("map-crumb")).toBeVisible();
    await page.screenshot({
      path: resolve(shots, `map-2d-large-zoomed${scheme === "dark" ? "-dark" : ""}.png`),
    });
  });
}

test("large scenario, workspace selected", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openLarge(page, "dirs");
  // The inspector opens beside the canvas on selection; fold the filters away so the map keeps its room.
  await page.getByRole("button", { name: "Collapse filters" }).click();
  await page.waitForTimeout(900);
  const { regions } = await probe(page);
  const api = regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
  if (!api) throw new Error("api box missing");
  const box = await surface(page).boundingBox();
  if (!box) throw new Error("no canvas");
  // Click the title strip of the box (no cell there), so the workspace itself is selected.
  await page.mouse.click(box.x + api.x + 30, box.y + api.y + 10);
  await expect(page).toHaveURL(/sel=ws%3A%40acme-platform-monorepo%2Fapi/);
  await page.mouse.move(box.x + 4, box.y + box.height - 4);
  await page.waitForTimeout(2200); // the canvas was resized twice and laid out again each time
  await page.screenshot({ path: resolve(shots, "map-2d-large-selected.png") });
});

test("large scenario: the whole diagram fits the canvas and every workspace title is inside its box", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const level of ["workspaces", "dirs", "files", "symbols"]) {
    await openLarge(page, level);
    const box = await surface(page).boundingBox();
    if (!box) throw new Error("no canvas");
    const p = await probe(page);
    expect(p.regions).toHaveLength(11);
    for (const r of p.regions) {
      expect(r.x, `${level} ${r.id}`).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(48 - 1); // below the strip with the controls
      expect(r.x + r.w).toBeLessThanOrEqual(box.width);
      expect(r.y + r.h).toBeLessThanOrEqual(box.height - 52 + 1); // above the key
    }
    // Every title sits inside its box (a title that did not fit would be beside it or hidden).
    expect(Object.values(p.titles), level).toHaveLength(11);
    expect(
      Object.entries(p.titles).filter(([, where]) => where !== "inside"),
      level,
    ).toEqual([]);
    expect(p.hiddenTitles, level).toEqual([]);
    // The repo-root workspace (id `ws:.`, a 31-character unscoped name) always shows a title, at every level.
    expect(p.titles["ws:."], level).not.toBe("hidden");
    expect(p.titleTexts["ws:."], level).toMatch(
      /\(repo root\)|acme-platform-monorepo-root-app|acme-platform/,
    );
    expect(p.scale).toBeCloseTo(p.fitScale, 5);
  }
});

test("large scenario: the diagram fills the canvas and the biggest workspace is big", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const level of ["workspaces", "dirs", "symbols"]) {
    await openLarge(page, level);
    const box = await surface(page).boundingBox();
    if (!box) throw new Error("no canvas");
    const { regions } = await probe(page);
    const x0 = Math.min(...regions.map((r) => r.x));
    const x1 = Math.max(...regions.map((r) => r.x + r.w));
    const y0 = Math.min(...regions.map((r) => r.y));
    const y1 = Math.max(...regions.map((r) => r.y + r.h));
    const wide = (x1 - x0) / box.width;
    const tall = (y1 - y0) / box.height;
    expect(Math.max(wide, tall), `${level}: ${wide.toFixed(2)} x ${tall.toFixed(2)}`).toBeGreaterThanOrEqual(
      0.85,
    );
    expect(wide * tall, level).toBeGreaterThanOrEqual(0.6);
    const biggest = Math.max(...regions.map((r) => r.w));
    expect(biggest / box.width, level).toBeGreaterThanOrEqual(0.22);
  }
});

test("large scenario: hovering a workspace row outlines its box, clicking the row selects it", async ({
  page,
}) => {
  await openLarge(page, "dirs");
  const row = page.getByRole("checkbox", { name: /^core/ }).locator("xpath=ancestor::label");
  await row.hover();
  await page.waitForTimeout(250);
  const hovered = JSON.parse(
    await surface(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as { panelHover?: string };
  expect(hovered.panelHover).toBe("ws:@acme-platform-monorepo/core");
  await row.locator(".check-label").click();
  await expect(page).toHaveURL(/sel=ws%3A%40acme-platform-monorepo%2Fcore/);
  // The checkbox itself still toggles visibility and is left alone by the row click.
  await expect(page.getByRole("checkbox", { name: /^core/ })).toBeChecked();
});

test("large scenario: declared-only dependencies are hidden until the toggle is on", async ({ page }) => {
  await openLarge(page, "dirs");
  const before = (await probe(page)).edges.length;
  expect(before).toBe(23); // the real import links only (api -> core and back are two arrows)
  await page.getByLabel("Show declared dependencies").check();
  await page.waitForTimeout(300);
  const after = (await probe(page)).edges.length;
  expect(after).toBe(54); // plus the 31 declared-only ones
  await page.getByLabel("Show declared dependencies").uncheck();
});

test("large scenario: hover shows a tooltip, click selects a cell, double-click drills into a workspace", async ({
  page,
}) => {
  await openLarge(page, "files");
  const box = await surface(page).boundingBox();
  if (!box) throw new Error("no canvas");
  const { regions } = await probe(page);
  const api = regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
  if (!api) throw new Error("api box missing");
  // A point inside the treemap part of the box (below the title strip).
  const x = box.x + api.x + api.w / 2;
  const y = box.y + api.y + api.h - 12;
  await page.mouse.move(x, y);
  await expect(page.getByRole("tooltip")).toContainText(/functions|src/);
  await page.mouse.click(x, y);
  await expect(page).toHaveURL(/sel=(dir|file)%3Aapps%2Fapi/);
  // The inspector opened, so the canvas was resized and laid out again: find the box again.
  await page.waitForTimeout(900);
  const moved = (await probe(page)).regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
  if (!moved) throw new Error("api box missing after resize");
  await page.mouse.dblclick(box.x + moved.x + 14, box.y + moved.y + 8);
  await expect(page).toHaveURL(/focus=ws%3A%40acme-platform-monorepo%2Fapi/);
  // Drilling in shows that workspace alone, fitted.
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible();
  await expect.poll(async () => (await probe(page)).regions.length).toBe(1);
});

test("large scenario: every count pill shows the import weight of its pair, never the sum with a declared dependency", async ({
  page,
}) => {
  const { projectMapLarge } = await import("../mock/largeMap.ts");
  const view = projectMapLarge({ focus: null, level: "workspaces", options: {} });
  if ("error" in view) throw new Error(view.error);
  const imports = new Map(
    view.edges.filter((e) => e.kind === "imports").map((e) => [`${e.src}>${e.dst}`, e.weight]),
  );
  // The mock has pairs with an imports edge and a depends_on edge side by side (the case that showed N + 1).
  const both = view.edges.filter((e) => e.kind === "depends_on" && imports.has(`${e.src}>${e.dst}`));
  expect(both.length).toBeGreaterThan(0);

  await openLarge(page, "dirs");
  await page.getByLabel("Show declared dependencies").check();
  await page.waitForTimeout(300);
  const check = async (label: string) => {
    const p = await probe(page);
    expect(p.pills.length, label).toBeGreaterThan(0);
    for (const pill of p.pills) {
      const expected = imports.get(pill.key);
      if (pill.count === "declared") {
        expect(expected, `${label}: ${pill.key} is declared only, so it has no number`).toBeUndefined();
        continue;
      }
      expect(expected, `${label}: ${pill.key} has an imports edge`).toBeDefined();
      expect(Number(pill.count.replace(/,/g, "")), `${label}: ${pill.key}`).toBe(expected);
    }
    for (const e of p.edges) {
      const expected = imports.get(e.key);
      if (expected !== undefined) expect(e.weight, `${label}: arrow ${e.key}`).toBe(expected);
    }
  };
  await check("overview");
  // Hovering a workspace row shows all of its links with a pill each.
  await page.getByRole("checkbox", { name: /^core/ }).locator("xpath=ancestor::label").hover();
  await page.waitForTimeout(300);
  await check("core highlighted");
  await page.getByLabel("Show declared dependencies").uncheck();
});

test("large scenario: the key says what boxes, arrows and numbers mean, and can be collapsed", async ({
  page,
}) => {
  await openLarge(page, "workspaces");
  const key = canvas(page).getByTestId("map-key");
  await expect(key).toBeVisible();
  await expect(key).toContainText("Box = workspace (area = functions)");
  await expect(key).toContainText("Line colour = importing workspace");
  await expect(key).toContainText("A imports from B");
  await expect(key).toContainText("Number = files importing · thicker = more");
  await expect(key).toContainText("Tests hidden");
  await expect(key).not.toContainText("Tiles = folders / files");
  // At most two lines of text, in the bottom-left corner.
  const lines = await key.locator(".gc-key-body > div").count();
  expect(lines).toBeLessThanOrEqual(2);
  const kb = await key.boundingBox();
  const sb = await surface(page).boundingBox();
  if (!kb || !sb) throw new Error("no key or canvas");
  expect(kb.x - sb.x).toBeLessThan(20);
  expect(sb.y + sb.height - (kb.y + kb.height)).toBeLessThan(20);
  expect(kb.height).toBeLessThan(48);
  await page.getByLabel("Hide tests").click();
  await expect(key).not.toContainText("Tests hidden");
  await page.getByLabel("Hide tests").click();
  await expect(key).toContainText("Tests hidden");
  await page.getByRole("radio", { name: "Folders" }).click();
  await expect(key).toContainText("Tiles = folders / files (area = functions)");
  await key.getByRole("button", { name: /Key/ }).click();
  await expect(key.locator(".gc-key-body")).toHaveCount(0);
  await key.getByRole("button", { name: /Key/ }).click();
  await expect(key.locator(".gc-key-body")).toHaveCount(1);
});

test("large scenario: lines are coloured by the importing workspace, pills keep off the key, and the key folds away when zoomed in", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openLarge(page, "workspaces");
  const p = await probe(page);
  const bySource = new Map<string, Set<string>>();
  for (const e of p.edges) {
    const src = e.key.split(">")[0] as string;
    bySource.set(src, (bySource.get(src) ?? new Set()).add(e.colour));
  }
  // "All blue lines leave web": one colour per importer, a different colour for each importer.
  for (const [src, set] of bySource) expect(set.size, src).toBe(1);
  expect(new Set([...bySource.values()].map((s) => [...s][0])).size).toBe(bySource.size);
  expect(bySource.size).toBeGreaterThanOrEqual(8);
  // No pill sits on the key.
  const kb = await canvas(page).getByTestId("map-key").boundingBox();
  const sb = await surface(page).boundingBox();
  if (!kb || !sb) throw new Error("no key or canvas");
  for (const pill of p.pills as unknown as { key: string; x: number; y: number; w: number; h: number }[]) {
    const kx = kb.x - sb.x;
    const ky = kb.y - sb.y;
    expect(
      pill.x < kx + kb.width && kx < pill.x + pill.w && pill.y < ky + kb.height && ky < pill.y + pill.h,
      `${pill.key} on the key`,
    ).toBe(false);
  }
  // Zoomed in past the fit the key folds itself to "Key ▸" (so it never covers tile labels) and opens again on click.
  const key = canvas(page).getByTestId("map-key");
  await expect(key.locator(".gc-key-body")).toHaveCount(1);
  await zoomTo(page, "ws:@acme-platform-monorepo/api");
  await expect(key.locator(".gc-key-body")).toHaveCount(0);
  expect((await key.boundingBox())?.height).toBeLessThan(30);
  await key.getByRole("button", { name: /Key/ }).click();
  await expect(key.locator(".gc-key-body")).toHaveCount(1);
});

test("large scenario: every arrow has its own count pill, opposite arrows run in separate lanes, no link crosses a box", async ({
  page,
}) => {
  await openLarge(page, "workspaces");
  const p = await probe(page);
  expect(p.edges).toHaveLength(23);
  // One pill per arrow, none overlapping another or a box.
  expect(p.pills).toHaveLength(23);
  for (const e of p.edges)
    expect(
      p.pills.some((x) => x.key === e.key),
      e.key,
    ).toBe(true);
  const hit = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const rects = p.pills as unknown as { key: string; x: number; y: number; w: number; h: number }[];
  for (let i = 0; i < rects.length; i++) {
    for (const r of p.regions) expect(hit(rects[i] as (typeof rects)[number], r), rects[i]?.key).toBe(false);
    for (let j = i + 1; j < rects.length; j++)
      expect(hit(rects[i] as (typeof rects)[number], rects[j] as (typeof rects)[number])).toBe(false);
  }
  // The two directions of api <-> core are two lanes at least 10px apart, each with its own pill and arrowhead.
  const id = (n: string) => `ws:@acme-platform-monorepo/${n}`;
  const fwd = p.edges.find((e) => e.key === `${id("api")}>${id("core")}`);
  const back = p.edges.find((e) => e.key === `${id("core")}>${id("api")}`);
  if (!fwd || !back) throw new Error("api <-> core arrows missing");
  const dist = (x: number, y: number, pts: [number, number][]) => {
    let best = Number.POSITIVE_INFINITY;
    for (let k = 1; k < pts.length; k++) {
      const [x0, y0] = pts[k - 1] as [number, number];
      const [x1, y1] = pts[k] as [number, number];
      const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
      const t =
        len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      best = Math.min(best, Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0))));
    }
    return best;
  };
  for (const [x, y] of fwd.route) expect(dist(x, y, back.route)).toBeGreaterThanOrEqual(9.5);
  expect(fwd.route.at(-1)).not.toEqual(back.route.at(-1));
  // No link segment enters the interior of a workspace box other than its source and target, at any level.
  for (const level of ["workspaces", "dirs", "files"]) {
    await openLarge(page, level);
    const q = await probe(page);
    for (const e of q.edges) {
      const [from, to] = e.key.split(">") as [string, string];
      for (const r of q.regions) {
        if (r.id === from || r.id === to) continue;
        for (let k = 1; k < e.route.length; k++) {
          const [x0, y0] = e.route[k - 1] as [number, number];
          const [x1, y1] = e.route[k] as [number, number];
          const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
          const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
          // Segments are axis-aligned: the interior test is a rectangle overlap.
          const inside = lo.x < r.x + r.w - 1 && hi.x > r.x + 1 && lo.y < r.y + r.h - 1 && hi.y > r.y + 1;
          expect(inside, `${level}: ${e.key} through ${r.id}`).toBe(false);
        }
      }
    }
  }
});

test("large scenario: zoomed in, a breadcrumb names the workspace and folder, and the left panel says so", async ({
  page,
}) => {
  await openLarge(page, "files");
  await expect(canvas(page).getByTestId("map-crumb")).toHaveCount(0);
  await expect(page.getByText("Showing the whole repo.")).toBeVisible();
  await zoomTo(page, "dir:apps/api/src/routes");
  const crumb = canvas(page).getByTestId("map-crumb");
  await expect(crumb).toBeVisible();
  await expect(crumb).toContainText("api");
  await expect(crumb).toContainText("routes");
  await expect(page.getByText(/Zoomed into api › routes/)).toBeVisible();
  // Clicking a crumb zooms to that box: the workspace crumb shows the whole workspace again.
  const before = (await probe(page)).scale;
  await crumb.getByRole("button", { name: "api" }).click();
  await page.waitForTimeout(900);
  expect((await probe(page)).scale).toBeLessThan(before);
  // Fit goes back to the whole repo.
  await page.getByRole("button", { name: "Fit" }).click();
  await page.waitForTimeout(700);
  await expect(canvas(page).getByTestId("map-crumb")).toHaveCount(0);
  await expect(page.getByText("Showing the whole repo.")).toBeVisible();
});

test("large scenario: the controls have an opaque background and tiny workspaces show title and counts only", async ({
  page,
}) => {
  await openLarge(page, "files");
  const bg = await canvas(page)
    .locator(".gc-controls")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(bg).not.toBe("transparent");
  // A box under 160 x 90 on screen draws no tiles: hovering inside it gives the workspace, not a tile.
  const { regions } = await probe(page);
  const tiny = regions.find((r) => r.id === "ws:@acme-platform-monorepo/ui-kit");
  const box = await surface(page).boundingBox();
  if (!tiny || !box) throw new Error("ui-kit box missing");
  expect(tiny.w).toBeLessThan(160);
  await page.mouse.move(box.x + tiny.x + tiny.w / 2, box.y + tiny.y + tiny.h - 6);
  await expect(page.getByRole("tooltip")).toContainText("workspace");
});

test("large scenario: the layout/timing chip appears only with ?debug=1", async ({ page }) => {
  await page.goto("/#/project-map?level=workspaces&scenario=large");
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await expect(canvas(page).locator(".gc-status")).toHaveCount(0);
  await page.goto("/?debug=1#/project-map?level=workspaces&scenario=large");
  await expect(canvas(page).locator(".gc-status")).toContainText("treemap");
});

test("mock scenarios: header and status bar describe the scenario; the Debug tab needs ?debug=1", async ({
  page,
}) => {
  await page.goto("/#/project-map?level=workspaces&scenario=large");
  await expect(canvas(page).locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".repo-name")).toHaveText("acme-platform-monorepo");
  await expect(page.getByText("11 workspaces")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Debug: workspaces" })).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.goto("/?debug=1#/project-map?level=workspaces&scenario=large");
  await expect(page.getByRole("tab", { name: "Debug: workspaces" })).toBeVisible();
  // The route keeps working when typed, without the opt-in.
  await page.goto("/#/debug");
  await expect(page.getByRole("tab", { name: "Debug: workspaces" })).toHaveAttribute("aria-selected", "true");
});
