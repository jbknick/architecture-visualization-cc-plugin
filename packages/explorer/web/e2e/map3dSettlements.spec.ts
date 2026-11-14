import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// Headless Chromium has no GPU; software GL (SwiftShader) gives the page a WebGL context.
test.use({
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
});

// The default 3D style since #114: settlements. Mock-only large scenario (3 huge workspaces, 8 tiny ones).
async function open(page: Page, extra = ""): Promise<Locator> {
  await page.goto(`/#/map-3d?scenario=large${extra}`);
  await expect(page.getByTestId("map3d-canvas").locator("canvas")).toBeVisible();
  await expect(page.locator(".map3d[data-ready='true'][data-style='settlements']")).toBeVisible();
  const host = page.getByTestId("map3d-canvas");
  await expect(host).toHaveAttribute("data-frames", /[1-9]/);
  await page.waitForTimeout(800);
  return host;
}

interface Pixels {
  /** Share of pixels that are not the sky (the scene's background). */
  nonSky: number;
  /** Share of strongly coloured pixels: roofs, kerbs, fields, vehicles. The bare ground and sky are muted. */
  vivid: number;
}

/** Reads the WebGL canvas only: the DOM labels, key and controls are hidden while the screenshot is taken. */
async function pixels(page: Page): Promise<Pixels> {
  const canvas = page.getByTestId("map3d-canvas").locator("canvas");
  await page.addStyleTag({
    content: ".s3-overlay,.c3-overlay,.m3-overlay,.map3d-key,.map3d-tip,.s3-controls{display:none!important}",
  });
  const png = await canvas.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const x = c.getContext("2d") as CanvasRenderingContext2D;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    // The sky: the most common colour along the top rows.
    const counts = new Map<number, number>();
    for (let i = 0; i < c.width * 4 * 4; i += 4) {
      const k = ((d[i] as number) << 16) | ((d[i + 1] as number) << 8) | (d[i + 2] as number);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sky = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const sr = sky >> 16;
    const sg = (sky >> 8) & 255;
    const sb = sky & 255;
    let non = 0;
    let vivid = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 3) {
      const r = d[i] as number;
      const g = d[i + 1] as number;
      const b = d[i + 2] as number;
      n++;
      if (Math.abs(r - sr) + Math.abs(g - sg) + Math.abs(b - sb) > 30) non++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) vivid++;
    }
    return { nonSky: non / n, vivid: vivid / n };
  }, png.toString("base64"));
}

async function canvasBox(page: Page) {
  const box = await page.getByTestId("map3d-canvas").locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  return box;
}

// Regression for #114: the meshes vanished while the labels stayed, and came back only for some pointer positions.
// Paused (reduced motion) is the scene's render-on-demand path, the one that can miss a redraw.
for (const style of ["settlements", "city"] as const) {
  test(`${style}: the geometry stays drawn wherever the pointer is, after orbit, zoom and a WebGL context loss`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (style === "city") {
      await page.goto("/#/map-3d?scenario=large&style=city");
      await expect(page.locator(".map3d[data-ready='true'][data-style='city']")).toBeVisible();
      await page.waitForTimeout(1500);
    } else await open(page);
    const box = await canvasBox(page);
    const at = (fx: number, fy: number) => page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    const base = await pixels(page);
    expect(base.nonSky).toBeGreaterThan(0.15);
    expect(base.vivid).toBeGreaterThan(0.01);
    const steady = (p: Pixels, what: string) => {
      expect(p.vivid, what).toBeGreaterThan(base.vivid * 0.6);
      expect(p.nonSky, what).toBeGreaterThan(base.nonSky * 0.6);
    };
    // Pointer over the scene in several places, then outside the canvas.
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.12, 0.15],
      [0.88, 0.85],
      [0.3, 0.7],
      [0.72, 0.22],
    ] as const) {
      await at(fx, fy);
      await page.waitForTimeout(250);
      steady(await pixels(page), `pointer at ${fx}, ${fy}`);
    }
    await page.mouse.move(2, 2);
    await page.waitForTimeout(250);
    steady(await pixels(page), "pointer outside the canvas");
    // Zoom out far (about 40 times the starting distance): the land gets small but must not be clipped away.
    for (let i = 0; i < 36; i++) {
      await at(0.5, 0.5);
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(80);
    }
    await page.mouse.move(2, 2);
    await page.waitForTimeout(500);
    const far = await pixels(page);
    if (process.env.DEBUG_SHOTS)
      await page.screenshot({ path: `${process.env.DEBUG_SHOTS}/far-${style}.png` });
    expect(far.nonSky, "zoomed out").toBeGreaterThan(0.02);
    expect(far.vivid, "zoomed out").toBeGreaterThan(0.0002);
    // Zoom all the way in. (Settlements only: the city has no ground, only a background of the same colour, so close
    // up over a gap there is nothing to measure, and its label search is slow at that scale in software GL.)
    if (style === "settlements") {
      for (let i = 0; i < 60; i++) {
        await at(0.5, 0.5);
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(40);
      }
      await page.mouse.move(2, 2);
      await page.waitForTimeout(500);
      expect((await pixels(page)).nonSky, "zoomed in").toBeGreaterThan(0.3);
    }
    // Orbit from the starting view.
    await page.getByRole("button", { name: "Reset camera" }).click();
    await page.waitForTimeout(300);
    await at(0.5, 0.5);
    await page.mouse.down();
    await at(0.58, 0.46);
    await at(0.64, 0.42);
    await page.mouse.up();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
    const orbit = await pixels(page);
    expect(orbit.vivid, "after orbit").toBeGreaterThan(base.vivid * 0.3);
    // A lost and restored WebGL context comes back drawn without any pointer move.
    await page.getByRole("button", { name: "Reset camera" }).click();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(800);
    const before = await pixels(page);
    await page.evaluate(async () => {
      const c = document.querySelector("[data-testid=map3d-canvas] canvas") as HTMLCanvasElement;
      const gl = c.getContext("webgl2") as WebGL2RenderingContext;
      const ext = gl.getExtension("WEBGL_lose_context");
      if (!ext) throw new Error("no WEBGL_lose_context");
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 300));
      ext.restoreContext();
    });
    await page.waitForTimeout(1200);
    const restored = await pixels(page);
    expect(restored.vivid, "after a context restore").toBeGreaterThan(before.vivid * 0.6);
    expect(restored.nonSky, "after a context restore").toBeGreaterThan(before.nonSky * 0.6);
  });
}

test("settlements: four tiers, counts equal the API's, the heaviest link is a labelled highway", async ({
  page,
}) => {
  await open(page);
  const titles = page.locator(".s3-title");
  await expect(titles).toHaveCount(11);
  for (const tier of ["village", "town", "city", "metropolis"])
    expect(await page.locator(`.s3-title[data-tier='${tier}']`).count()).toBeGreaterThan(0);
  await expect(page.locator(".s3-title[data-tier='metropolis'] .s3-name")).toHaveText("api");
  // Every title's numbers are the API's (the project map at the files level, the 2D map's own data).
  const api = await page.evaluate(async () => {
    const filters = encodeURIComponent(JSON.stringify({ scenario: "large" }));
    const res = await fetch(`/api/view/project-map?level=files&filters=${filters}`);
    const v = (await res.json()) as {
      nodes: { id: string; kind: string; stats?: { functions?: number; files?: number } }[];
      edges: { src: string; dst: string; kind: string; weight: number }[];
    };
    return v;
  });
  const fmt = (v: number) => v.toLocaleString("en-US");
  for (const ws of api.nodes.filter((n) => n.kind === "workspace")) {
    const t = page.locator(`.s3-title[data-settlement="${ws.id}"] .s3-sub`);
    const files = ws.stats?.files ?? 0;
    await expect(t).toHaveText(
      `${fmt(ws.stats?.functions ?? 0)} fn · ${fmt(files)} ${files === 1 ? "file" : "files"}`,
    );
  }
  // The heaviest workspace link is a highway, and its label reads importer → imported with the API's count.
  const heaviest = api.edges
    .filter((e) => e.kind === "imports" && e.src.startsWith("ws:") && e.dst.startsWith("ws:"))
    .sort((a, b) => b.weight - a.weight)[0];
  expect(heaviest?.weight).toBe(640);
  const pill = page.locator(".s3-pill.s3-highway").filter({ hasText: "api → core 640" });
  await expect(pill).toBeVisible();
  await expect(pill.locator(".s3-flow").first()).toHaveText("api → core 640");
  // The legend explains the encodings.
  const howto = page.getByRole("button", { name: "How to read it" });
  if ((await howto.getAttribute("aria-expanded")) !== "true") await howto.click();
  await expect(page.locator(".s3-howto")).toContainText("Settlement");
  await expect(page.locator(".s3-howto")).toContainText("from the importer to the imported");
  await expect(page.locator(".s3-howto")).toContainText("one file");
});

test("settlements: life moves, the pause button stops it, a hidden tab does not animate", async ({
  page,
}) => {
  const host = await open(page);
  await expect(host).toHaveAttribute("data-animating", "true");
  expect(Number(await host.getAttribute("data-vehicles"))).toBeGreaterThan(40);
  const t0 = Number(await host.getAttribute("data-life-t"));
  await page.waitForTimeout(700);
  const t1 = Number(await host.getAttribute("data-life-t"));
  expect(t1).toBeGreaterThan(t0);
  const pause = page.getByTestId("map3d-pause");
  await expect(pause).toHaveText(/Pause life/);
  await pause.click();
  await expect(host).toHaveAttribute("data-playing", "false");
  await expect(pause).toHaveText(/Play life/);
  await expect(pause).toHaveAttribute("aria-pressed", "true");
  const p0 = Number(await host.getAttribute("data-life-t"));
  await page.waitForTimeout(700);
  expect(Number(await host.getAttribute("data-life-t"))).toBe(p0);
  await pause.click();
  await expect(host).toHaveAttribute("data-playing", "true");
  await page.waitForTimeout(500);
  expect(Number(await host.getAttribute("data-life-t"))).toBeGreaterThan(p0);
  // A hidden tab: the loop stops and the clock does not move.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(host).toHaveAttribute("data-animating", "false");
  const h0 = Number(await host.getAttribute("data-life-t"));
  await page.waitForTimeout(700);
  expect(Number(await host.getAttribute("data-life-t"))).toBe(h0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(host).toHaveAttribute("data-animating", "true");
});

test("settlements: reduced motion starts still, with the traffic in place", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const host = await open(page);
  await expect(host).toHaveAttribute("data-playing", "false");
  await expect(host).toHaveAttribute("data-animating", "false");
  await expect(page.getByTestId("map3d-pause")).toHaveText(/Play life/);
  await page.waitForTimeout(600);
  expect(Number(await host.getAttribute("data-life-t"))).toBe(0);
  expect(Number(await host.getAttribute("data-vehicles"))).toBeGreaterThan(40);
  await expect(page.getByLabel(/Auto-rotate/)).toBeDisabled();
});

test("settlements: hovering shows a file or settlement with its counts; clicking selects it", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const titles = JSON.parse((await page.getByTestId("map3d-labels").getAttribute("data-titles")) ?? "[]") as {
    id: string;
    centre: [number, number];
  }[];
  const api = titles.find((t) => t.id === "ws:@acme-platform-monorepo/api");
  if (!api) throw new Error("no api title");
  const box = await canvasBox(page);
  // Somewhere in the metropolis: a building (file) or the plate (settlement).
  let found = "";
  for (const [dx, dy] of [
    [0, 30],
    [40, 40],
    [-40, 50],
    [60, -20],
    [0, 80],
  ] as const) {
    await page.mouse.move(box.x + api.centre[0] + dx, box.y + api.centre[1] + dy);
    const tip = page.locator(".map3d-tip");
    if (await tip.isVisible()) {
      found = (await tip.textContent()) ?? "";
      if (/functions/.test(found)) break;
    }
  }
  expect(found).toMatch(/functions/);
  expect(found).toMatch(/apps\/api\/|api/);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page).toHaveURL(/sel=(file|ws)/);
  // The workspace list selects and flies to a settlement.
  await page.locator(".map3d-legend-row").filter({ hasText: "web" }).first().click();
  await expect(page).toHaveURL(/sel=ws%3A%40acme-platform-monorepo%2Fweb/);
});

test("settlements: screenshots at overview, settlement and street level (light and dark)", async ({
  page,
}) => {
  // Still (reduced motion) so the files do not change from run to run; the traffic is drawn where it stands at t = 0.
  mkdirSync(shots, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: scheme });
    // A fresh page per scheme (the hash alone would keep the street-level camera of the previous round).
    await page.goto("about:blank");
    await open(page);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(shots, `map-3d-settlements-large-${scheme}.png`) });
    await page.locator(".map3d-legend-row").filter({ hasText: "core" }).first().click();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(shots, `map-3d-settlements-large-settlement-${scheme}.png`) });
    await page.getByRole("button", { name: "Street level" }).click();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(shots, `map-3d-settlements-large-street-${scheme}.png`) });
  }
});
