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
  await expect(page).toHaveURL(/focus=ws%3A%40acme%2Fui/);
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
  await expect(inspector.getByText("Not yet described")).toBeVisible();
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

test("3D map: opens from the view switcher and draws the fixture's workspaces as islands", async ({
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
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(shots, "map-3d-fixture.png") });

  // Level switch goes into the hash as `level=` and the filter checkbox as `hideTests=`.
  await page.getByLabel("Files").click();
  await expect(page).toHaveURL(/#\/map-3d\?.*level=files/);
  await page.getByLabel("Hide tests").uncheck();
  await expect(page).toHaveURL(/hideTests=false/);
  await legend.getByRole("button", { name: /^ui/ }).click();
  await expect(page).toHaveURL(/sel=ws%3A%40acme%2Fui/);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
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
