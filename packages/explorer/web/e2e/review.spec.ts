import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");
const shots = join(repoRoot, "docs/milestones/screenshots");

// The review view (#44) against the REAL server on public data: fixtures/pnpm-turbo in a temp git repo, indexed at
// `main`, with a `feature` branch that adds `size` to Button's props and a new slugifyAll. Needs `pnpm build` first.
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });

const BUTTON = "sym:packages/ui/src/button.tsx#Button";
const problems: string[] = [];
test.beforeEach(({ page }) => {
  page.on("console", (m) => {
    if (/content security policy|violat/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
});
test.afterEach(() => {
  expect(problems, "console CSP violations / page errors").toEqual([]);
});

let tmp = "";
let server: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  tmp = mkdtempSync(join(tmpdir(), "gantry-e2e-review-"));
  const repo = join(tmp, "pnpm-turbo");
  cpSync(join(repoRoot, "fixtures/pnpm-turbo"), repo, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(tmp, "home"),
    CLAUDE_PLUGIN_DATA: join(tmp, "data"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Gantry Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Gantry Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  git("checkout", "-q", "-b", "feature");
  const button = join(repo, "packages/ui/src/button.tsx");
  const widened = readFileSync(button, "utf8").replace(
    "{ label, onClick }: { label: string; onClick?: () => void }",
    "{ label, onClick, size }: { label: string; onClick?: () => void; size?: number }",
  );
  // Chip: a second change in Button's file, with no consumers.
  writeFileSync(
    button,
    `${widened}\nexport function Chip({ text }: { text: string }) {\n  return <i>{text}</i>;\n}\n`,
  );
  const slug = join(repo, "packages/utils/src/slug.ts");
  writeFileSync(
    slug,
    `${readFileSync(slug, "utf8")}export function slugifyAll(xs: string[]): string[] {\n  return xs.map(slugify);\n}\n`,
  );
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  // A `chain` branch (#173): getPost's body changes. app.ts calls it and the db barrel re-exports it (directly
  // affected); the api barrel imports app.ts, router.ts and the post route import the db barrel (potentially).
  git("checkout", "-q", "main");
  git("checkout", "-q", "-b", "chain");
  const queries = join(repo, "packages/db/src/queries.ts");
  writeFileSync(
    queries,
    readFileSync(queries, "utf8").replace("where(eq(posts.id, id))", "where(eq(posts.id, id)).limit(1)"),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "chain");
  git("checkout", "-q", "main");
  execFileSync("node", [cliJs, "init"], { cwd: repo, env, stdio: "ignore", timeout: 100_000 });

  server = spawn("node", [cliJs, "map", "--no-open"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((ok, fail) => {
    let out = "";
    server?.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) ok(line);
    });
    server?.on("exit", (code) => fail(new Error(`gantry map exited with ${code}`)));
  });
  base = url.replace(/#.*$/, "");
});

test.afterAll(() => {
  server?.kill("SIGINT");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function open(page: Page, hash: string) {
  mkdirSync(shots, { recursive: true });
  await page.goto(`${base}${hash}`);
  await expect(page.locator("[data-testid=review-canvas][data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
}

const BUTTON_FILE = "file:packages/ui/src/button.tsx";
const HOME_FILE = "file:apps/web/src/routes/index.tsx";
const HOME = "sym:apps/web/src/routes/index.tsx#HomePage";

interface ReviewProbe {
  positions: Record<string, [number, number]>;
  viewport: { w: number; h: number };
  scale: number;
  fitScale: number;
  reviewRects: { id: string; x: number; y: number; w: number; h: number }[];
  review: {
    changed: { id: string; change: string }[];
    affected: { id: string; hop: number }[];
    drawn: {
      changed: number;
      affected: number;
      faded: number;
      links: { src: string; dst: string; change: string; colour: string; soft?: boolean }[];
      named: string[];
    } | null;
  } | null;
}

const surface = (page: Page) => page.getByTestId("graph-canvas").locator(".gc-sigma");

/** Waits for the 2D map to settle (laid out, camera still) and reads its probe. */
async function probe2d(page: Page): Promise<ReviewProbe> {
  const box = page.locator("[data-testid=graph-canvas] .gc-sigma[data-ready=true]");
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box).not.toHaveAttribute("data-moving", "true");
  return JSON.parse(
    await surface(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe", { detail: { positions: true } }));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as ReviewProbe;
}

/** The left panel's rows and the legend stay inside their boxes. */
async function expectTidy(page: Page) {
  const out = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll(".topbar .tab-strip, .topbar .search, .topbar .repo-name")) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1) bad.push(`top bar item runs off the edge: ${el.className}`);
    }
    // The tabs scroll sideways inside their strip (#48: a dozen views). Every tab is visible, or the strip shows a
    // scroll button on the side it is hidden; the open view's tab is always fully visible.
    const nav = document.querySelector(".topbar .tab-strip > nav")?.getBoundingClientRect();
    const hasLeft = document.querySelector(".tab-scroll.left") !== null;
    const hasRight = document.querySelector(".tab-scroll.right") !== null;
    for (const tab of document.querySelectorAll(".topbar .tab")) {
      const r = tab.getBoundingClientRect();
      if (!nav) break;
      const hiddenLeft = r.left < nav.left - 1;
      const hiddenRight = r.right > nav.right + 1;
      if (tab.getAttribute("aria-selected") === "true" && (hiddenLeft || hiddenRight))
        bad.push(`the open view's tab is out of sight: ${tab.textContent}`);
      if ((hiddenLeft && !hasLeft) || (hiddenRight && !hasRight))
        bad.push(`a tab is hidden with no way to reach it: ${tab.textContent}`);
    }
    const canvas = document.querySelector("[data-testid=review-canvas]")?.getBoundingClientRect();
    const legend = document.querySelector(".rv-legend")?.getBoundingClientRect();
    if (canvas && legend && (legend.right > canvas.right + 1 || legend.bottom > canvas.bottom + 1))
      bad.push("legend leaves the canvas");
    for (const t of document.querySelectorAll(".rv-ring-label")) {
      const r = t.getBoundingClientRect();
      if (canvas && (r.left < canvas.left - 1 || r.right > canvas.right + 1))
        bad.push(`ring label leaves the canvas: ${t.textContent}`);
    }
    const left = document.querySelector("aside.left")?.getBoundingClientRect();
    for (const row of document.querySelectorAll(".rv-item")) {
      const r = row.getBoundingClientRect();
      if (left && r.right > left.right + 1) bad.push(`row leaves the panel: ${row.textContent}`);
    }
    return bad;
  });
  expect(out).toEqual([]);
}

test("2D map: Button's file coloured by its change, caller files tinted, file-to-file lines, the rest faded; risk on the left", async ({
  page,
}) => {
  const t0 = Date.now();
  await open(page, "#/review?range=main...feature");
  const canvas = page.getByTestId("review-canvas");
  await expect(canvas).toHaveAttribute("data-mode", "map");
  await expect(canvas).toHaveAttribute("data-map", "2d");
  const p = await probe2d(page);
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(p.review?.changed).toContainEqual({ id: BUTTON_FILE, change: "signature" });
  expect(p.review?.affected).toContainEqual({ id: HOME_FILE, hop: 1 });
  const drawn = p.review?.drawn;
  expect(drawn?.changed).toBeGreaterThan(0);
  expect(drawn?.affected).toBeGreaterThan(0);
  expect(drawn?.faded).toBeGreaterThan(drawn?.changed ?? 0);
  expect(drawn?.links).toContainEqual(
    expect.objectContaining({ src: HOME_FILE, dst: BUTTON_FILE, change: "signature" }),
  );
  for (const l of drawn?.links ?? [])
    if (!l.soft) expect([BUTTON_FILE, "file:packages/utils/src/slug.ts"]).toContain(l.dst);

  await expect(page.getByRole("complementary", { name: "Review legend" })).toContainText("Signature changed");
  const risk = page.getByRole("region", { name: "Risk" });
  await expect(risk.getByText("Medium risk")).toBeVisible();
  await expect(risk.getByText("+30 signature changed on an exported symbol")).toBeVisible();
  await expect(page.getByRole("region", { name: "Changed files" }).getByRole("button")).toHaveCount(2);
  await expectTidy(page);
  await page.screenshot({ path: join(shots, "review-map-fixture.png") });
});

const QUERIES = "file:packages/db/src/queries.ts";
const DB_INDEX = "file:packages/db/src/index.ts";
const APP = "file:apps/api/src/app.ts";
const API_INDEX = "file:apps/api/src/index.ts";
const POST_ROUTE = "file:apps/web/src/routes/posts.$postId.tsx";

test("secondary chain (#173): nothing selected, hop-2 consumers tinted with dashed lines to the step nearer; Show filters them", async ({
  page,
}) => {
  await open(page, "#/review?range=main...chain");
  const p = await probe2d(page);
  expect(p.review?.changed).toContainEqual({ id: QUERIES, change: "modified" });
  expect(p.review?.affected).toContainEqual({ id: APP, hop: 1 });
  expect(p.review?.affected).toContainEqual({ id: API_INDEX, hop: 2 });
  const links = p.review?.drawn?.links ?? [];
  expect(links).toContainEqual(expect.objectContaining({ src: APP, dst: QUERIES, change: "modified" }));
  expect(links.find((l) => l.src === APP && l.dst === QUERIES)?.soft).toBeUndefined();
  expect(links).toContainEqual(expect.objectContaining({ src: API_INDEX, dst: APP, soft: true }));
  expect(links).toContainEqual(
    expect.objectContaining({ src: "file:apps/api/src/router.ts", dst: DB_INDEX, soft: true }),
  );
  // Dashed lines are drawn first, under the solid ones.
  const firstSolid = links.findIndex((l) => !l.soft);
  expect(links.slice(firstSolid).every((l) => !l.soft)).toBe(true);
  // Affected files with room carry their names (the api files hold no functions, so they have no area to name).
  expect(p.review?.drawn?.named).toEqual(expect.arrayContaining([DB_INDEX, POST_ROUTE]));
  await expect(page.getByTestId("review-totals")).toHaveText(
    /^Directly affected 2 · Potentially affected [3-9]$/,
  );
  const legend = page.getByRole("complementary", { name: "Review legend" });
  await expect(legend).toContainText("Potentially affected");
  await expect(legend).toContainText("Dashed: one step nearer");

  // Hover: the name, the hop and the path to the change.
  const r = p.reviewRects.find((x) => x.id === POST_ROUTE) as { x: number; y: number; w: number; h: number };
  const box = (await surface(page).boundingBox()) as { x: number; y: number };
  await page.mouse.move(box.x + r.x + r.w / 2, box.y + r.y + r.h / 2);
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("Review: potentially affected (hop 2)");
  await expect(tip).toContainText("Path to the change: posts.$postId.tsx → index.ts → queries.ts");
  await page.mouse.move(2, 2);
  await expectTidy(page);

  // Show: + Directly affected drops the hop-2 tint and the dashed lines; Changed only drops the consumers.
  const show = page.getByRole("radiogroup", { name: "Show" });
  await expect(show.getByRole("radio", { name: "+ Potentially affected" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await show.getByRole("radio", { name: "+ Directly affected" }).click();
  await expect(page).toHaveURL(/show=direct/);
  await expect
    .poll(async () => (await probe2d(page)).review?.affected.some((a) => a.id === API_INDEX))
    .toBe(false);
  const direct = await probe2d(page);
  expect(direct.review?.affected).toContainEqual({ id: APP, hop: 1 });
  expect(direct.review?.drawn?.links.some((l) => l.soft)).toBe(false);
  expect(direct.review?.drawn?.links).toContainEqual(expect.objectContaining({ src: APP, dst: QUERIES }));
  await show.getByRole("radio", { name: "Changed only" }).click();
  await expect(page).toHaveURL(/show=changed/);
  await expect.poll(async () => (await probe2d(page)).review?.affected.length).toBe(0);
  expect((await probe2d(page)).review?.drawn?.links).toEqual([]);
});

test("secondary chain in 3D (#173): the hop-2 building is tinted and joined by a dashed arc; Show filters it", async ({
  page,
}) => {
  await open(page, "#/review?range=main...chain&map=3d");
  await expect(page.locator(".map3d[data-ready='true'][data-style='settlements']")).toBeVisible({
    timeout: 30_000,
  });
  const host = page.getByTestId("map3d-canvas");
  await expect(host).toHaveAttribute("data-review", /queries/, { timeout: 20_000 });
  type Probe3d = {
    affected: string[];
    hops: Record<string, number>;
    links: { src: string; dst: string; change: string; soft?: boolean }[];
  };
  const read = async () => JSON.parse((await host.getAttribute("data-review")) ?? "null") as Probe3d;
  const review = await read();
  expect(review.affected).toContain(API_INDEX);
  expect(review.hops[API_INDEX]).toBe(2);
  expect(review.hops[APP]).toBe(1);
  expect(review.links).toContainEqual({ src: API_INDEX, dst: APP, change: "modified", soft: true });
  expect(review.links).toContainEqual({ src: APP, dst: QUERIES, change: "modified" });
  await page.getByTestId("map3d-pause").click();
  await page.waitForTimeout(400);
  await page
    .getByRole("radiogroup", { name: "Show" })
    .getByRole("radio", { name: "+ Directly affected" })
    .click();
  await expect(page).toHaveURL(/show=direct/);
  await expect.poll(async () => (await read()).affected.includes(API_INDEX)).toBe(false);
  expect((await read()).links.some((l) => l.soft)).toBe(false);
});

test("positions: every node of the review map sits exactly where it sits on the plain project map", async ({
  page,
}) => {
  for (const level of ["files", "symbols"]) {
    await open(page, `#/review?range=main...feature&level=${level}`);
    const review = await probe2d(page);
    await page.goto(`${base}#/project-map?level=${level}`);
    const plain = await probe2d(page);
    expect(Object.keys(review.positions).length).toBeGreaterThan(10);
    expect(review.positions).toEqual(plain.positions);
    expect(plain.review).toBeNull();
  }
});

test("function level: Button itself coloured, a function-to-function line from HomePage", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature&level=symbols");
  const p = await probe2d(page);
  expect(p.review?.changed).toContainEqual({ id: BUTTON, change: "signature" });
  expect(p.review?.drawn?.links).toContainEqual(
    expect.objectContaining({ src: HOME, dst: BUTTON, change: "signature" }),
  );
});

test("clicking a changed symbol in the panel focuses its file on the map and opens the inspector", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature");
  await probe2d(page);
  await page
    .getByRole("region", { name: "Changed symbols" })
    .getByRole("button", { name: /Button/ })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`sel=${encodeURIComponent(BUTTON).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const change = inspector.getByRole("region", { name: "Change in this review" });
  await expect(change.locator("[data-side=before]")).toContainText("onClick?: () => void }");
  await expect(change.locator("[data-side=after]")).toContainText("size?: number");
  // The map zoomed in to the file that holds Button.
  await expect(page.getByTestId("map-crumb")).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: join(shots, "review-inspector-fixture.png") });
});

const esc = (s: string) => encodeURIComponent(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("consumers on the map: expanding a change lists who uses it; only its lines stay; a consumer click focuses it", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature");
  await probe2d(page);
  const list = page.getByRole("region", { name: "Changed symbols" });
  await list.getByRole("button", { name: /^Button/ }).click();
  const tiers = list.getByRole("region", { name: "Consumers of Button" });
  await expect(tiers.getByRole("heading", { name: "Directly affected (3)" })).toBeVisible();
  await expect(tiers.getByRole("heading", { name: /^Potentially affected \(\d+\)$/ })).toBeVisible();
  const home = tiers.getByRole("button", { name: /^HomePage/ });
  await expect(home).toContainText("renders");
  await expect(home).toContainText("app uses a package");
  await expect(tiers.getByRole("button", { name: /^index\.ts/ })).toContainText("imports");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: /^Used by \(\d+\)$/ })).toBeVisible();

  // Only Button's consumers keep their colour and lines: direct ones strong, potential ones soft.
  await page.mouse.move(2, 2);
  const p = await probe2d(page);
  const links = p.review?.drawn?.links ?? [];
  expect(links.length).toBeGreaterThan(0);
  for (const l of links) {
    if (!l.soft) expect(l.dst).toBe(BUTTON_FILE);
  }
  expect(links).toContainEqual(expect.objectContaining({ src: HOME_FILE, dst: BUTTON_FILE }));
  expect(links.some((l) => l.soft)).toBe(true);
  await page.screenshot({ path: join(shots, "review-consumers-fixture.png") });

  // Clicking a consumer selects it and zooms to it; Button stays in focus.
  await home.click();
  await expect(page).toHaveURL(new RegExp(`sel=${esc(HOME)}`));
  await expect(home).toHaveAttribute("aria-current", "true");
  await expect(tiers).toBeVisible();
  await expect(page.getByTestId("map-crumb")).toBeVisible({ timeout: 10_000 });
  await expectTidy(page);
});

test("selecting a change fits its node and all its direct consumers in view, zoomed in but not past a single node", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature");
  const full = await probe2d(page);
  const list = page.getByRole("region", { name: "Changed symbols" });
  await list.getByRole("button", { name: /^Button/ }).click();
  await page.mouse.move(2, 2);
  const p = await probe2d(page);
  const rect = (id: string) => p.reviewRects.find((r) => r.id === id);
  const change = rect(BUTTON_FILE);
  expect(change).toBeDefined();
  const direct = p.review?.affected.filter((a) => a.hop === 1) ?? [];
  expect(direct.length).toBeGreaterThan(0);
  expect(direct.map((d) => d.id)).toContain(HOME_FILE);
  // The visible area: the canvas minus the key and legend that sit over it.
  const canvasBox = (await surface(page).boundingBox()) as { x: number; y: number };
  const overlays = await page
    .locator(".gc-key, .rv-legend")
    .evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
    );
  const { w, h } = p.viewport;
  for (const id of [BUTTON_FILE, ...direct.map((d) => d.id)]) {
    const c = rect(id) as { x: number; y: number; w: number; h: number };
    expect(c, id).toBeDefined();
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(w);
    expect(c.y + c.h).toBeLessThanOrEqual(h);
    for (const o of overlays) {
      const ox = o.x - canvasBox.x;
      const oy = o.y - canvasBox.y;
      const overlap = c.x < ox + o.w && c.x + c.w > ox && c.y < oy + o.h && c.y + c.h > oy;
      expect(overlap, `${id} under an overlay`).toBe(false);
    }
  }
  const c = change as { w: number; h: number };
  expect(c.w * c.h).toBeLessThan(w * h * 0.5);

  // Zoomed in on the full map, but never past the zoom of the plain map to the change's node alone.
  expect(p.scale).toBeGreaterThan(full.fitScale * 1.05);
  await page.getByTestId("graph-canvas").evaluate((el, id) => {
    el.dispatchEvent(new CustomEvent("gantry:zoom-to", { detail: { id } }));
  }, BUTTON_FILE);
  // The camera moves to the node alone (closer than the group), then settles.
  await expect.poll(async () => (await probe2d(page)).scale).toBeGreaterThan(p.scale * 1.01);
  const single = await probe2d(page);
  expect(p.scale).toBeLessThanOrEqual(single.scale + 1e-6);
});

test("another change in the same file re-fits the view; a consumer click zooms to that consumer", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature");
  await probe2d(page);
  const list = page.getByRole("region", { name: "Changed symbols" });
  await list.getByRole("button", { name: /^Button/ }).click();
  await page.mouse.move(2, 2);
  const group = await probe2d(page);
  // Chip is in the same file but has no consumers: the view settles on the file alone, closer than the group.
  await list.getByRole("button", { name: /^Chip/ }).click();
  await page.mouse.move(2, 2);
  await expect.poll(async () => (await probe2d(page)).scale).toBeGreaterThan(group.scale * 1.05);
  await list.getByRole("button", { name: /^Button/ }).click();
  await page.mouse.move(2, 2);
  await expect.poll(async () => (await probe2d(page)).scale).toBeCloseTo(group.scale, 3);

  // Clicking a consumer afterwards keeps zooming to the consumer itself.
  const tiers = list.getByRole("region", { name: "Consumers of Button" });
  await tiers.getByRole("button", { name: /^HomePage/ }).click();
  await page.mouse.move(2, 2);
  const home = await probe2d(page);
  const r = home.reviewRects.find((x) => x.id === HOME_FILE) as {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  expect(r).toBeDefined();
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.x + r.w).toBeLessThanOrEqual(home.viewport.w);
  expect(r.y + r.h).toBeLessThanOrEqual(home.viewport.h);
  expect(home.scale).toBeGreaterThan(group.scale * 1.05);
});

test("consumers on the rings: a selected change keeps its direct consumers strong and the rest faded", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature&mode=rings");
  const canvas = page.getByTestId("review-canvas");
  await page
    .getByRole("region", { name: "Changed symbols" })
    .getByRole("button", { name: /^Button/ })
    .click();
  const rings = canvas.locator(".rv-rings");
  await expect(rings).toHaveAttribute("data-focus-change", BUTTON);
  const home = canvas.getByRole("button", { name: "HomePage, calls the changed code directly" });
  await expect(home).toHaveAttribute("data-tier", "direct");
  await expect(canvas.getByRole("button", { name: /slugifyAll, added/ })).toHaveClass(/rv-dim/);
  await expect(canvas.locator(`[data-edge="${HOME}->${BUTTON}"]`)).toHaveAttribute("data-tier", "direct");
  const tiers = page.getByRole("region", { name: "Consumers of Button" });
  await tiers.getByRole("button", { name: /^HomePage/ }).click();
  await expect(page).toHaveURL(new RegExp(`sel=${esc(HOME)}`));
  await expect(home.locator("circle")).toHaveClass(/rv-sel/);
  await expect(rings).toHaveAttribute("data-focus-change", BUTTON);
});

test("a focus-only deep link (as gantry_open_view returns) opens that symbol in the inspector", async ({
  page,
}) => {
  await open(page, `#/review?focus=${encodeURIComponent(BUTTON)}&range=main...feature`);
  const heading = page.locator("aside[aria-label=Inspector] h2").first();
  await expect(heading).toHaveAttribute("title", BUTTON);
});

test("3D map: the settlements with Button's building coloured, caller buildings tinted, arcs between them", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature");
  await page.getByRole("radio", { name: "3D map" }).click();
  await expect(page).toHaveURL(/map=3d/);
  await expect(page.getByTestId("review-canvas")).toHaveAttribute("data-map", "3d");
  await expect(page.locator(".map3d[data-ready='true'][data-style='settlements']")).toBeVisible({
    timeout: 30_000,
  });
  const host = page.getByTestId("map3d-canvas");
  await expect(host).toHaveAttribute("data-review", /signature|packages/, { timeout: 20_000 });
  const review = JSON.parse((await host.getAttribute("data-review")) ?? "null") as {
    changed: string[];
    affected: string[];
    faded: number;
    links: { src: string; dst: string; change: string }[];
  };
  expect(review.changed).toContain(BUTTON_FILE);
  expect(review.affected).toContain(HOME_FILE);
  expect(review.faded).toBeGreaterThan(review.changed.length);
  expect(review.links).toContainEqual({ src: HOME_FILE, dst: BUTTON_FILE, change: "signature" });
  await page.getByTestId("map3d-pause").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "review-3d-fixture.png") });
});

test("3D settlements: selecting a change frames its building and every direct consumer building", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature&map=3d");
  await expect(page.locator(".map3d[data-ready='true'][data-style='settlements']")).toBeVisible({
    timeout: 30_000,
  });
  const host = page.getByTestId("map3d-canvas");
  await expect(host).toHaveAttribute("data-review", /signature/, { timeout: 20_000 });
  await page.getByTestId("map3d-pause").click();
  await page
    .getByRole("region", { name: "Changed symbols" })
    .getByRole("button", { name: /^Button/ })
    .click();
  await expect(host).toHaveAttribute("data-animating", "false", { timeout: 10_000 });
  await page.waitForTimeout(1000);
  const ids = [BUTTON_FILE, HOME_FILE];
  const projected = JSON.parse(
    await host.evaluate((el, want) => {
      el.dispatchEvent(new CustomEvent("gantry:project", { detail: { ids: want } }));
      return (el as HTMLElement).dataset.projected ?? "[]";
    }, ids),
  ) as { id: string; x: number; y: number; z: number }[];
  expect(projected.map((q) => q.id).sort()).toEqual([...ids].sort());
  for (const q of projected) {
    expect(Math.abs(q.x), q.id).toBeLessThan(0.95);
    expect(Math.abs(q.y), q.id).toBeLessThan(0.95);
    expect(q.z, q.id).toBeLessThan(1);
  }
});

test("rings: plain-words ring labels with counts, file groups, names on changed nodes, hover keeps the path", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature&mode=rings");
  const canvas = page.getByTestId("review-canvas");
  await expect(canvas).toHaveAttribute("data-mode", "rings");
  await expect(
    canvas.getByText("Centre: what changed. Each ring out: code that calls the ring inside it."),
  ).toBeVisible();
  await expect(canvas.getByText(/^Changed in this range \(3\)$/)).toBeVisible();
  await expect(canvas.getByText(/^Call the changed code directly \(\d+\)$/)).toBeVisible();
  expect(await canvas.locator(".rv-group-label").count()).toBeGreaterThan(1);
  const button = canvas.getByRole("button", { name: "Button, modified, signature changed" });
  await expect(button.locator("circle")).toHaveClass(/rv-fill-signature/);
  await expect(canvas.locator(".rv-label", { hasText: "Button" })).toBeVisible();
  const home = canvas.getByRole("button", { name: "HomePage, calls the changed code directly" });
  await home.locator("circle").hover();
  await expect(canvas.getByRole("tooltip")).toContainText("apps/web/src/routes/index.tsx");
  await expect(home).not.toHaveClass(/rv-dim/);
  await expect(canvas.getByRole("button", { name: /slugifyAll, added/ })).toHaveClass(/rv-dim/);
  await expect(canvas.locator(`[data-edge="${HOME}->${BUTTON}"]`)).toHaveClass(/rv-edge-hot/);
  await page.mouse.move(2, 2);
  await expectTidy(page);
  await page.screenshot({ path: join(shots, "review-rings-fixture.png") });
});

test("dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, "#/review?range=main...feature");
  await probe2d(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(243, 244, 247)");
  await expectTidy(page);
  await page.screenshot({ path: join(shots, "review-map-fixture-dark.png") });
});

test("a bad range shows the server's message; an empty one asks for a range", async ({ page }) => {
  await page.goto(`${base}#/review?range=main...nope`);
  await expect(page.getByRole("heading", { name: "This view could not be loaded" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("unknown git ref: nope").first()).toBeVisible();
  await page.goto(`${base}#/review`);
  await expect(page.getByRole("heading", { name: "Pick a change to review" })).toBeVisible();
  await page.getByRole("textbox", { name: "Range to review" }).fill("main...feature");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator("[data-testid=review-canvas][data-ready=true]")).toBeVisible({ timeout: 30_000 });
});

test("the review API keeps the token, Origin and Host checks", async ({ request }) => {
  const q = encodeURIComponent(JSON.stringify({ range: "main...feature" }));
  const u = new URL(base);
  for (const view of ["review", "project-map"]) {
    expect((await request.get(`${u.origin}/api/view/${view}?filters=${q}`)).status()).toBe(403);
    const token = u.searchParams.get("t") ?? "";
    const ok = await request.get(`${u.origin}/api/view/${view}?filters=${q}`, {
      headers: { "x-gantry-token": token },
    });
    expect(ok.status()).toBe(200);
    const evil = await request.get(`${u.origin}/api/view/${view}?filters=${q}`, {
      headers: { "x-gantry-token": token, origin: "http://evil.example" },
    });
    expect(evil.status()).toBe(403);
    const badHost = await request.get(`${u.origin}/api/view/${view}?filters=${q}`, {
      headers: { "x-gantry-token": token, host: "evil.example" },
    });
    expect(badHost.status()).toBe(403);
  }
});
