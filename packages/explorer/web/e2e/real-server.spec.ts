import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");
const shots = join(repoRoot, "docs/milestones/screenshots");

// Runs the built explorer against the REAL server: the pnpm-turbo fixture is copied into a temp git repo,
// indexed with `gantry init`, and served by `gantry map --no-open`. Needs `pnpm build` first (pnpm e2e does it).
test.describe.configure({ mode: "serial" });
// Headless Chromium has no GPU; software GL (SwiftShader) gives the 3D map a WebGL context.
test.use({
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
});

// The server sends a restrictive CSP; the built app must run under it with nothing blocked.
const cspProblems: string[] = [];
test.beforeEach(({ page }) => {
  page.on("console", (m) => {
    if (/content security policy|violat/i.test(m.text())) cspProblems.push(m.text());
  });
  page.on("pageerror", (e) => cspProblems.push(String(e)));
});
test.afterEach(() => {
  expect(cspProblems, "console CSP violations / page errors").toEqual([]);
});

let tmp = "";
let server: ChildProcess | undefined;
let url = "";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  tmp = mkdtempSync(join(tmpdir(), "gantry-e2e-"));
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
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  execFileSync("node", [cliJs, "init"], { cwd: repo, env, stdio: "ignore", timeout: 100_000 });

  server = spawn("node", [cliJs, "map", "--no-open"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  url = await new Promise<string>((ok, fail) => {
    let out = "";
    let err = "";
    server?.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) ok(line);
    });
    server?.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
    });
    server?.on("exit", (code) => fail(new Error(`gantry map exited with ${code}: ${err}`)));
  });
});

test.afterAll(() => {
  server?.kill("SIGINT");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("project map: switch levels, drill into @acme/ui, then see Button's callers in the ego view", async ({
  page,
}) => {
  mkdirSync(shots, { recursive: true });
  await page.goto(url);
  await expect(page.getByText("pnpm-turbo").first()).toBeVisible();
  // These steps drive the list renderer; the graph canvas (#36) is the default for 2D views.
  await page.getByRole("button", { name: "List", exact: true }).click();
  // The server reports counts only; nothing about a backlog or working changes yet.
  await expect(page.getByText(/^\d+ workspaces$/)).toBeVisible();
  await expect(page.getByText(/Backlog/)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/project-map/);

  // Levels.
  const levels = page.getByRole("radiogroup", { name: "Detail level" });
  await levels.getByRole("radio", { name: "Workspaces" }).click();
  await expect(page).toHaveURL(/level=workspaces/);
  const rows = page.getByRole("listbox", { name: "Graph nodes" }).getByRole("option");
  await expect(rows.filter({ hasText: "@acme/ui" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "button.tsx" })).toHaveCount(0);
  await levels.getByRole("radio", { name: "Folders" }).click();
  await expect(rows.filter({ hasText: "src" }).first()).toBeVisible();
  await levels.getByRole("radio", { name: "Files" }).click();
  await expect(rows.filter({ hasText: /\.tsx?/ }).first()).toBeVisible();
  await levels.getByRole("radio", { name: "Functions" }).click();
  await expect(page).toHaveURL(/level=symbols/);
  await expect(rows.first()).toBeVisible();

  // Hide tests is on by default; the workspaces filter lists every workspace.
  await expect(page.getByRole("checkbox", { name: "Hide tests" })).toBeChecked();
  await expect(page.getByRole("region", { name: "Workspaces" }).getByRole("checkbox")).toHaveCount(5);

  // Drill into @acme/ui: the server returns just that subtree.
  await levels.getByRole("radio", { name: "Workspaces" }).click();
  await rows.filter({ hasText: "@acme/ui" }).dblclick();
  await expect(page).toHaveURL(/focus=ws%3Apnpm-turbo%3A%40acme%2Fui/);
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toContainText("@acme/ui");
  await expect(rows.filter({ hasText: "@acme/web" })).toHaveCount(0);
  await levels.getByRole("radio", { name: "Functions" }).click();
  await expect(rows.filter({ hasText: /^Button/ })).toHaveCount(1);
  await expect(rows.filter({ hasText: /^Card/ })).toHaveCount(1);
  await page.screenshot({ path: join(shots, "project-map-fixture.png") });

  // Open Button from the inspector's side and jump to the ego view.
  await rows.filter({ hasText: /^Button/ }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "Button" })).toBeVisible();
  // Button has a stored template description (#175: /api/node returns it with described_by). It is shown under the
  // template label as plain text: the JSX in it stays literal text and never becomes markup.
  await expect(inspector.getByText("Template text copied from the code — may be wrong")).toBeVisible();
  const description = inspector.locator(".description-text");
  await expect(description).toContainText('Returns <button type="button"');
  await expect(description.locator("*")).toHaveCount(0);
  await expect(inspector.getByText("Generated without a model from the kind")).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Open in project map" })).toBeEnabled();
  await page.getByRole("button", { name: "Show whole repo" }).click();
  await expect(page).not.toHaveURL(/focus=/);

  // Ego view: empty until a function is chosen with search.
  await page.getByRole("tab", { name: "Function ego graph" }).click();
  await expect(page.getByText("Pick a function to see its callers and callees")).toBeVisible();
  const search = page.getByRole("combobox", { name: "Search symbols" });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search).toBeFocused();
  await search.fill("Button");
  await expect(page.getByRole("option", { name: /Button/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/ego\?.*focus=sym/);
  await expect(rows.filter({ hasText: "centre" })).toHaveCount(1);
  // The pages that render Button are its callers.
  await expect(rows.filter({ hasText: "caller" }).first()).toBeVisible();
  await expect(page.getByText(/^\d+ callers?\b/)).toBeVisible();
  await expect(page.getByText(/^\d+ callees?\b/)).toBeVisible();
  // The graph shows the same thing as a bow-tie: callers left of the centre, callees right.
  await page.getByRole("button", { name: "Graph" }).click();
  await expect(page.getByTestId("graph-canvas").locator("canvas[data-ready=true]")).toBeVisible();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "ego-fixture.png") });
  await page.getByRole("button", { name: "List", exact: true }).click();

  // Hops and the link back to the project map.
  await page.getByRole("slider").fill("1");
  await expect(page).toHaveURL(/hops=1/);
  await inspector.getByRole("button", { name: "Open in project map" }).click();
  await expect(page).toHaveURL(/#\/project-map\?.*focus=file/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("button.tsx");
});

test("3D map: opens from the view switcher and draws the fixture's workspaces as settlements (city and islands on request)", async ({
  page,
}) => {
  mkdirSync(shots, { recursive: true });
  await page.goto(url);
  await page.getByRole("tab", { name: "3D map" }).click();
  await expect(page).toHaveURL(/#\/map-3d/);
  await page.goto(`${url.replace(/#.*$/, "")}#/map-3d`);
  await expect(page.getByTestId("map3d-canvas").locator("canvas")).toBeVisible();
  await expect(page.locator(".map3d[data-ready='true']")).toBeVisible();
  const legend = page.getByRole("list").filter({ has: page.getByRole("button", { name: /^ui/ }) });
  await expect(legend.getByRole("button")).toHaveCount(5);
  await page.getByLabel(/Auto-rotate/).uncheck();
  // The default style: one settlement per workspace, each with its name and tier.
  await expect(page.locator(".map3d[data-style='settlements']")).toBeVisible();
  await expect(page.locator(".s3-title .s3-name")).toHaveCount(5);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(shots, "map-3d-fixture.png") });

  // The city keeps the level switch: it goes into the hash as `level=` and the filter checkbox as `hideTests=`.
  await page.getByLabel("City").click();
  await expect(page).toHaveURL(/style=city/);
  await page.getByLabel("Files").click();
  await expect(page).toHaveURL(/#\/map-3d\?.*level=files/);
  // (a click, not `uncheck()`: the checkbox follows the hash a few ms after the click, which `uncheck()` does not wait for)
  await page.getByLabel("Hide tests").click();
  await expect(page).toHaveURL(/hideTests=false/);
  await expect(page.getByLabel("Hide tests")).not.toBeChecked();
  // The city lays out again for the new level and filter; a click in the list before it is ready is not replayed.
  await expect(
    page.locator(".map3d[data-ready='true'][data-style='city'][data-level='files']"),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await legend.getByRole("button", { name: /^ui/ }).click();
  await expect(page).toHaveURL(/sel=ws%3Apnpm-turbo%3A%40acme%2Fui/);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  // The city draws one district per workspace with a visible name; the island style stays one click away.
  await expect(page.locator(".map3d[data-style='city']")).toBeVisible();
  await expect(page.locator(".c3-title .c3-name")).toHaveCount(5);
  await page.getByLabel("Islands").click();
  await expect(page).toHaveURL(/style=islands/);
  await expect(page.locator(".map3d[data-ready='true']:not([data-style])")).toBeVisible();
  await page.getByLabel("Settlements").click();
  await expect(page).not.toHaveURL(/style=/);
  await expect(page.locator(".map3d[data-ready='true'][data-style='settlements']")).toBeVisible();
});

test("graph canvas: the treemap layout is the same after a reload; PUT /api/layout stays token-gated", async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  // The project map's layout follows from the data (box area from function counts), so nothing is saved.
  // The layout/timing chip is debug text: hidden unless ?debug=1.
  await expect(page.locator(".gc-status")).toHaveCount(0);
  const hash = () =>
    page.locator(".gc-sigma").evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (JSON.parse((el as HTMLElement).dataset.probe ?? "{}") as { hash: string }).hash;
    });
  const first = await hash();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "canvas-real-server.png") });
  await page.reload();
  await expect(page.locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  expect(await hash()).toBe(first);
  // The PUT route is token-gated like every /api route: without the cookie it is refused.
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/layout/project-map", {
      method: "PUT",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positions: {} }),
    });
    return res.status;
  });
  expect(status).toBe(403);
});

test("duplicates: lists the fixture's renamed-copy pair as identical with a side-by-side, and a dismissed pair stays gone after a reload", async ({
  page,
}) => {
  mkdirSync(shots, { recursive: true });
  await page.goto(url);
  await page.getByRole("tab", { name: "Duplicates" }).click();
  await expect(page).toHaveURL(/#\/duplicates/);
  const groups = page.getByRole("list", { name: "Duplicate groups, biggest first" });
  await expect(groups.getByRole("button")).toHaveCount(2);
  await expect(page.getByText(/^2 groups · 4 functions/)).toBeVisible();
  // Without `gantry embed` only identical and nearly identical code is found, and the page says so.
  await expect(page.getByRole("note")).toContainText("Only identical and nearly identical code was checked");

  // The exact pair: slugify in apps/web and in packages/utils; the keep candidate is the shared package's.
  const slug = groups.getByRole("button").filter({ hasText: "slugify" });
  await expect(slug).toContainText("Identical");
  // The renamed copy: formatRelativeDate and parseTimestamp, both in packages/utils (exact since #151).
  const near = groups.getByRole("button").filter({ hasText: "formatRelativeDate" });
  await expect(near).toContainText("Identical");
  await near.click();
  const cards = page.getByRole("list", { name: "Copies in this group" });
  await expect(cards.getByText("Keep this one")).toHaveCount(1);
  await expect(cards.getByText(/packages\/utils\/src\/date\.ts:1/)).toBeVisible();
  await expect(cards.getByText(/packages\/utils\/src\/time\.ts:2/)).toBeVisible();
  const compare = page.getByRole("region", { name: /Compare parseTimestamp with formatRelativeDate/ });
  await expect(compare.getByText("Loading source…")).toHaveCount(0);
  await expect(compare).toContainText("diffMs");
  await expect(compare).toContainText("delta");
  await expect(compare.locator('[data-diff="true"]').first()).toBeVisible();
  await page.mouse.move(2, 2);
  await page.screenshot({ path: join(shots, "duplicates-fixture.png") });

  // "Not a duplicate" hides the pair, and a reload (fresh data from the server) keeps it hidden.
  await cards.getByRole("button", { name: "Not a duplicate" }).click();
  await page.getByPlaceholder(/same shape/).fill("different on purpose");
  await page.getByRole("button", { name: "Hide this pair" }).click();
  await expect(groups.getByRole("button")).toHaveCount(1);
  await page.reload();
  await expect(groups.getByRole("button")).toHaveCount(1);
  await expect(groups.getByRole("button").filter({ hasText: "formatRelativeDate" })).toHaveCount(0);
  await expect(groups.getByRole("button").filter({ hasText: "slugify" })).toHaveCount(1);
});

test("pages: the fixture's three routes show their components and the shared Button, and the depth slider and prefix filter work", async ({
  page,
}) => {
  mkdirSync(shots, { recursive: true });
  await page.goto(url);
  await page.getByRole("tab", { name: "Pages" }).click();
  await expect(page).toHaveURL(/#\/pages/);
  const rows = page.getByRole("listbox", { name: "Graph nodes" }).getByRole("option");
  await page.getByRole("button", { name: "List", exact: true }).click();
  for (const label of ["/", "/posts/$postId", "/settings/profile", "HomePage", "PostPage", "ProfilePage"]) {
    await expect(
      rows.filter({ hasText: new RegExp(`^${label.replace(/[$/]/g, "\\$&")}`) }).first(),
    ).toBeVisible();
  }
  // Button is one node, drawn once, with two incoming edges (home and profile pages).
  await expect(rows.filter({ hasText: /^Button/ })).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Shared components" })).toContainText("shared by 2");
  // One step shows what the page components use directly; the hook below PostList needs two (the default).
  await expect(rows.filter({ hasText: /^useDebounce/ })).toHaveCount(1);
  await page.getByRole("slider").fill("1");
  await expect(page).toHaveURL(/hops=1/);
  await expect(rows.filter({ hasText: /^useDebounce/ })).toHaveCount(0);
  await page.getByRole("slider").fill("2");
  await expect(rows.filter({ hasText: /^useDebounce/ })).toHaveCount(1);
  // Route prefix: only /settings/profile and its layout.
  await page.getByRole("textbox").fill("/settings");
  await page.getByRole("textbox").press("Enter");
  await expect(rows.filter({ hasText: /^\/posts/ })).toHaveCount(0);
  await expect(rows.filter({ hasText: /^\/settings\/profile/ })).toHaveCount(1);
  await page.getByRole("textbox").fill("");
  await page.getByRole("textbox").press("Enter");
  await expect(rows.filter({ hasText: /^\/posts/ })).toHaveCount(1);

  await page.getByRole("button", { name: "Graph" }).click();
  await expect(page.locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(shots, "pages-fixture.png") });
});

test("slices: cross-slice imports with their counts, the shared-by list, and imports inside a slice on request", async ({
  page,
}) => {
  mkdirSync(shots, { recursive: true });
  await page.goto(url);
  await page.getByRole("tab", { name: "Feature slices" }).click();
  await expect(page).toHaveURL(/#\/slices/);
  const rows = page.getByRole("listbox", { name: "Graph nodes" }).getByRole("option");
  await page.getByRole("button", { name: "List", exact: true }).click();
  // The packages/* glob gives three slices; the app has no slice of its own, so its route segments are slices.
  for (const label of [
    "packages/db",
    "packages/ui",
    "packages/utils",
    "web /",
    "web /posts",
    "web /settings",
  ]) {
    await expect(
      rows.filter({ hasText: new RegExp(`^${label.replace(/\//g, "\\/")}`) }).first(),
    ).toBeVisible();
  }
  await expect(page.getByText(/6 slices; 4 links between them/)).toBeVisible();
  await expect(page.getByText(/first-level route segments/)).toBeVisible();
  const shared = page.getByRole("region", { name: "Shared by" });
  await expect(shared.getByRole("button", { name: /Button/ })).toContainText("2 slices");
  await page.getByRole("radio", { name: "Functions" }).click();
  await expect(page).toHaveURL(/level=symbols/);
  await expect(rows.filter({ hasText: /^Button/ })).toHaveCount(1);
  await page.getByRole("radio", { name: "Files" }).click();
  await page.getByRole("checkbox", { name: /Imports inside a slice/ }).click();
  await expect(page).toHaveURL(/intra=true/);
  await page.getByRole("checkbox", { name: /Imports inside a slice/ }).click();

  await page.getByRole("button", { name: "Graph" }).click();
  await expect(page.locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(shots, "slices-fixture.png") });
});

// A link with a focus and no sel (what gantry_open_view returns) opens that node in the inspector (#136).
test.describe("focus-only deep links", () => {
  const base = () => url.replace(/#.*$/, "");
  const ids: Record<string, string> = {};

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(url);
    const found = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: ad hoc JSON
      const get = async (p: string): Promise<any> => (await fetch(p)).json();
      const first = (v: { nodes?: { id: string }[] }, prefix: string) =>
        (v.nodes ?? []).find((n) => n.id.startsWith(prefix))?.id ?? "";
      const ws = first(await get("/api/view/project-map?level=workspaces"), "ws:");
      const sym = first(await get("/api/view/project-map?level=symbols"), "sym:");
      return {
        "project-map": ws,
        "map-3d": ws,
        ego: sym,
        duplicates: first(await get("/api/view/duplicates"), "sym:"),
        pages: first(await get("/api/view/pages"), "route:"),
        slices: first(await get("/api/view/slices"), "slice:"),
      };
    });
    Object.assign(ids, found);
    await page.close();
  });

  for (const view of ["project-map", "ego", "duplicates", "map-3d", "pages", "slices"]) {
    test(`${view}: the inspector shows the focus node`, async ({ page }) => {
      const focus = ids[view];
      expect(focus, `a focus id for ${view}`).toBeTruthy();
      await page.goto(`${base()}#/${view}?focus=${encodeURIComponent(focus ?? "")}`);
      const heading = page.locator("aside[aria-label=Inspector] h2").first();
      await expect(heading).toBeVisible({ timeout: 20_000 });
      await expect(heading).toHaveAttribute("title", focus ?? "");
    });
  }

  test("closing the inspector keeps it closed after a reload", async ({ page }) => {
    const focus = ids["project-map"] ?? "";
    await page.goto(`${base()}#/project-map?focus=${encodeURIComponent(focus)}`);
    const inspector = page.locator("aside[aria-label=Inspector]");
    await expect(inspector.locator("h2").first()).toBeVisible({ timeout: 20_000 });
    await inspector.getByRole("button", { name: "Close inspector" }).click();
    await expect(inspector).toHaveCount(0);
    await expect(page).toHaveURL(/sel=(&|$)/);
    await page.reload();
    await expect(page.getByText("pnpm-turbo").first()).toBeVisible();
    await page.waitForTimeout(500);
    await expect(inspector).toHaveCount(0);
  });

  test("an explicit sel wins over the focus", async ({ page }) => {
    const sel = ids["project-map"] ?? "";
    const focus = ids.ego ?? "";
    await page.goto(`${base()}#/ego?focus=${encodeURIComponent(focus)}&sel=${encodeURIComponent(sel)}`);
    const heading = page.locator("aside[aria-label=Inspector] h2").first();
    await expect(heading).toHaveAttribute("title", sel, { timeout: 20_000 });
  });
});
