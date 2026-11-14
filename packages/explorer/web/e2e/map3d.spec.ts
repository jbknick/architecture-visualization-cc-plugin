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

// Runs against the mock API's synthetic map-3d dataset (5 workspaces, 60 files), never real repo data.
test("3D map: islands, labels and bundled arcs on fixture data", async ({ page }) => {
  await page.goto("/#/map-3d?level=files&style=islands");
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
interface Box {
  cls: string;
  text: string;
  island: string | null;
  l: number;
  t: number;
  r: number;
  b: number;
  fs: number;
  fw: number;
}

/** Every label that is currently shown, with its on-screen box. */
async function shownLabels(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".m3-label")]
      .filter((e) => e.style.visibility === "visible")
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          cls: e.className,
          text: e.textContent ?? "",
          island: e.getAttribute("data-island"),
          l: r.left,
          t: r.top,
          r: r.right,
          b: r.bottom,
          fs: Number.parseFloat(getComputedStyle(e.querySelector(".m3-name") ?? e).fontSize),
          fw: Number.parseFloat(getComputedStyle(e).fontWeight),
        };
      }),
  );
}

const SHORT_NAMES = [
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
const BIG = [
  "ws:@acme-platform-monorepo/api",
  "ws:@acme-platform-monorepo/web",
  "ws:@acme-platform-monorepo/core",
];
/** Island label boxes per level, to compare the three levels (same camera, same islands). */
const boxesByLevel = new Map<string, Box[]>();

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

    const boxes = await shownLabels(page);
    // Every island has one attached name + caption block.
    const islands = boxes.filter((b) => b.cls.includes("m3-island"));
    expect(islands.map((b) => b.text.split(/\d/)[0]?.trim()).sort()).toEqual(SHORT_NAMES);
    for (const b of islands) {
      expect(b.fs, b.text).toBeGreaterThanOrEqual(level === "files" ? 9.5 : 12);
      expect(b.text).toMatch(/\d+ functions · [\d,]+ files · (app|package|\(repo root\))/);
      expect(b.text).not.toContain("unknown");
    }
    const leaders = await page
      .locator(".m3-leader")
      .evaluateAll((els) => els.filter((e) => (e as SVGElement).style.visibility === "visible").length);
    expect(leaders).toBeGreaterThanOrEqual(11); // each island has its tick or leader line
    // No label covers another label.
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const hit = a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;
        expect(hit, `${a.text} / ${b.text}`).toBe(false);
      }
    }
    // Every arc has a count pill (16 import arcs, fewer than 40), each with its direction arrow.
    const pills = boxes.filter((b) => b.cls.includes("m3-arc"));
    expect(pills.length).toBe(16);
    for (const p of pills) expect(p.text).toMatch(/^[\d,]+$/);
    expect(await page.locator(".m3-arc:visible .m3-pa").count()).toBe(16);
    // No island name block touches any island disc, arc pill or arrowhead.
    const overlay = page.getByTestId("map3d-labels");
    const discs = JSON.parse((await overlay.getAttribute("data-discs")) ?? "[]") as {
      x: number;
      y: number;
      r: number;
    }[];
    const heads = JSON.parse((await overlay.getAttribute("data-heads")) ?? "[]") as number[][];
    const host = (await page.getByTestId("map3d-canvas").boundingBox()) as { x: number; y: number };
    expect(discs).toHaveLength(11);
    for (const b of islands) {
      const l = b.l - host.x;
      const t = b.t - host.y;
      const r = b.r - host.x;
      const bt = b.b - host.y;
      for (const d of discs) {
        const nx = Math.min(Math.max(d.x, l), r);
        const ny = Math.min(Math.max(d.y, t), bt);
        expect(Math.hypot(nx - d.x, ny - d.y), `${b.text} over an island`).toBeGreaterThanOrEqual(d.r);
      }
      for (const h of heads) {
        const hit =
          l < (h[2] as number) && r > (h[0] as number) && t < (h[3] as number) && bt > (h[1] as number);
        expect(hit, `${b.text} over an arrowhead`).toBe(false);
      }
    }
    // The two opposite arcs between api and core are separate: two pills, two bows, far apart.
    const api = "ws:@acme-platform-monorepo/api";
    const core = "ws:@acme-platform-monorepo/core";
    const pillAt = async (id: string) =>
      page.locator(`.m3-arc[data-arc="${id}"]`).evaluate((e) => {
        const r = e.getBoundingClientRect();
        return { text: e.textContent ?? "", x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    const ab = await pillAt(`${api}>${core}`);
    const ba = await pillAt(`${core}>${api}`);
    expect([ab.text, ba.text]).toEqual(["267", "3"]);
    expect(Math.hypot(ab.x - ba.x, ab.y - ba.y)).toBeGreaterThan(40);
    // The always-visible key.
    const key = page.getByTestId("map3d-key");
    await expect(key).toContainText("Island = workspace (size = functions)");
    await expect(key).toContainText("Arrow A → B = A imports from B (thicker = more imports)");
    await expect(key).toContainText("Tests hidden");

    if (level === "dirs") {
      // Folders of the three big islands: 7 + 6 + 5 = 18 (the empty "(root)" folder of api is not drawn).
      const dirs = boxes.filter((b) => b.cls.includes("m3-dir"));
      expect(dirs.length).toBeGreaterThanOrEqual(17);
      for (const d of dirs) {
        expect(d.text.replace("\n", " ")).toMatch(/ [\d,]+ fn$/);
        expect(d.text.startsWith("src/")).toBe(false);
        expect(d.text).not.toContain("(root)");
        expect(d.text).not.toMatch(/\b0 fn/);
      }
    }
    if (level === "files") {
      const clusters = boxes.filter((b) => b.cls.includes("m3-cluster"));
      expect(clusters.length).toBeGreaterThanOrEqual(14);
      for (const c of clusters) {
        expect(c.text).toMatch(/ · [\d,]+ fn$/);
        expect(c.text).not.toContain("(root)");
      }
      // Folder captions are bold with a folder glyph; file names are regular weight and belong to ranked files only.
      for (const c of boxes.filter((b) => b.cls.includes("m3-cluster")))
        expect(c.fw).toBeGreaterThanOrEqual(700);
      const names = boxes.filter((b) => b.cls.includes("m3-file"));
      expect(names.length).toBeGreaterThanOrEqual(1);
      for (const n of names) {
        expect(n.text).toMatch(/^[\w.-]+( · [\d,]+ fn)?$/);
        expect(n.text).not.toContain("…");
        expect(n.fw).toBeLessThanOrEqual(500);
      }
      await expect(page.locator(".m3-cluster .m3-fg").first()).toBeAttached();
      await expect(page.getByTestId("map3d-key")).toContainText(
        "Numbers = largest files, listed on the left",
      );
      // No web of import lines by default.
      expect(await page.getByTestId("map3d-labels").getAttribute("data-edges")).toBe("0");
      // Hovering a file dot draws that file's imports as thin lines (dots are small: try the ranked ones in turn).
      const dots = (await rankProbe(page)).ranks.map((r) => `${r.dx},${r.dy}`);
      let edges = 0;
      for (const dot of dots) {
        const [dx, dy] = dot.split(",").map(Number) as [number, number];
        await page.mouse.move(host.x + dx - 3, host.y + dy - 3);
        await page.mouse.move(host.x + dx, host.y + dy, { steps: 4 });
        await page.waitForTimeout(300);
        edges = Number(await page.getByTestId("map3d-labels").getAttribute("data-edges"));
        if (edges > 0) break;
      }
      expect(edges).toBeGreaterThan(0);
      await page.screenshot({ path: resolve(shots, "map-3d-large-files-file-hover.png") });
      // Hovering an island lights it up.
      await page.getByRole("button", { name: /^api/ }).hover();
      await page.waitForTimeout(600);
      await page.screenshot({ path: resolve(shots, "map-3d-large-files-hover.png") });
    }

    // Same picture at every level: the big islands' blocks sit where they sat at the Workspaces level.
    boxesByLevel.set(level, islands);
    const ws = boxesByLevel.get("workspaces");
    if (ws && level !== "workspaces") {
      for (const isl of ws.filter((b) => BIG.some((id) => b.island === id))) {
        const same = islands.find((b) => b.island === isl.island);
        expect(same, isl.text).toBeDefined();
        expect(Math.abs((same?.l ?? 0) - isl.l), isl.text).toBeLessThan(2);
        expect(Math.abs((same?.t ?? 0) - isl.t), isl.text).toBeLessThan(2);
      }
    }
  });
}

/** The map3d overlay's rank markers and file names for the Files level, in screen px relative to the canvas. */
async function rankProbe(page: Page) {
  const overlay = page.getByTestId("map3d-labels");
  const ranks = JSON.parse((await overlay.getAttribute("data-ranks")) ?? "[]") as {
    rank: number;
    id: string;
    x: number;
    y: number;
    dx: number;
    dy: number;
    dr: number;
  }[];
  const discs = JSON.parse((await overlay.getAttribute("data-discs")) ?? "[]") as {
    id: string;
    x: number;
    y: number;
    r: number;
  }[];
  return { ranks, discs };
}

test("3D map, large scenario, files level: 'Largest files' lists 15 files and the canvas numbers them the same way", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openLarge(page, "files");
  const list = page.getByTestId("largest-files");
  const rows = list.locator(".largest-row");
  await expect(rows).toHaveCount(15);
  const listed = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.file ?? ""));
  await expect(rows.first().locator(".largest-where")).toContainText("›");
  // 15 markers, numbered like the list, each next to its dot (leader at most 14px) and apart from each other.
  const markers = page.locator(".m3-rank");
  await expect(markers).toHaveCount(15);
  const visible = await markers.evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).style.visibility === "visible")
      .map((e) => ({ rank: Number(e.textContent), id: (e as HTMLElement).dataset.file ?? "" })),
  );
  expect(visible.map((m) => m.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  expect(visible.map((m) => m.id)).toEqual(listed);
  const { ranks } = await rankProbe(page);
  expect(ranks).toHaveLength(15);
  const near: number[] = [];
  for (const [i, m] of ranks.entries()) {
    near.push(Math.hypot(m.x - m.dx, m.y - m.dy) - 9 - m.dr);
    for (const o of ranks.slice(i + 1)) expect(Math.hypot(m.x - o.x, m.y - o.y)).toBeGreaterThanOrEqual(18);
  }
  expect(Math.max(...near)).toBeLessThanOrEqual(14.5);
  // Hovering a marker shows the tooltip with name, counts and path.
  const host = (await page.getByTestId("map3d-canvas").boundingBox()) as { x: number; y: number };
  const m2 = ranks[1] as (typeof ranks)[number];
  await page.mouse.move(host.x + m2.x - 2, host.y + m2.y - 2);
  await page.mouse.move(host.x + m2.x, host.y + m2.y, { steps: 3 });
  const tip = page.getByRole("status").filter({ hasText: "functions" });
  await expect(tip).toContainText(/file · [\d,]+ functions/);
  await expect(tip).toContainText((await rows.nth(1).getAttribute("title")) ?? "");
  // Clicking a row selects the file (inspector).
  await rows.nth(0).click();
  await expect(page).toHaveURL(/sel=file/);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
});

test("3D map, large scenario, files level: every file name is inside its island or within 28px of its dot", async ({
  page,
}) => {
  await openLarge(page, "files");
  const { discs } = await rankProbe(page);
  const host = (await page.getByTestId("map3d-canvas").boundingBox()) as { x: number; y: number };
  const names = await page.locator(".m3-file").evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).style.visibility === "visible")
      .map((e) => {
        const r = e.getBoundingClientRect();
        const el = e as HTMLElement;
        return {
          text: e.textContent ?? "",
          isl: el.dataset.isl ?? "",
          dot: (el.dataset.dot ?? "0,0").split(",").map(Number) as [number, number],
          l: r.left,
          t: r.top,
          r: r.right,
          b: r.bottom,
        };
      }),
  );
  expect(names.length).toBeGreaterThanOrEqual(1);
  for (const n of names) {
    const l = n.l - host.x;
    const t = n.t - host.y;
    const r = n.r - host.x;
    const b = n.b - host.y;
    const own = discs.find((d) => d.id === n.isl);
    const inside =
      !!own &&
      [
        [l, t],
        [r, t],
        [l, b],
        [r, b],
      ].every(([x, y]) => Math.hypot((x as number) - own.x, (y as number) - own.y) <= own.r);
    const nx = Math.min(Math.max(n.dot[0], l), r);
    const ny = Math.min(Math.max(n.dot[1], t), b);
    const toDot = Math.hypot(nx - n.dot[0], ny - n.dot[1]);
    expect(inside || toDot <= 28, `${n.text}: ${toDot.toFixed(1)}px from its dot, inside=${inside}`).toBe(
      true,
    );
    // Never over another island.
    for (const d of discs) {
      if (d.id === n.isl) continue;
      const cx = Math.min(Math.max(d.x, l), r);
      const cy = Math.min(Math.max(d.y, t), b);
      expect(Math.hypot(cx - d.x, cy - d.y), `${n.text} over another island`).toBeGreaterThanOrEqual(d.r);
    }
  }
});

test("3D map, large scenario, files level (dark)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openLarge(page, "files");
  await page.screenshot({ path: resolve(shots, "map-3d-large-files-dark.png") });
});

test("3D map, large scenario, files level: 'Top files in' restricts the ranking to one workspace", async ({
  page,
}) => {
  await openLarge(page, "files");
  const list = page.getByTestId("largest-files");
  await list.getByLabel("Top files in").selectOption({ label: "core" });
  const rows = list.locator(".largest-row");
  await expect(rows).toHaveCount(15);
  for (const w of await rows.locator(".largest-where").allTextContents())
    expect(w.trim().startsWith("core")).toBe(true);
  await page.waitForTimeout(400);
  const { ranks } = await rankProbe(page);
  expect(ranks.map((m) => m.id)).toEqual(
    await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.file ?? "")),
  );
});

test("3D map, large scenario: the workspace list fits at 900px, 'How to read it' collapses and scrolling still works", async ({
  page,
}) => {
  await openLarge(page, "dirs");
  const left = page.getByRole("complementary", { name: "Filters" });
  const toggle = left.getByRole("button", { name: /How to read it/ });
  await expect(toggle).toBeVisible();
  // 11 workspaces: the block starts collapsed to its one line, so the whole list is on screen without scrolling.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(left.getByText("Legend", { exact: true })).toHaveCount(0);
  const order = await left.evaluate((el) => {
    const y = (sel: string) => el.querySelector(sel)?.getBoundingClientRect().top ?? Number.NaN;
    return { levels: y(".map3d-levels"), howto: y(".map3d-howto"), list: y(".map3d-legend") };
  });
  expect(order.levels).toBeLessThan(order.howto);
  expect(order.howto).toBeLessThan(order.list);
  expect(await left.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  const last = left.locator(".map3d-legend-row").last();
  const [row, panel] = await Promise.all([last.boundingBox(), left.boundingBox()]);
  expect((row?.y ?? 0) + (row?.height ?? 0)).toBeLessThanOrEqual((panel?.y ?? 0) + (panel?.height ?? 0) + 1);
  await expect(last).toBeInViewport({ ratio: 1 });
  // Expanding shows the three keys; the list then scrolls, and the choice is remembered over a reload.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(left.getByText(/Island = one workspace/)).toBeVisible();
  expect(await left.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  await page.reload();
  await expect(page.locator(".map3d[data-ready='true']")).toBeVisible();
  await expect(left.getByRole("button", { name: /How to read it/ })).toHaveAttribute("aria-expanded", "true");
});

test("3D map, large scenario, folders level (dark), hovering the web island", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openLarge(page, "dirs");
  await page.screenshot({ path: resolve(shots, "map-3d-large-folders-dark.png") });
  // Hovering a legend row highlights its island and reveals its arcs with "A -> B: N imports" labels.
  await page.getByRole("button", { name: /^web/ }).hover();
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(shots, "map-3d-large-hover-dark.png") });
  const boxes = await shownLabels(page);
  expect(boxes.some((b) => /^web → .+: [\d,]+ imports$/.test(b.text))).toBe(true);
});

test("3D map, large scenario: every island is still named in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openLarge(page, "workspaces");
  const boxes = await shownLabels(page);
  expect(boxes.filter((b) => b.cls.includes("m3-island"))).toHaveLength(11);
});

async function openLarge(page: Page, level: string): Promise<void> {
  await page.goto(`/#/map-3d?level=${level}&scenario=large&style=islands`);
  await expect(page.getByTestId("map3d-canvas").locator("canvas")).toBeVisible();
  await expect(page.locator(".map3d[data-ready='true']")).toBeVisible();
  await page.waitForTimeout(2500);
}
