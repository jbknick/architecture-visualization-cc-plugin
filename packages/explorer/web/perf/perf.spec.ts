import { expect, type Page, test } from "playwright/test";

// Synthetic 30,000-function monorepo (src/canvas/synthetic.ts) served by the mock API as view "perf".
// Reports layout time, main-thread responsiveness during layout, and pan/zoom fps at each semantic zoom level.

interface FrameStats {
  frames: number;
  seconds: number;
  fps: number;
  p95FrameMs: number;
  maxFrameMs: number;
}

async function startRecorder(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __gen: number };
    w.__frames = [];
    // A new generation ends the loop of the previous recording, which would otherwise still be running (its last
    // frame is queued when it is stopped) and count every frame twice.
    w.__gen = (w.__gen ?? 0) + 1;
    const gen = w.__gen;
    const tick = (t: number) => {
      if (w.__gen !== gen) return;
      w.__frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopRecorder(page: Page): Promise<FrameStats> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __gen: number };
    w.__gen += 1;
    const f = w.__frames;
    const gaps = f.slice(1).map((t, i) => t - (f[i] as number));
    const sorted = [...gaps].sort((a, b) => a - b);
    const seconds = f.length > 1 ? ((f[f.length - 1] as number) - (f[0] as number)) / 1000 : 0;
    return {
      frames: f.length,
      seconds: Math.round(seconds * 100) / 100,
      fps: seconds > 0 ? Math.round((gaps.length / seconds) * 10) / 10 : 0,
      p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      maxFrameMs: Math.round(sorted[sorted.length - 1] ?? 0),
    };
  });
}

async function interact(page: Page, centre: { x: number; y: number }, zoom: boolean) {
  // About three seconds of dragging and wheel-zooming around the centre of the canvas.
  await page.mouse.move(centre.x, centre.y);
  for (let round = 0; round < 6; round++) {
    await page.mouse.down();
    for (let i = 0; i < 12; i++)
      await page.mouse.move(centre.x + (i + 1) * 12 * (round % 2 ? -1 : 1), centre.y + i * 5);
    await page.mouse.up();
    if (zoom) await page.mouse.wheel(0, round % 2 ? 60 : -60);
    await page.waitForTimeout(120);
  }
}

test("30k-function graph: layout off the main thread, pan/zoom fps", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __gaps: number[]; __readyAt: number };
    w.__gaps = [];
    w.__readyAt = 0;
    let last = 0;
    const tick = (t: number) => {
      if (!w.__readyAt) {
        if (last) w.__gaps.push(t - last);
        last = t;
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    new MutationObserver(() => {
      if (!w.__readyAt && document.querySelector(".gc-sigma[data-ready=true]"))
        w.__readyAt = performance.now();
    }).observe(document, { subtree: true, attributes: true, childList: true });
  });

  const started = Date.now();
  // The layout/timing chip is debug text, shown only with ?debug=1; the report below reads it.
  await page.goto("/?debug=1#/perf");
  const status = page.locator(".gc-status");
  await expect(page.locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 240_000 });
  const readyMs = Date.now() - started;
  const layoutText = (await status.textContent()) ?? "";
  const gaps = await page.evaluate(() => (window as unknown as { __gaps: number[] }).__gaps);
  const sortedGaps = [...gaps].sort((a, b) => a - b);

  const box = await page.locator(".gc-sigma").boundingBox();
  if (!box) throw new Error("no canvas");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const nodes = await page.locator(".gc-sigma").getAttribute("data-nodes");

  const results: Record<string, FrameStats> = {};
  for (const [name, presses] of [
    ["far", 0],
    ["mid", 3],
    ["near", 6],
  ] as const) {
    await page.keyboard.press("0");
    await page.waitForTimeout(500);
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press("+");
      await page.waitForTimeout(260);
    }
    await page.waitForTimeout(400);
    await startRecorder(page);
    await interact(page, centre, false);
    results[`${name} pan`] = await stopRecorder(page);
    await startRecorder(page);
    await interact(page, centre, true);
    results[`${name} pan+zoom`] = await stopRecorder(page);
  }

  const report = {
    nodes: Number(nodes),
    layoutStatus: layoutText,
    readyAfterMs: readyMs,
    mainThreadDuringLoad: {
      frames: gaps.length,
      p95FrameMs: Math.round(sortedGaps[Math.floor(sortedGaps.length * 0.95)] ?? 0),
      maxFrameMs: Math.round(sortedGaps[sortedGaps.length - 1] ?? 0),
    },
    fps: results,
    gl: process.env.PERF_GL ?? "gpu (angle)",
  };
  console.log(`PERF_REPORT ${JSON.stringify(report)}`);
  expect(report.nodes).toBeGreaterThan(30_000);
  expect(results["near pan"]?.frames ?? 0).toBeGreaterThan(5);
  // #135: wheel zoom at far zoom used to place every link's count pill with a slow search (45 fps headless).
  if (process.env.PERF_GL === undefined) expect(results["far pan+zoom"]?.fps ?? 0).toBeGreaterThan(50);
});

// The 3D settlements on the large mock (about 300 buildings, traffic, shadows): the first frame and the frame rate
// with everything moving, idle and while orbiting. The GL renderer string is reported with the numbers.
test("3D settlements: first frame and fps with life running", async ({ page }) => {
  await page.goto("/#/map-3d?scenario=large");
  await expect(page.locator(".map3d[data-ready='true'][data-style='settlements']")).toBeVisible({
    timeout: 120_000,
  });
  const canvas = page.getByTestId("map3d-canvas");
  await expect(canvas).toHaveAttribute("data-first-frame-at", /\d/);
  await page.waitForTimeout(1500);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(2, 2);
  await startRecorder(page);
  await page.waitForTimeout(4000);
  const idle = await stopRecorder(page);
  await startRecorder(page);
  await interact(page, centre, true);
  await page.waitForTimeout(300);
  const orbit = await stopRecorder(page);
  const report = {
    firstFrameAtMs: Number(await canvas.getAttribute("data-first-frame-at")),
    sceneFirstFrameMs: Number(await canvas.getAttribute("data-first-frame-ms")),
    buildMs: Number(await canvas.getAttribute("data-build-ms")),
    avgSceneMs: Number(await canvas.getAttribute("data-frame-ms")),
    vehicles: Number(await canvas.getAttribute("data-vehicles")),
    idle,
    orbit,
    renderer,
    gl: process.env.PERF_GL ?? "gpu (angle)",
  };
  console.log(`PERF_REPORT_SETTLEMENTS ${JSON.stringify(report)}`);
  expect(idle.frames).toBeGreaterThan(20);
  if (process.env.PERF_GL === undefined) {
    expect(idle.fps).toBeGreaterThan(30);
    expect(report.firstFrameAtMs).toBeLessThan(2000);
  }
});

// The 3D code city at the Files level of the large mock (about 900 buildings): orbiting must stay smooth.
// `data-frame-ms` is the CPU time the scene spends per frame (render + label placement); `data-frames` counts frames.
test("3D city, files level: orbiting stays within a frame budget", async ({ page }) => {
  await page.goto("/#/map-3d?level=files&scenario=large&style=city");
  await expect(page.locator(".map3d[data-ready='true']")).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  const canvas = page.getByTestId("map3d-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await startRecorder(page);
  const before = Number(await canvas.getAttribute("data-frames"));
  await interact(page, centre, false);
  await page.waitForTimeout(300);
  const stats = await stopRecorder(page);
  const frames = Number(await canvas.getAttribute("data-frames")) - before;
  const ms = Number(await canvas.getAttribute("data-frame-ms"));
  const gl = process.env.PERF_GL ?? "gpu (angle)";
  console.log(`PERF_REPORT_3D ${JSON.stringify({ ...stats, sceneFrames: frames, avgSceneMs: ms, gl })}`);
  expect(frames).toBeGreaterThan(20);
  // Average CPU time per frame (render submit + labels) under the 16 ms budget; software GL renders far slower.
  if (process.env.PERF_GL === undefined) expect(ms).toBeLessThan(16);
});
