/**
 * M3 regression benchmark (issue #39): explorer performance, determinism, deep links and the cross-origin check.
 *
 * Usage: pnpm build && pnpm tsx evals/bench/m3.ts [<repo>|fixture] [--out <private dir>] [--steps <list>]
 *        [--gl metal|swiftshader] [--headed] [--pan-seconds 10]
 *
 * <repo> is a git repository to index and serve (for example a private TypeScript monorepo); `fixture` (the default)
 * copies fixtures/pnpm-turbo into a throwaway git repo. The repo is only read: its data directory is outside it
 * (CLAUDE_PLUGIN_DATA under --out, else a temp dir), and the script checks `git status` before and after.
 * Steps (comma list, default all): views, perf30k, determinism, deeplinks, security.
 *   views        views 1-5 on <repo>: load time to first render, layout time, fps while panning (pan-seconds each)
 *   perf30k      the synthetic 30,000-function graph (packages/explorer/web/src/canvas/synthetic.ts, served by the mock API)
 *   determinism  two fresh data dirs, layout hashes of the project map, pages and slices
 *   deeplinks    `gantry_open_view` for every view with a focus; the inspector must show that node
 *   security     a page on a second origin requests /api/view/project-map: 403
 * Output: aggregate numbers only (counts, ms, fps, yes/no) on stdout. With --out, the same JSON plus screenshots go
 * to <out>/ (keep that directory outside any public repo). Nothing printed names a path, a file or a symbol of <repo>.
 * Chromium comes from the playwright install of packages/explorer. Default GL is the machine's GPU (ANGLE/Metal);
 * `--gl swiftshader` forces software GL (reproducible anywhere, far slower). `--headed` shows the window.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "../../packages/core/src/index.js";
import { openViewTool } from "../../packages/mcp/src/tools/openView.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cli = join(root, "plugin", "dist", "cli.js");
const requireFromExplorer = createRequire(join(root, "packages", "explorer", "package.json"));
// biome-ignore lint/suspicious/noExplicitAny: playwright is resolved from packages/explorer at run time
const pw = requireFromExplorer("playwright") as any;

// biome-ignore lint/suspicious/noExplicitAny: playwright types are not resolvable from this directory
type Page = any;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);
const positional = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const target = positional ?? "fixture";
const outDir = arg("--out") ? resolve(arg("--out") as string) : undefined;
const steps = new Set((arg("--steps") ?? "views,perf30k,determinism,deeplinks,security").split(","));
const panSeconds = Number(arg("--pan-seconds") ?? 10);
const glMode = arg("--gl") ?? "metal";
const headed = flag("--headed");
const glArgs =
  glMode === "swiftshader"
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    : ["--use-angle=metal", "--ignore-gpu-blocklist"];

const scratch = mkdtempSync(join(tmpdir(), "gantry-m3-"));
if (outDir) mkdirSync(outDir, { recursive: true });
const dataBase = outDir ? join(outDir, "data") : join(scratch, "data");
const children: ChildProcess[] = [];
const cleanups: (() => void)[] = [];
process.on("exit", () => {
  for (const c of children) c.kill("SIGTERM");
  for (const f of cleanups) f();
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => process.stderr.write(`${s}\n`);

// ---- the repo under test ----------------------------------------------------------------------------------------

function prepareRepo(): { repo: string; isFixture: boolean } {
  if (target !== "fixture") return { repo: resolve(target), isFixture: false };
  const repo = join(scratch, "pnpm-turbo");
  cpSync(join(root, "fixtures", "pnpm-turbo"), repo, { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Gantry Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Gantry Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  for (const a of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ])
    execFileSync("git", a, { cwd: repo, env, stdio: "ignore" });
  return { repo, isFixture: true };
}

const gitStatus = (repo: string): string =>
  sha(
    spawnSync("git", ["status", "--porcelain=v1", "-z", "--ignored"], { cwd: repo, encoding: "utf8" }).stdout,
  );

function dataEnv(dataDir: string): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
}

interface Explorer {
  url: string;
  origin: string;
  port: number;
  stop(): void;
}

/** Fresh data dir -> `gantry init` -> the explorer started through `gantry_open_view`'s own logic. */
async function startExplorer(
  repo: string,
  label: string,
): Promise<Explorer & { initMs: number; env: NodeJS.ProcessEnv }> {
  const dataDir = join(dataBase, `${label}-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  const env = dataEnv(dataDir);
  const t0 = Date.now();
  const init = spawnSync("node", [cli, "init"], { cwd: repo, env, encoding: "utf8", maxBuffer: 64 << 20 });
  if (init.status !== 0) throw new Error("gantry init failed");
  const initMs = Date.now() - t0;
  const url = await openUrl(repo, env, { view: "project-map" });
  const u = new URL(url);
  const state = JSON.parse(readFileSync(join(resolvePaths(repo, env).dataDir, "explorer.json"), "utf8")) as {
    pid: number;
  };
  return {
    url,
    origin: u.origin,
    port: Number(u.port),
    initMs,
    env,
    stop: () => {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // already gone
      }
    },
  };
}

/** The `gantry_open_view` tool's own code path (starts or reuses the explorer, builds the tokenised URL). */
async function openUrl(
  repo: string,
  env: NodeJS.ProcessEnv,
  args: { view: string; focus?: string; filters?: Record<string, string> },
): Promise<string> {
  const paths = resolvePaths(repo, env);
  // biome-ignore lint/suspicious/noExplicitAny: the tool context is only partly needed here
  const r = (await openViewTool.run(args, { paths, env } as any)) as { url?: string; error?: string };
  if (!r.url) throw new Error(`gantry_open_view: ${r.error ?? "no url"}`);
  return r.url;
}

/** tsx's esbuild wraps named functions in a `__name` helper that does not exist inside the page. */
const NAME_SHIM = "window.__name = (f) => f;";

async function launch() {
  const browser = await pw.chromium.launch({ headless: !headed, args: glArgs });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (opts?: unknown) => {
    const ctx = await newContext(opts);
    await ctx.addInitScript(NAME_SHIM);
    ctx.setDefaultTimeout(60_000);
    ctx.setDefaultNavigationTimeout(60_000);
    return ctx;
  };
  return browser;
}

async function glRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "no webgl2";
  });
}

// ---- frame recorder and scripted pan / zoom --------------------------------------------------------------------

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
    w.__gen = (w.__gen ?? 0) + 1; // a new generation ends any loop still running from the previous recording
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

/** Drags and wheel-zooms around the centre for `seconds` (zoom = false: drags only). */
async function interact(page: Page, centre: { x: number; y: number }, seconds: number, zoom: boolean) {
  const end = Date.now() + seconds * 1000;
  let round = 0;
  await page.mouse.move(centre.x, centre.y);
  while (Date.now() < end) {
    const dir = round % 2 ? -1 : 1;
    await page.mouse.down();
    for (let i = 0; i < 12 && Date.now() < end; i++)
      await page.mouse.move(centre.x + (i + 1) * 12 * dir, centre.y + i * 5);
    await page.mouse.up();
    if (zoom) {
      for (let i = 0; i < 4 && Date.now() < end; i++) {
        await page.mouse.wheel(0, i % 2 ? 120 : -120);
        await page.waitForTimeout(40);
      }
    }
    round++;
  }
}

async function canvasCentre(page: Page, selector = "[data-testid=graph-canvas]") {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error("no canvas box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const READY = "[data-testid=graph-canvas] [data-ready=true], [data-testid=graph-canvas][data-ready=true]";

// ---- step: views 1-5 --------------------------------------------------------------------------------------------

interface ViewResult {
  view: string;
  nodes: number;
  edges: number;
  firstRenderMs: number | null;
  layoutMs: number | null;
  strategy: string | null;
  fps?: FrameStats;
  note?: string;
}

/** A node id to focus each view on, found through the API like a user would (search / hierarchy), never printed. */
async function pickFocuses(page: Page): Promise<Record<string, string | undefined>> {
  return page.evaluate(async () => {
    const get = async (p: string) => {
      const r = await fetch(p);
      // biome-ignore lint/suspicious/noExplicitAny: ad hoc JSON
      return r.ok ? ((await r.json()) as any) : null;
    };
    const out: Record<string, string | undefined> = {};
    const ws = await get("/api/view/project-map?level=workspaces");
    out["project-map"] = ws?.nodes?.find((n: { kind: string }) => n.kind === "workspace")?.id;
    out["map-3d"] = out["project-map"];
    const sym = await get("/api/view/project-map?level=symbols");
    const syms = (sym?.nodes ?? []).filter((n: { id: string }) => n.id.startsWith("sym:")).slice(0, 400);
    for (const s of syms) {
      const d = await get(`/api/node/${encodeURIComponent(s.id)}`);
      const n = d?.neighbors ? Object.values(d.neighbors as Record<string, unknown[]>).flat().length : 0;
      if (n > 0) {
        out.ego = s.id;
        break;
      }
    }
    out.ego ??= syms[0]?.id;
    const dup = await get("/api/view/duplicates");
    out.duplicates = (dup?.nodes ?? []).find((n: { id: string }) => n.id.startsWith("sym:"))?.id ?? out.ego;
    const pages = await get("/api/view/pages");
    out.pages = (pages?.nodes ?? []).find((n: { id: string }) => n.id.startsWith("route:"))?.id;
    const slices = await get("/api/view/slices");
    out.slices = (slices?.nodes ?? []).find((n: { id: string }) => n.id.startsWith("slice:"))?.id;
    return out;
  });
}

const VIEWS_1_TO_5: { id: string; hash: (focus?: string) => string }[] = [
  { id: "project-map", hash: () => "#/project-map" },
  { id: "ego", hash: (f) => `#/ego?focus=${encodeURIComponent(f ?? "")}` },
  { id: "duplicates", hash: () => "#/duplicates" },
  { id: "pages", hash: () => "#/pages" },
  { id: "slices", hash: () => "#/slices" },
];

async function newPage(browser: Page, origin: string, token?: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("gantry.debug", "1"); // shows the layout strategy and timing chip
    } catch {
      // ignore
    }
  });
  const page = await ctx.newPage();
  if (token) {
    await page.goto(`${origin}/?t=${encodeURIComponent(token)}`);
    await page.waitForLoadState("load");
  }
  return { ctx, page };
}

async function stepViews(ex: Explorer): Promise<ViewResult[]> {
  const browser = await launch();
  const results: ViewResult[] = [];
  const token = new URL(ex.url).searchParams.get("t") ?? undefined;
  const { ctx, page } = await newPage(browser, ex.origin, token);
  const renderer = await glRenderer(page);
  log(`views: GL renderer ${renderer}`);
  const focuses = await pickFocuses(page);
  for (const v of VIEWS_1_TO_5) {
    await page.goto("about:blank");
    const respP = page.waitForResponse(
      (r: { url(): string }) => new URL(r.url()).pathname === `/api/view/${v.id}`,
      { timeout: 120_000 },
    );
    const started = Date.now();
    // A full page load of the view (cached scripts): app start, data request, layout, first drawn frame.
    await page.goto(`${ex.origin}/${v.hash(focuses[v.id])}`);
    const body = (await (await respP).json()) as { nodes?: unknown[]; edges?: unknown[] };
    const r: ViewResult = {
      view: v.id,
      nodes: body.nodes?.length ?? 0,
      edges: body.edges?.length ?? 0,
      firstRenderMs: null,
      layoutMs: null,
      strategy: null,
    };
    // Rendered = the graph canvas is ready (graph views), the overview strip is up (duplicates), or the empty state.
    const marker = r.nodes === 0 ? ".empty-state, .empty" : v.id === "duplicates" ? ".dup-overview" : READY;
    try {
      await page.locator(marker).first().waitFor({ state: "attached", timeout: 180_000 });
      r.firstRenderMs = Date.now() - started;
    } catch {
      r.note = "no render marker within 180 s";
    }
    const chip = await page
      .locator(".gc-status")
      .first()
      .textContent({ timeout: 1500 })
      .catch(() => null);
    const m = chip?.match(/^(.*?)\s·\s(\d+)\sms/);
    if (m) {
      r.strategy = m[1] ?? null;
      r.layoutMs = Number(m[2]);
    }
    if (r.firstRenderMs !== null && (await page.locator(READY).count()) > 0 && r.nodes > 0) {
      const centre = await canvasCentre(page);
      await startRecorder(page);
      await interact(page, centre, panSeconds, true);
      r.fps = await stopRecorder(page);
    }
    if (outDir) {
      mkdirSync(join(outDir, "screenshots"), { recursive: true });
      await page.screenshot({ path: join(outDir, "screenshots", `${v.id}.png`) });
    }
    results.push(r);
    log(
      `views: ${v.id} nodes=${r.nodes} render=${r.firstRenderMs} ms layout=${r.layoutMs} fps=${r.fps?.fps}`,
    );
  }
  await ctx.close();
  await browser.close();
  return results;
}

// ---- step: 30k synthetic ------------------------------------------------------------------------------------------

async function stepPerf30k() {
  const port = String(4300 + Math.floor(Math.random() * 400));
  const tsx = join(root, "node_modules", ".bin", "tsx");
  const mock = spawn(tsx, ["mock/server.ts"], {
    cwd: join(root, "packages", "explorer", "web"),
    env: { ...process.env, MOCK_PORT: port },
    stdio: "ignore",
  });
  children.push(mock);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/meta`)).ok) break;
    } catch {
      await sleep(200);
    }
  }
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
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
  await page.goto(`${base}/?debug=1#/perf`);
  await page.locator(".gc-sigma[data-ready=true]").waitFor({ state: "visible", timeout: 240_000 });
  const readyMs = Date.now() - started;
  const status = (await page.locator(".gc-status").textContent()) ?? "";
  const gaps: number[] = await page.evaluate(() => (window as unknown as { __gaps: number[] }).__gaps);
  const sorted = [...gaps].sort((a, b) => a - b);
  const nodes = Number(await page.locator(".gc-sigma").getAttribute("data-nodes"));
  const renderer = await glRenderer(page);
  const centre = await canvasCentre(page, ".gc-sigma");
  const fps: Record<string, FrameStats> = {};
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
    await interact(page, centre, panSeconds, false);
    fps[`${name} pan`] = await stopRecorder(page);
    await startRecorder(page);
    await interact(page, centre, panSeconds, true);
    fps[`${name} pan+zoom`] = await stopRecorder(page);
  }
  if (outDir) await page.screenshot({ path: join(outDir, "perf30k.png") }); // synthetic data: could be public
  const syn = await (await fetch(`${base}/api/view/perf`)).json();
  const functions = (syn.nodes as { kind: string }[]).filter(
    (n) => n.kind !== "workspace" && n.kind !== "file" && n.kind !== "dir",
  ).length;
  await ctx.close();
  await browser.close();
  mock.kill("SIGTERM");
  return {
    nodes,
    functionNodes: functions,
    layoutStatus: status,
    readyAfterMs: readyMs,
    mainThreadDuringLoad: {
      frames: gaps.length,
      p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      maxFrameMs: Math.round(sorted[sorted.length - 1] ?? 0),
    },
    fps,
    minPanFps: Math.min(
      ...Object.entries(fps)
        .filter(([k]) => k.endsWith(" pan"))
        .map(([, v]) => v.fps),
    ),
    renderer,
    gl: glMode,
    mode: headed ? "headed" : "headless",
  };
}

// ---- step: determinism --------------------------------------------------------------------------------------------

async function layoutHash(page: Page, view: string): Promise<{ hash: string; nodes: number }> {
  const respP = page.waitForResponse(
    (r: { url(): string }) => new URL(r.url()).pathname === `/api/view/${view}`,
    {
      timeout: 120_000,
    },
  );
  await page.evaluate((h: string) => {
    window.location.hash = h;
  }, `#/${view}`);
  const body = (await (await respP).json()) as { nodes?: unknown[] };
  const nodes = body.nodes?.length ?? 0;
  if (nodes === 0) return { hash: "empty", nodes };
  await page.locator(READY).first().waitFor({ state: "attached", timeout: 180_000 });
  await page.waitForTimeout(1500); // layout saved, camera settled
  const probe = await page.evaluate(() => {
    const cands = [
      document.querySelector("[data-testid=graph-canvas]"),
      ...document.querySelectorAll("[data-testid=graph-canvas] [data-ready]"),
    ] as (HTMLElement | null)[];
    for (const el of cands) {
      if (!el) continue;
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      if (el.dataset.probe) return el.dataset.probe;
    }
    return "";
  });
  const hash = probe ? (JSON.parse(probe) as { hash?: string }).hash : undefined;
  return { hash: hash ?? "no-probe", nodes };
}

async function stepDeterminism(repo: string) {
  const views = ["project-map", "pages", "slices"];
  const runs: Record<string, { hash: string; nodes: number }>[] = [];
  const browser = await launch();
  for (let run = 1; run <= 2; run++) {
    const ex = await startExplorer(repo, `det${run}`);
    const token = new URL(ex.url).searchParams.get("t") ?? undefined;
    const { ctx, page } = await newPage(browser, ex.origin, token);
    const got: Record<string, { hash: string; nodes: number }> = {};
    for (const v of views) {
      await page.goto(`${ex.origin}/`);
      got[v] = await layoutHash(page, v);
    }
    // Same data dir, reload: the layout saved by the first load is read back (saved positions).
    const reload: Record<string, string> = {};
    if (run === 1) {
      for (const v of views) {
        await page.goto(`${ex.origin}/`);
        reload[v] = (await layoutHash(page, v)).hash;
      }
    }
    runs.push(got);
    await ctx.close();
    ex.stop();
    await sleep(300);
    if (run === 1) (runs as unknown as { reload?: Record<string, string> }).reload = reload;
  }
  await browser.close();
  const reload = (runs as unknown as { reload?: Record<string, string> }).reload ?? {};
  return views.map((v) => ({
    view: v,
    nodes: runs[0]?.[v]?.nodes ?? 0,
    identicalAcrossFreshDataDirs:
      runs[0]?.[v]?.hash === runs[1]?.[v]?.hash && runs[0]?.[v]?.hash !== "no-probe",
    identicalAfterReload: reload[v] === runs[0]?.[v]?.hash,
    empty: runs[0]?.[v]?.hash === "empty",
  }));
}

// ---- step: deep links ---------------------------------------------------------------------------------------------

async function stepDeepLinks(repo: string) {
  const dataDir = join(dataBase, `deep-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  const env = dataEnv(dataDir);
  const init = spawnSync("node", [cli, "init"], { cwd: repo, env, encoding: "utf8", maxBuffer: 64 << 20 });
  if (init.status !== 0) throw new Error("gantry init failed");
  const t0 = Date.now();
  const first = await openUrl(repo, env, { view: "project-map" }); // starts the explorer through the tool
  const startMs = Date.now() - t0;
  const state = JSON.parse(readFileSync(join(resolvePaths(repo, env).dataDir, "explorer.json"), "utf8")) as {
    pid: number;
  };
  const u = new URL(first);
  const browser = await launch();
  const { ctx, page } = await newPage(browser, u.origin, u.searchParams.get("t") ?? undefined);
  const focuses = await pickFocuses(page);
  await ctx.close();
  const views = ["project-map", "ego", "duplicates", "map-3d", "pages", "slices"];
  const out: {
    view: string;
    focusFound: boolean;
    inspectorShowsFocus: boolean | null;
    inspectorShowsFocusWithSelFilter: boolean | null;
  }[] = [];
  for (const view of views) {
    const focus = focuses[view];
    const row = {
      view,
      focusFound: Boolean(focus),
      inspectorShowsFocus: null as boolean | null,
      inspectorShowsFocusWithSelFilter: null as boolean | null,
    };
    if (focus) {
      for (const withSel of [false, true]) {
        const url = await openUrl(repo, env, {
          view,
          focus,
          ...(withSel ? { filters: { sel: focus } } : {}),
        });
        const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const p = await c.newPage();
        await p.goto(url, { waitUntil: "domcontentloaded" });
        let shown = false;
        try {
          await p
            .locator("aside[aria-label=Inspector] h2")
            .first()
            .waitFor({ state: "visible", timeout: withSel ? 20_000 : 10_000 });
          shown = await p.evaluate(
            (id: string) =>
              document.querySelector("aside[aria-label=Inspector] h2")?.getAttribute("title") === id,
            focus,
          );
        } catch {
          shown = false;
        }
        if (withSel) row.inspectorShowsFocusWithSelFilter = shown;
        else row.inspectorShowsFocus = shown;
        await c.close();
      }
    }
    out.push(row);
    log(
      `deeplinks: ${view} focus=${row.focusFound} inspector(focus)=${row.inspectorShowsFocus} inspector(focus+sel)=${row.inspectorShowsFocusWithSelFilter}`,
    );
  }
  await browser.close();
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // gone
  }
  return { explorerStartMs: startMs, rows: out };
}

// ---- step: cross-origin 403 ---------------------------------------------------------------------------------------

/** Statuses the network stack saw for /api/view/project-map on `page` (CDP sees responses a CORS check hides from the page). */
async function watchStatuses(ctx: Page, page: Page): Promise<(number | string)[]> {
  const seen: (number | string)[] = [];
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", (e: { response: { url: string; status: number } }) => {
    if (new URL(e.response.url).pathname === "/api/view/project-map") seen.push(e.response.status);
  });
  cdp.on("Network.loadingFailed", (e: { errorText: string; corsErrorStatus?: { corsError: string } }) => {
    seen.push(`failed: ${e.errorText} ${e.corsErrorStatus?.corsError ?? ""}`.trim());
  });
  return seen;
}

async function stepSecurity(repo: string) {
  const ex = await startExplorer(repo, "sec");
  const token = new URL(ex.url).searchParams.get("t") as string;
  const attacker = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>other origin</title><body>other origin</body>");
  });
  await new Promise<void>((ok) => attacker.listen(0, "127.0.0.1", ok));
  const aport = (attacker.address() as { port: number }).port;
  const browser = await launch();
  const ctx = await browser.newContext();
  // The browser holds a valid session for the explorer: its cookie is sent from any 127.0.0.1 page (same site).
  const home = await ctx.newPage();
  await home.goto(`${ex.origin}/?t=${encodeURIComponent(token)}`);
  const control = await home.evaluate(async () => (await fetch("/api/view/project-map")).status);
  const target = `${ex.origin}/api/view/project-map`;

  const run = async (host: string, mode: "cors" | "no-cors") => {
    const page = await ctx.newPage();
    const seen = await watchStatuses(ctx, page);
    await page.goto(`http://${host}:${aport}/`);
    const result = await page.evaluate(
      async ([t, m]: [string, string]) => {
        try {
          const r = await fetch(t, { mode: m as RequestMode, credentials: "include" });
          return { threw: false, type: r.type, readableStatus: r.status };
        } catch {
          return { threw: true, type: "error", readableStatus: null };
        }
      },
      [target, mode],
    );
    await page.waitForTimeout(500);
    await page.close();
    return { networkStatus: seen.at(-1) ?? null, ...result };
  };
  const cors = await run("127.0.0.1", "cors");
  const noCors = await run("127.0.0.1", "no-cors");
  const otherSite = await run("localhost", "cors");
  // What the server answers to the request the browser sent (the page itself cannot read a cross-origin status):
  // same cookie jar, Origin header of the second origin.
  const foreign = await ctx.request.get(target, { headers: { origin: `http://127.0.0.1:${aport}` } });
  const foreignStatus = foreign.status();
  const sameOrigin = await ctx.request.get(target, { headers: { origin: ex.origin } });
  await browser.close();
  attacker.close();
  ex.stop();
  return {
    sameOriginControlStatus: control,
    sameOriginHeaderStatus: sameOrigin.status(),
    serverStatusForSecondOriginRequest: foreignStatus,
    secondOriginCorsFetch: cors,
    secondOriginNoCorsFetch: noCors,
    secondSiteLocalhostCorsFetch: otherSite,
  };
}

// ---- main --------------------------------------------------------------------------------------------------------

async function main() {
  if (!existsSync(cli)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  const { repo, isFixture } = prepareRepo();
  const before = gitStatus(repo);
  const report: Record<string, unknown> = {
    target: isFixture ? "fixture pnpm-turbo" : "private repo (path not recorded)",
    platform: `${process.platform} ${process.arch}`,
    mode: headed ? "headed" : "headless",
    gl: glMode,
    panSeconds,
  };
  if (steps.has("views")) {
    const ex = await startExplorer(repo, "views");
    const meta = (await (
      await fetch(`${ex.origin}/api/meta`, {
        headers: { "x-gantry-token": new URL(ex.url).searchParams.get("t") as string },
      })
    ).json()) as { counts: Record<string, number> };
    const est = spawnSync("node", [cli, "init", "--estimate"], { cwd: repo, env: ex.env, encoding: "utf8" });
    const fn = /function-like:\s+([\d,]+)/.exec(est.stdout)?.[1];
    report.index = {
      initMs: ex.initMs,
      ...meta.counts,
      functionLike: fn ? Number(fn.replaceAll(",", "")) : null,
    };
    report.views = await stepViews(ex);
    ex.stop();
  }
  if (steps.has("perf30k")) report.perf30k = await stepPerf30k();
  if (steps.has("determinism")) report.determinism = await stepDeterminism(repo);
  if (steps.has("deeplinks")) report.deepLinks = await stepDeepLinks(repo);
  if (steps.has("security")) report.security = await stepSecurity(repo);
  report.targetTreeUnchanged = gitStatus(repo) === before;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outDir) writeFileSync(join(outDir, `m3-${isFixture ? "fixture" : "repo"}.json`), text);
  process.stdout.write(text);
}

main().then(
  () => process.exit(0),
  (e) => {
    log(`m3 failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
