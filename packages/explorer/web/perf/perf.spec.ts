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
    const w = window as unknown as { __frames: number[]; __rec: boolean };
    w.__frames = [];
    w.__rec = true;
    const tick = (t: number) => {
      if (!w.__rec) return;
      w.__frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopRecorder(page: Page): Promise<FrameStats> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rec: boolean };
    w.__rec = false;
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
});
