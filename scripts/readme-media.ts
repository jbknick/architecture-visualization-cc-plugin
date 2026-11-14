// Regenerates the README's screenshots and GIF in docs/readme/ from the running app on PUBLIC data only:
//   - the real server (`gantry map`) on a temp copy of fixtures/pnpm-turbo, and
//   - the explorer's mock API with its synthetic `scenario=large` / `scenario=hub` / `scenario=dups` data (web/mock).
// Never point this at a private repo. Run: `pnpm build && pnpm readme:media` (or `pnpm tsx scripts/readme-media.ts`).
// Options: --only <name,name>  regenerate just those PNGs (names without .png, or `gif`).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import gifenc from "gifenc";

// playwright is an explorer devDependency; resolve it from there rather than adding a second copy.
const require = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), "../packages/explorer/package.json"),
);
const { chromium } = require("playwright") as typeof import("playwright");
type Page = import("playwright").Page;
type Browser = import("playwright").Browser;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/readme");
const cliJs = join(root, "plugin/dist/cli.js");
const only = (() => {
  const i = process.argv.indexOf("--only");
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ? new Set(v.split(",")) : undefined;
})();
const want = (name: string) => !only || only.has(name);

const GL_ARGS = [
  ["--use-gl=angle", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
  ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
];

async function launch(): Promise<Browser> {
  for (const args of GL_ARGS) {
    const browser = await chromium.launch({ args });
    const page = await browser.newPage();
    const ok = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
    await page.close();
    if (ok) {
      console.log(`WebGL ok with ${args[1]}`);
      return browser;
    }
    await browser.close();
  }
  throw new Error("no WebGL in headless Chromium");
}

function sh(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  return execFileSync(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).toString();
}

/** Mock explorer (built UI plus synthetic API). */
async function startMock(port: number): Promise<ChildProcess> {
  const child = spawn("pnpm", ["exec", "tsx", "web/mock/server.ts"], {
    cwd: join(root, "packages/explorer"),
    env: { ...process.env, MOCK_PORT: String(port) },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/meta`)).ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("mock server did not start");
}

/** Real server on a temp copy of fixtures/pnpm-turbo. Returns the URL (with its token) and a cleanup. */
async function startReal(): Promise<{ url: string; stop: () => void }> {
  const tmp = mkdtempSync(join(tmpdir(), "gantry-readme-"));
  const repo = join(tmp, "pnpm-turbo");
  cpSync(join(root, "fixtures/pnpm-turbo"), repo, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(tmp, "home"),
    CLAUDE_PLUGIN_DATA: join(tmp, "data"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Example",
    GIT_AUTHOR_EMAIL: "example@example.com",
    GIT_COMMITTER_NAME: "Example",
    GIT_COMMITTER_EMAIL: "example@example.com",
    // Fixed dates, so the commit sha shown in the top bar is the same on every run.
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  sh("git", ["init", "-q"], { cwd: repo, env });
  sh("git", ["add", "-A"], { cwd: repo, env });
  sh("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env });
  sh("node", [cliJs, "init"], { cwd: repo, env });
  const server = spawn("node", [cliJs, "map", "--no-open"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string>((ok, fail) => {
    let buf = "";
    server.stdout?.on("data", (c: Buffer) => {
      buf += c.toString();
      const line = buf.split("\n")[0];
      if (buf.includes("\n") && line) ok(line);
    });
    server.on("exit", (code) => fail(new Error(`gantry map exited with ${code}`)));
  });
  return {
    url,
    stop: () => {
      server.kill("SIGINT");
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser: Browser, scheme: "light" | "dark" = "light"): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: scheme,
    reducedMotion: "no-preference",
  });
  return ctx.newPage();
}

/** Indexed (256-colour) PNG of a screenshot: used only when the true-colour PNG is over the size limit. */
async function indexedPng(page: Page, png: Buffer): Promise<Buffer> {
  const helper = await page.context().newPage();
  const b64 = await helper.evaluate(async (data) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = "";
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
    return btoa(s);
  }, png.toString("base64"));
  await helper.close();
  const rgba = new Uint8ClampedArray(Buffer.from(b64, "base64"));
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const palette = gifenc.quantize(rgba, 256, { format: "rgb565" });
  const index = gifenc.applyPalette(rgba, palette, "rgb565");
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++)
    Buffer.from(index.buffer, index.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const plte = Buffer.concat(
    palette.map((c) => Buffer.from([c[0] as number, c[1] as number, c[2] as number])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function save(page: Page, name: string) {
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.png`);
  let png = await page.screenshot();
  let note = "";
  if (png.length > 400 * 1024) {
    png = await indexedPng(page, png);
    note = " (256 colours)";
  }
  writeFileSync(file, png);
  const kb = Math.round(statSync(file).size / 1024);
  console.log(`${name}.png ${kb} KB${note}`);
  if (kb > 400) throw new Error(`${name}.png is ${kb} KB (limit 400)`);
}

const MAP = "http://127.0.0.1";
const canvas = (page: Page) => page.getByTestId("graph-canvas");
const surface = (page: Page) => canvas(page).locator(".gc-sigma");

async function openMap2d(page: Page, base: string, level: string, extra = "") {
  await page.goto(`${base}/#/project-map?level=${level}${extra}`);
  await page.locator(".gc-sigma[data-ready=true]").waitFor({ timeout: 30_000 });
  if (level === "dirs") await page.locator(".gc-sigma[data-mosaic=true]").waitFor({ timeout: 30_000 });
  await page.locator(".gc-sigma[data-ready=true]").waitFor();
  await page.mouse.move(2, 2);
  await sleep(800);
}

async function zoomTo(page: Page, id: string) {
  await canvas(page).evaluate((el, nodeId) => {
    el.dispatchEvent(new CustomEvent("gantry:zoom-to", { detail: { id: nodeId } }));
  }, id);
  await sleep(1000);
  await page.mouse.move(2, 2);
}

async function openCity(page: Page, base: string, level: string, extra = "") {
  await page.goto(`${base}/#/map-3d?level=${level}${extra}`);
  await page.getByTestId("map3d-canvas").locator("canvas").waitFor();
  await page.locator(".map3d[data-ready='true'][data-style='city']").waitFor({ timeout: 30_000 });
  await sleep(1800);
}

async function openEgo(page: Page, url: string) {
  await page.goto(url);
  await canvas(page).locator("canvas[data-ready=true]").waitFor({ timeout: 30_000 });
  await page.mouse.move(2, 2);
  await sleep(900);
}

/** Zoom into the biggest workspace of the large mock, one more step, and pan into a folder (as the e2e does). */
async function zoomedFiles(page: Page) {
  await zoomTo(page, "ws:@acme-platform-monorepo/api");
  const probe = JSON.parse(
    await surface(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as { regions: { id: string; x: number; y: number }[] };
  const api = probe.regions.find((r) => r.id === "ws:@acme-platform-monorepo/api");
  const box = await surface(page).boundingBox();
  if (!api || !box) throw new Error("api box missing");
  await page.mouse.move(box.x + api.x + 10, box.y + api.y + 10);
  await page.mouse.wheel(0, -420);
  await sleep(1000);
  await page.mouse.move(box.x + 700, box.y + 520);
  await page.mouse.down();
  await page.mouse.move(box.x + 560, box.y + 250, { steps: 10 });
  await page.mouse.up();
  await page.mouse.move(2, 2);
  await sleep(2000);
  await canvas(page).getByTestId("map-crumb").waitFor();
}

async function stills(browser: Browser, mockBase: string) {
  const page = await newPage(browser);
  if (want("project-map-workspaces")) {
    await openMap2d(page, mockBase, "workspaces", "&scenario=large");
    await save(page, "project-map-workspaces");
  }
  if (want("project-map-folders")) {
    await openMap2d(page, mockBase, "dirs", "&scenario=large");
    await save(page, "project-map-folders");
  }
  if (want("project-map-files-zoomed")) {
    await openMap2d(page, mockBase, "files", "&scenario=large");
    await zoomedFiles(page);
    await save(page, "project-map-files-zoomed");
  }
  if (want("city-workspaces")) {
    await openCity(page, mockBase, "workspaces", "&scenario=large");
    await save(page, "city-workspaces");
  }
  if (want("city-files")) {
    await openCity(page, mockBase, "files", "&scenario=large");
    await save(page, "city-files");
  }
  if (want("duplicates")) {
    // The mock's `dups` scenario: 22 groups of copies over 7 made-up workspaces, first group open.
    await page.goto(`${mockBase}/#/duplicates?scenario=dups`);
    await page
      .getByRole("list", { name: "Duplicate groups, biggest first" })
      .getByRole("button")
      .first()
      .waitFor();
    await page
      .getByRole("region", { name: /Compare/ })
      .getByText(/differing line/)
      .waitFor();
    await page.mouse.move(2, 2);
    await sleep(500);
    await save(page, "duplicates");
  }
  if (want("caller-graph")) {
    // The mock's `hub` scenario: one shared component with 221 callers, grouped by folder.
    const { hubFocus } = await import("../packages/explorer/web/mock/hubEgo.ts");
    await openEgo(page, `${mockBase}/#/ego?focus=${encodeURIComponent(hubFocus)}&scenario=hub`);
    await save(page, "caller-graph");
  }
  await page.context().close();

  if (want("project-map-dark")) {
    const dark = await newPage(browser, "dark");
    await openMap2d(dark, mockBase, "workspaces", "&scenario=large");
    await save(dark, "project-map-dark");
    await dark.context().close();
  }
}

async function fixtureStills(browser: Browser) {
  if (!want("fixture-project-map") && !want("fixture-caller-graph")) return;
  const real = await startReal();
  try {
    const page = await newPage(browser);
    const base = real.url.replace(/#.*$/, "");
    if (want("fixture-project-map")) {
      await page.goto(real.url);
      await page.locator(".gc-sigma[data-ready=true]").waitFor({ timeout: 30_000 });
      await page
        .getByRole("radiogroup", { name: "Detail level" })
        .getByRole("radio", { name: "Files" })
        .click();
      await page.locator(".gc-sigma[data-ready=true]").waitFor();
      await page.mouse.move(2, 2);
      await sleep(1000);
      await save(page, "fixture-project-map");
    }
    if (want("fixture-caller-graph")) {
      await page.goto(real.url);
      await page.getByRole("tab", { name: "Function ego graph" }).click();
      await page.keyboard.press("ControlOrMeta+k");
      const search = page.getByRole("combobox", { name: "Search symbols" });
      await search.fill("Button");
      await page
        .getByRole("option", { name: /Button/ })
        .first()
        .waitFor();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Graph" }).click();
      await canvas(page).locator("canvas[data-ready=true]").waitFor({ timeout: 30_000 });
      await page.mouse.move(2, 2);
      await sleep(1000);
      await save(page, "fixture-caller-graph");
    }
    void base;
    await page.context().close();
  } finally {
    real.stop();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// GIF: switch the 2D levels, then orbit the 3D city. Frames are PNG screenshots, downscaled to 900 px wide in a
// helper page (canvas drawImage) and encoded with gifenc (pure JS, no ffmpeg).

const GIF_W = 900;
const GIF_H = 562;

interface Frame {
  png: Buffer;
  delay: number;
}

async function gif(browser: Browser, mockBase: string) {
  const page = await newPage(browser);
  const frames: Frame[] = [];
  const snap = async (delay = 100, repeat = 1) => {
    const png = await page.screenshot();
    for (let i = 0; i < repeat; i++) frames.push({ png, delay });
  };

  // 2D: workspaces -> folders -> files -> zoom into the biggest workspace.
  await openMap2d(page, mockBase, "workspaces", "&scenario=large");
  await snap(1100);
  const levels = page.getByRole("radiogroup", { name: "Detail level" });
  await levels.getByRole("radio", { name: "Folders" }).click();
  await page.locator(".gc-sigma[data-mosaic=true]").waitFor({ timeout: 30_000 });
  await page.mouse.move(2, 2);
  await sleep(900);
  await snap(1100);
  await levels.getByRole("radio", { name: "Files" }).click();
  await page.locator(".gc-sigma[data-ready=true]").waitFor();
  await page.mouse.move(2, 2);
  await sleep(900);
  await snap(900);
  // A smooth zoom: a few frames while the camera flies into the biggest workspace.
  await canvas(page).evaluate((el) => {
    el.dispatchEvent(new CustomEvent("gantry:zoom-to", { detail: { id: "ws:@acme-platform-monorepo/api" } }));
  });
  for (let i = 0; i < 4; i++) {
    await sleep(120);
    await snap(100);
  }
  await sleep(700);
  await page.mouse.move(2, 2);
  await snap(800);

  // 3D city: files level, then a slow orbit by dragging the scene.
  await openCity(page, mockBase, "files", "&scenario=large");
  await snap(800);
  const box = await page.getByTestId("map3d-canvas").boundingBox();
  if (!box) throw new Error("3D canvas has no box");
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.55;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + i * 8, cy - i * 0.8);
    await sleep(60);
    await snap(100);
  }
  await page.mouse.up();
  await snap(700);
  await page.context().close();

  // Downscale in a helper page and read the RGBA back as base64.
  const helper = await (await browser.newContext()).newPage();
  const encoder = gifenc.GIFEncoder();
  const cache = new Map<Buffer, Uint8ClampedArray>();
  for (const f of frames) {
    let rgba = cache.get(f.png);
    if (!rgba) {
      const b64 = await helper.evaluate(
        async ({ data, w, h }) => {
          const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
          const c = new OffscreenCanvas(w, h);
          const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
          g.imageSmoothingQuality = "high";
          g.drawImage(bmp, 0, 0, w, h);
          const px = g.getImageData(0, 0, w, h).data;
          let s = "";
          for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
          return btoa(s);
        },
        { data: f.png.toString("base64"), w: GIF_W, h: GIF_H },
      );
      rgba = new Uint8ClampedArray(Buffer.from(b64, "base64"));
      cache.set(f.png, rgba);
    }
    const palette = gifenc.quantize(rgba, 256, { format: "rgb444" });
    const index = gifenc.applyPalette(rgba, palette, "rgb444");
    encoder.writeFrame(index, GIF_W, GIF_H, { palette, delay: f.delay });
  }
  encoder.finish();
  mkdirSync(out, { recursive: true });
  const file = join(out, "explorer-tour.gif");
  writeFileSync(file, encoder.bytes());
  const mb = statSync(file).size / 1048576;
  const secs = frames.reduce((s, f) => s + f.delay, 0) / 1000;
  console.log(`explorer-tour.gif ${mb.toFixed(2)} MB, ${frames.length} frames, ${secs.toFixed(1)} s`);
  if (mb > 6) throw new Error("GIF is over 6 MB");
}

async function main() {
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  const port = Number(process.env.MOCK_PORT ?? 4431);
  const mock = await startMock(port);
  const mockBase = `${MAP}:${port}`;
  const browser = await launch();
  try {
    await stills(browser, mockBase);
    await fixtureStills(browser);
    if (want("gif")) await gif(browser, mockBase);
  } finally {
    await browser.close();
    mock.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
