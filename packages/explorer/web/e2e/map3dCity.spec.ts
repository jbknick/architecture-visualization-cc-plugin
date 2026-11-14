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

// The default 3D style: the code city on the 2D map's ground plan. Mock-only large scenario (3 huge workspaces and
// 8 tiny ones), never real repo data.
async function openCity(page: Page, level: string, extra = ""): Promise<void> {
  await page.goto(`/#/map-3d?level=${level}&scenario=large${extra}`);
  await expect(page.getByTestId("map3d-canvas").locator("canvas")).toBeVisible();
  await expect(page.locator(".map3d[data-ready='true'][data-style='city']")).toBeVisible();
  await page.waitForTimeout(1500);
}

interface DistrictProbe {
  id: string;
  wx: number;
  wz: number;
  ww: number;
  wh: number;
  quad: [number, number][];
  title: [number, number, number, number] | null;
  tiny?: boolean;
}

interface EndProbe {
  key: string;
  district: string;
  kind: "head" | "tail";
  x: number;
  y: number;
}

async function ends(page: Page): Promise<EndProbe[]> {
  const raw = (await page.getByTestId("map3d-labels").getAttribute("data-ends")) ?? "[]";
  return JSON.parse(raw) as EndProbe[];
}

/** Distance (px) from a point to a segment. */
function segDist(p: number[], a: number[], b: number[]): number {
  const dx = (b[0] as number) - (a[0] as number);
  const dy = (b[1] as number) - (a[1] as number);
  const t = Math.max(
    0,
    Math.min(
      1,
      (((p[0] as number) - (a[0] as number)) * dx + ((p[1] as number) - (a[1] as number)) * dy) /
        (dx * dx + dy * dy || 1),
    ),
  );
  return Math.hypot(
    (p[0] as number) - ((a[0] as number) + t * dx),
    (p[1] as number) - ((a[1] as number) + t * dy),
  );
}

/**
 * Distance (px) between a district's title rectangle and its projected slab (the quad: stricter than the quad's
 * bounding rectangle); 0 when they touch.
 */
function titleGap(d: DistrictProbe): number {
  const t = d.title as [number, number, number, number];
  const q = d.quad as number[][];
  const corners = [
    [t[0], t[1]],
    [t[2], t[1]],
    [t[2], t[3]],
    [t[0], t[3]],
  ];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i++)
    for (let k = 0; k < 4; k++) {
      const a = corners[i] as number[];
      const b = corners[(i + 1) % 4] as number[];
      const c = q[k] as number[];
      const e = q[(k + 1) % 4] as number[];
      best = Math.min(best, segDist(a, c, e), segDist(c, a, b));
    }
  // Overlapping counts as touching (a corner of one inside the other).
  const inside = (p: number[], poly: number[][]): boolean => {
    let pos = 0;
    let neg = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as number[];
      const b = poly[(i + 1) % poly.length] as number[];
      const c =
        ((b[0] as number) - (a[0] as number)) * ((p[1] as number) - (a[1] as number)) -
        ((b[1] as number) - (a[1] as number)) * ((p[0] as number) - (a[0] as number));
      if (c > 0) pos++;
      else if (c < 0) neg++;
    }
    return pos === 0 || neg === 0;
  };
  if (
    q.some(
      (p) =>
        (p[0] as number) >= t[0] &&
        (p[0] as number) <= t[2] &&
        (p[1] as number) >= t[1] &&
        (p[1] as number) <= t[3],
    ) ||
    corners.some((p) => inside(p as number[], q))
  )
    return 0;
  return best;
}

async function districts(page: Page): Promise<DistrictProbe[]> {
  const raw = (await page.getByTestId("map3d-labels").getAttribute("data-districts")) ?? "[]";
  return JSON.parse(raw) as DistrictProbe[];
}

interface FlagProbe {
  rank: number;
  id: string;
  x: number;
  y: number;
  ax: number;
  ay: number;
}

async function flags(page: Page): Promise<FlagProbe[]> {
  const raw = (await page.getByTestId("map3d-labels").getAttribute("data-flags")) ?? "[]";
  return JSON.parse(raw) as FlagProbe[];
}

async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return (await page.getByTestId("map3d-canvas").boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

const SHORT = [
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

/** [l, t, r, b] boxes sharing area. */
const boxesOverlap = (a: number[], b: number[]): boolean =>
  (a[0] as number) < (b[2] as number) - 0.5 &&
  (a[2] as number) > (b[0] as number) + 0.5 &&
  (a[1] as number) < (b[3] as number) - 0.5 &&
  (a[3] as number) > (b[1] as number) + 0.5;

const worldKey = (ds: DistrictProbe[]) =>
  Object.fromEntries(ds.map((d) => [d.id, [d.wx, d.wz, d.ww, d.wh].map((v) => Math.round(v * 100) / 100)]));

const byLevel = new Map<string, Record<string, number[]>>();

for (const [level, name] of [
  ["workspaces", "workspaces"],
  ["dirs", "folders"],
  ["files", "files"],
] as const) {
  test(`city, large scenario, ${level} level (light)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openCity(page, level);
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: resolve(shots, `map-3d-city-${name}.png`) });

    // Every district has a visible name block with its counts, and no two name blocks overlap.
    const ds = await districts(page);
    expect(ds).toHaveLength(11);
    const titles = await page.locator(".c3-title:visible .c3-name").allTextContents();
    expect(titles.sort()).toEqual(SHORT);
    const api = page.locator('.c3-title[data-district$="/api"]');
    await expect(api).toContainText("api");
    await expect(api).toContainText("app · 1,700 functions · 260 files");
    const rects = ds.map((d) => d.title as [number, number, number, number]);
    for (const [i, a] of rects.entries())
      for (const b of rects.slice(i + 1))
        expect(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]).toBe(false);

    // Every arch has a count pill (23 import links, fewer than 40); the long form is not shown unselected.
    const pills = await page.locator(".c3-pill:visible").allTextContents();
    expect(pills).toHaveLength(23);
    expect(pills).toContain("640");
    for (const p of pills) expect(p).toMatch(/^[\d,]+$/);
    const key = page.getByTestId("map3d-key");
    await expect(key).toContainText("District = workspace (area = functions)");
    await expect(key).toContainText("Block height = functions");
    await expect(key).toContainText("Arch A → B = A imports from B (colour = importer, number = imports)");
    await expect(key).toContainText("Tests hidden");

    if (level === "dirs") {
      // Folder captions of the three big districts: name and size, never cut.
      // (`innerText` is what is drawn: the size part is collapsed when only the name fits.)
      const caps = await page
        .locator(".c3-cap:visible")
        // biome-ignore lint/performance/useDomNodeTextContent: innerText is what is drawn (the collapsed size part is left out)
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText));
      expect(caps.length).toBeGreaterThanOrEqual(10);
      for (const c of caps) expect(c).toMatch(/^▣\s?[\w./()-]+\s?(· [\d,]+ fn)?$/);
      const full = caps.filter((c) => c.includes(" fn"));
      expect(full.length).toBeGreaterThanOrEqual(4);
      expect(caps.some((c) => /^▣\s?routes/.test(c))).toBe(true);
    }
    if (level === "files") {
      await expect(key).toContainText("Flags = largest files, listed on the left");
      await expect(page.locator(".c3-flag:visible")).toHaveCount(15);
    }

    // The districts stand where they stood at the Workspaces level.
    byLevel.set(level, worldKey(ds));
    const first = byLevel.get("workspaces");
    if (first && level !== "workspaces") expect(worldKey(ds)).toEqual(first);
  });
}

for (const level of ["workspaces", "dirs", "files"] as const) {
  test(`city, large scenario, ${level} level: small workspaces have their title next to the slab and arrowheads apart`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openCity(page, level);
    const ds = await districts(page);
    const tiny = ds.filter((d) => d.tiny);
    // The mock's eight small workspaces (the repo-root one has 17 functions: also tiny next to 1,700).
    expect(tiny.length).toBeGreaterThanOrEqual(7);
    // True when a point of the title rectangle lies on the other district's (convex) slab quad.
    const onSlab = (t: number[], o: DistrictProbe): boolean => {
      const q = o.quad as [number, number][];
      for (let i = 0; i <= 8; i++)
        for (let j = 0; j <= 4; j++) {
          const x = (t[0] as number) + ((t[2] as number) - (t[0] as number)) * (i / 8);
          const y = (t[1] as number) + ((t[3] as number) - (t[1] as number)) * (j / 4);
          let pos = 0;
          let neg = 0;
          for (let k = 0; k < 4; k++) {
            const a = q[k] as [number, number];
            const b = q[(k + 1) % 4] as [number, number];
            const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
            if (c > 0) pos++;
            else if (c < 0) neg++;
          }
          if (pos === 0 || neg === 0) return true;
        }
      return false;
    };
    for (const d of tiny) {
      expect(d.title, d.id).not.toBeNull();
      expect(titleGap(d), `${d.id} title gap`).toBeLessThanOrEqual(24);
      // Not over another district's slab.
      for (const o of ds)
        if (o.id !== d.id) expect(onSlab(d.title as number[], o), `${d.id} over ${o.id}`).toBe(false);
    }
    // Not over a count pill or a flag.
    const pills = await page.locator(".c3-pill:visible").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      }),
    );
    const cv = await canvasBox(page);
    for (const d of tiny)
      for (const p of pills)
        expect(
          boxesOverlap(
            [
              ((d.title as number[])[0] as number) + cv.x,
              ((d.title as number[])[1] as number) + cv.y,
              ((d.title as number[])[2] as number) + cv.x,
              ((d.title as number[])[3] as number) + cv.y,
            ],
            p as number[],
          ),
          `${d.id} title over a pill`,
        ).toBe(false);
    for (const f of await flags(page))
      for (const d of tiny) {
        const t = d.title as number[];
        expect(
          f.x + 10 < (t[0] as number) ||
            f.x - 10 > (t[2] as number) ||
            f.y + 10 < (t[1] as number) ||
            f.y - 10 > (t[3] as number),
          `${d.id} over flag ${f.rank}`,
        ).toBe(true);
      }
    // Arrowheads on the same small district are at least 14px apart.
    const e = await ends(page);
    const heads = e.filter((x) => x.kind === "head");
    expect(heads.length).toBeGreaterThan(8);
    for (const [i, a] of heads.entries())
      for (const b of heads.slice(i + 1))
        if (a.district === b.district)
          expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.key} / ${b.key}`).toBeGreaterThanOrEqual(14);
    // Their counts are readable (pills are shown for every arch, see the district tests).
    expect(await page.locator(".c3-pill:visible").count()).toBe(23);
  });
}

test("city, large scenario: Focus small workspaces frames the small districts; Reset camera returns", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openCity(page, "workspaces");
  const slabW = (d: DistrictProbe) =>
    ((d.quad[1] as number[])[0] as number) - ((d.quad[0] as number[])[0] as number);
  const before = await districts(page);
  const tinyBefore = before.filter((d) => d.tiny);
  await page.getByRole("button", { name: "Focus small workspaces" }).click();
  await page.waitForTimeout(1400);
  const after = await districts(page);
  const tinyAfter = after.filter((d) => d.tiny);
  const box = await canvasBox(page);
  // The tiny districts are bigger on screen and all in frame; their titles stay next to them.
  const mean = (ds: DistrictProbe[]) => ds.reduce((s, d) => s + slabW(d), 0) / ds.length;
  expect(mean(tinyAfter)).toBeGreaterThan(mean(tinyBefore) * 1.15);
  for (const d of tinyAfter) {
    for (const p of d.quad) {
      expect(p[0]).toBeGreaterThan(0);
      expect(p[0]).toBeLessThan(box.width);
      expect(p[1]).toBeGreaterThan(0);
      expect(p[1]).toBeLessThan(box.height);
    }
    expect(titleGap(d), `${d.id} title gap`).toBeLessThanOrEqual(24);
  }
  const heads = (await ends(page)).filter((x) => x.kind === "head");
  for (const [i, a] of heads.entries())
    for (const b of heads.slice(i + 1))
      if (a.district === b.district) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(14);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "map-3d-city-small-focus.png") });
  await page.getByRole("button", { name: "Reset camera" }).click();
  await page.waitForTimeout(1400);
  const reset = await districts(page);
  expect(reset.map((d) => (d.quad[0] as number[]).map(Math.round))).toEqual(
    before.map((d) => (d.quad[0] as number[]).map(Math.round)),
  );
});

test("city, large scenario: double-clicking a small district frames the small districts", async ({
  page,
}) => {
  await openCity(page, "workspaces");
  const box = await canvasBox(page);
  const before = await districts(page);
  const t = before.find((d) => d.id.endsWith("/ui-kit")) as DistrictProbe;
  const cx = t.quad.reduce((s, p) => s + (p[0] as number), 0) / 4;
  const cy = t.quad.reduce((s, p) => s + (p[1] as number), 0) / 4;
  await page.mouse.dblclick(box.x + cx, box.y + cy - 4);
  await page.waitForTimeout(1400);
  await expect(page).toHaveURL(/sel=ws%3A%40acme-platform-monorepo%2Fui-kit/);
  const after = await districts(page);
  const w = (d: DistrictProbe) =>
    ((d.quad[1] as number[])[0] as number) - ((d.quad[0] as number[])[0] as number);
  const a = after.find((d) => d.id === t.id) as DistrictProbe;
  expect(w(a)).toBeGreaterThan(w(t) * 1.05);
  // The other small districts are in frame too (not just the one that was clicked).
  for (const d of after.filter((x) => x.tiny)) {
    expect((d.quad[0] as number[])[0]).toBeGreaterThan(0);
    expect((d.quad[1] as number[])[0]).toBeLessThan(box.width);
  }
});

test("city, large scenario, files level: flags are numbered like the list, apart from each other, and hovering a row lights one", async ({
  page,
}) => {
  await openCity(page, "files");
  const list = page.getByTestId("largest-files");
  const rows = list.locator(".largest-row");
  await expect(rows).toHaveCount(15);
  const listed = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.file ?? ""));
  const fl = await flags(page);
  expect(fl.map((f) => f.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  expect(fl.map((f) => f.id)).toEqual(listed);
  const box = await canvasBox(page);
  for (const [i, f] of fl.entries()) {
    expect(f.x).toBeGreaterThan(0);
    expect(f.x).toBeLessThan(box.width);
    expect(f.y).toBeGreaterThan(0);
    for (const o of fl.slice(i + 1)) expect(Math.hypot(f.x - o.x, f.y - o.y)).toBeGreaterThanOrEqual(20);
  }
  await expect(page.locator(".c3-flag:visible")).toHaveCount(15);
  // Hovering a list row highlights that flag (and raises its building).
  await rows.nth(3).hover();
  await expect(page.locator(".c3-flag.is-hover")).toHaveText("4");
  // Clicking the building under a flag selects the file (inspector); clicking a row does too.
  const f1 = fl[0] as FlagProbe;
  await page.mouse.move(box.x + f1.ax, box.y + f1.ay + 2);
  await expect(page.getByRole("status").filter({ hasText: "functions" })).toContainText(
    /file · [\d,]+ functions/,
  );
  await page.mouse.click(box.x + f1.ax, box.y + f1.ay + 2);
  await expect(page).toHaveURL(/sel=file/);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  await rows.nth(1).click();
  await expect(page).toHaveURL(
    new RegExp(`sel=${encodeURIComponent(listed[1] as string).replace(/\./g, "\\.")}`),
  );
});

test("city, large scenario: districts keep their positions when the level changes in the panel", async ({
  page,
}) => {
  await openCity(page, "workspaces");
  const a = worldKey(await districts(page));
  await page.getByLabel("Files").click();
  await expect(page).toHaveURL(/level=files/);
  await expect(page.locator(".map3d[data-ready='true'][data-level='files']")).toBeVisible();
  await page.waitForTimeout(800);
  expect(worldKey(await districts(page))).toEqual(a);
  await page.getByLabel("Folders").click();
  await expect(page.locator(".map3d[data-ready='true'][data-level='dirs']")).toBeVisible();
  await page.waitForTimeout(800);
  expect(worldKey(await districts(page))).toEqual(a);
});

test("city, large scenario: top view is the 2D map seen from above (axis-aligned, left to right), angled view is the default", async ({
  page,
}) => {
  await openCity(page, "files");
  const angled = await districts(page);
  // Angled: the floors are skewed quads (not axis aligned).
  const skew = angled.filter(
    (d) => Math.abs(((d.quad[0] as number[])[1] as number) - ((d.quad[1] as number[])[1] as number)) > 3,
  );
  expect(skew.length).toBeGreaterThan(5);
  // The flow of the 2D map reads left to right: api (imports from core) lies left of core in both views.
  await page.getByRole("button", { name: "Top view" }).click();
  await page.waitForTimeout(1200);
  const top = await districts(page);
  for (const d of top) {
    const [bl, br, fr, fl] = d.quad as [number, number][];
    expect(Math.abs(((bl as number[])[1] as number) - ((br as number[])[1] as number)), d.id).toBeLessThan(
      1.5,
    );
    expect(Math.abs(((bl as number[])[0] as number) - ((fl as number[])[0] as number)), d.id).toBeLessThan(
      1.5,
    );
    expect((fr as number[])[0]).toBeGreaterThan((fl as number[])[0] as number);
    expect((fl as number[])[1]).toBeGreaterThan((bl as number[])[1] as number); // 2D y grows downwards
  }
  // One scale for the whole picture: screen size / world size is the same for every district.
  const scales = top.map(
    (d) => (((d.quad[1] as number[])[0] as number) - ((d.quad[0] as number[])[0] as number)) / d.ww,
  );
  for (const s of scales) expect(Math.abs(s - (scales[0] as number))).toBeLessThan(0.02);
  // And the centres are the world centres, scaled: the arrangement is the 2D map's.
  const s0 = scales[0] as number;
  const ref = top[0] as DistrictProbe;
  for (const d of top) {
    const dx = (((d.quad[0] as number[])[0] as number) - ((ref.quad[0] as number[])[0] as number)) / s0;
    const dz = (((d.quad[0] as number[])[1] as number) - ((ref.quad[0] as number[])[1] as number)) / s0;
    expect(Math.abs(dx - (d.wx - ref.wx)), `${d.id} x`).toBeLessThan(2);
    expect(Math.abs(dz - (d.wz - ref.wz)), `${d.id} z`).toBeLessThan(2);
  }
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "map-3d-city-files-top.png") });
  await page.getByRole("button", { name: "Angled view" }).click();
  await page.waitForTimeout(1200);
  const back = await districts(page);
  expect(
    back.filter(
      (d) => Math.abs(((d.quad[0] as number[])[1] as number) - ((d.quad[1] as number[])[1] as number)) > 3,
    ).length,
  ).toBeGreaterThan(5);
  // Reset camera returns to the angled default.
  await page.getByRole("button", { name: "Top view" }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Reset camera" }).click();
  await page.waitForTimeout(1200);
  const reset = await districts(page);
  expect(reset.map((d) => (d.quad[0] as number[]).map(Math.round))).toEqual(
    angled.map((d) => (d.quad[0] as number[]).map(Math.round)),
  );
});

test("city, large scenario, files level (dark)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openCity(page, "files");
  await page.screenshot({ path: resolve(shots, "map-3d-city-files-dark.png") });
});

test("city, large scenario: a selected district shows only its arches in full, with 'A → B: N imports' labels", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openCity(page, "files");
  await page.getByRole("button", { name: /^web/ }).click();
  await expect(page).toHaveURL(/sel=ws%3A%40acme-platform-monorepo%2Fweb/);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  await page.waitForTimeout(1200);
  const full = await page.locator(".c3-pill.is-full:visible").allTextContents();
  expect(full.length).toBeGreaterThanOrEqual(6);
  for (const t of full) expect(t).toMatch(/^(web → [\w-]+|[\w-]+ → web): [\d,]+ imports$/);
  expect(full).toContain("web → core: 410 imports");
  // The other arches are dimmed.
  expect(await page.locator(".c3-pill.is-dim:visible").count()).toBeGreaterThan(5);
  // The long labels do not overlap each other.
  const boxes = await page.locator(".c3-pill.is-full:visible").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom];
    }),
  );
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1)) expect(boxesOverlap(a as number[], b as number[])).toBe(false);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "map-3d-city-selected.png") });
});

test("city, large scenario: tooltips for districts, folders, buildings and arches; click selects; double-click flies", async ({
  page,
}) => {
  await openCity(page, "files");
  const box = await canvasBox(page);
  const tip = page.getByRole("status").filter({ hasText: /imports|functions/ });
  // A building (flag foot).
  const f = (await flags(page))[2] as FlagProbe;
  await page.mouse.move(box.x + f.ax, box.y + f.ay + 3, { steps: 3 });
  await expect(tip).toContainText(/file · [\d,]+ functions/);
  await page.mouse.move(box.x + 5, box.y + box.height - 5);
  // Double-click flies the camera to the building: the picture changes and the file is selected.
  const before = await flags(page);
  await page.mouse.dblclick(box.x + f.ax, box.y + f.ay + 3);
  await page.waitForTimeout(1200);
  await expect(page).toHaveURL(/sel=file/);
  const after = await flags(page);
  expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
});

test("city, large scenario: hovering a workspace in the list shows its arches with A → B: N imports labels", async ({
  page,
}) => {
  await openCity(page, "workspaces");
  await page.getByRole("button", { name: /^web/ }).hover();
  await page.waitForTimeout(600);
  const pills = await page.locator(".c3-pill.is-full:visible").allTextContents();
  expect(pills).toContain("web → core: 410 imports");
});

test("city: the style switch is in the hash (islands) and remembered; city is the default and leaves no trace", async ({
  page,
}) => {
  await openCity(page, "dirs");
  await expect(page).not.toHaveURL(/style=/);
  await expect(page.getByLabel("City")).toBeChecked();
  await page.getByLabel("Islands").click();
  await expect(page).toHaveURL(/style=islands/);
  await expect(page.locator(".map3d[data-ready='true']:not([data-style])")).toBeVisible();
  await expect(page.locator(".m3-overlay")).toBeAttached();
  // Remembered: opening the view again without the flag gives the islands.
  await page.goto("/#/map-3d?level=dirs&scenario=large");
  await page.reload();
  await expect(page.locator(".map3d[data-ready='true']:not([data-style])")).toBeVisible();
  await page.getByLabel("City").click();
  await expect(page).not.toHaveURL(/style=/);
  await expect(page.locator(".map3d[data-ready='true'][data-style='city']")).toBeVisible({ timeout: 20_000 });
});

test("city: respects reduced motion (auto-rotate is off and disabled)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openCity(page, "dirs");
  await expect(page.getByLabel(/Auto-rotate/)).toBeDisabled();
  await page.getByRole("button", { name: "Top view" }).click();
  // No animation: the camera is in place at once.
  await page.waitForTimeout(150);
  const top = await districts(page);
  const quad = (top[0] as DistrictProbe).quad;
  expect(Math.abs(((quad[0] as number[])[1] as number) - ((quad[1] as number[])[1] as number))).toBeLessThan(
    1.5,
  );
});

test("city, large scenario, workspaces level: hovering a district shows its name, type, functions and files", async ({
  page,
}) => {
  await openCity(page, "workspaces");
  const box = await canvasBox(page);
  const api = (await districts(page)).find((d) => d.id.endsWith("/api")) as DistrictProbe;
  const cx = api.quad.reduce((s, p) => s + (p[0] as number), 0) / 4;
  const cy = api.quad.reduce((s, p) => s + (p[1] as number), 0) / 4;
  await page.mouse.move(box.x + cx - 5, box.y + cy - 5);
  await page.mouse.move(box.x + cx, box.y + cy - 12, { steps: 4 });
  const tip = page.getByRole("status").filter({ hasText: "functions" });
  await expect(tip).toContainText("api");
  await expect(tip).toContainText("app · 1,700 functions · 260 files");
  await page.mouse.click(box.x + cx, box.y + cy - 12);
  await expect(page).toHaveURL(/sel=ws%3A%40acme-platform-monorepo%2Fapi/);
});

test("city, large scenario, folders level: hovering a folder shows its path, functions and files", async ({
  page,
}) => {
  await openCity(page, "dirs");
  const box = await canvasBox(page);
  // The centre of a caption lies on its folder's block.
  const cap = page.locator(".c3-cap:visible", { hasText: "routes" }).first();
  const r = (await cap.boundingBox()) as { x: number; y: number; width: number; height: number };
  const x = r.x - box.x + r.width / 2;
  const y = r.y - box.y + r.height + 6;
  await page.mouse.move(box.x + x - 3, box.y + y - 3);
  await page.mouse.move(box.x + x, box.y + y, { steps: 3 });
  const tip = page.getByRole("status").filter({ hasText: "functions" });
  await expect(tip).toContainText(/folder · [\d,]+ functions · [\d,]+ files/);
});
