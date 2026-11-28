import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths, seedTeamCache, teamCachePath } from "@gantry/core";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");
const changeSets = join(repoRoot, "fixtures/team-changesets/change-sets.json");
const results = join(repoRoot, "test-results/team-layer");
const PORT = 47822;

// The Team layer on the real server: the pnpm-turbo fixture in a temp git repo (origin fixture/pnpm-turbo, so the
// ids match the committed change sets), indexed with `gantry init`, a team-cache.db seeded from the fixture file, and
// no team server anywhere. Motion is forced off. Needs `pnpm build` first.
test.describe.configure({ mode: "serial" });
test.use({
  reducedMotion: "reduce",
  launchOptions: {
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  },
});

let tmp = "";
let server: ChildProcess | undefined;
let url = "";
let cacheFile = "";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  tmp = mkdtempSync(join(tmpdir(), "gantry-team-e2e-"));
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
  git("remote", "add", "origin", "https://github.com/fixture/pnpm-turbo.git");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  execFileSync("node", [cliJs, "init"], { cwd: repo, env, stdio: "ignore", timeout: 100_000 });
  cacheFile = teamCachePath(resolvePaths(repo, env));
  seedTeamCache(cacheFile, changeSets);

  server = spawn("node", [cliJs, "map", "--no-open", "--port", String(PORT)], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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

const shot = (page: Page, name: string) => page.screenshot({ path: join(results, `${name}.png`) });
const toggle = (page: Page) => page.getByTestId("team-toggle");
const map = (page: Page) => page.locator(".gc-sigma[data-ready=true]");
const probe = (page: Page) =>
  map(page).evaluate((el) => {
    el.dispatchEvent(new CustomEvent("gantry:probe"));
    return JSON.parse((el as HTMLElement).dataset.probe ?? "{}") as {
      team: { id: string; count: number; owners: string[] }[];
      review: {
        changed: { id: string }[];
        affected: { id: string; hop: number }[];
        drawn: { links: { src: string; dst: string }[]; reach?: number; hubs?: string[] } | null;
      } | null;
    };
  });

async function openMap(page: Page) {
  await page.goto(`${url}#/project-map?level=files`);
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
}

test("switching the layer on shows every open pull request, area markers with counts and the freshness line", async ({
  page,
}) => {
  mkdirSync(results, { recursive: true });
  await openMap(page);
  await shot(page, "off");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("team-panel")).toHaveCount(0);

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  const panel = page.getByTestId("team-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(page.getByTestId("team-entry")).toHaveCount(3);
  await expect(page.getByTestId("team-freshness")).toContainText(/Team data pulled .+ ago/);
  await expect(page.getByTestId("team-freshness").getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(panel).toContainText("gantry team status --pull");

  // Two change sets by ana and sam touch @acme/utils; one by ana touches @acme/db.
  await expect.poll(async () => (await probe(page)).team.length).toBe(2);
  const markers = Object.fromEntries((await probe(page)).team.map((m) => [m.id.split(":").at(-1), m]));
  expect(markers["@acme/utils"]).toMatchObject({ count: 2, owners: ["ana", "sam"] });
  expect(markers["@acme/db"]).toMatchObject({ count: 1, owners: ["ana"] });
  await shot(page, "on");

  // Closing the panel gives focus back to the switch.
  await page.getByRole("button", { name: "Close the Team layer" }).click();
  await expect(panel).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
});

test("filtering to one person leaves only their entries and markers", async ({ page }) => {
  await openMap(page);
  await toggle(page).click();
  await page.getByRole("group", { name: "People" }).getByRole("checkbox", { name: "sam" }).click();
  await expect(page.getByTestId("team-entry")).toHaveCount(1);
  await expect(page.getByTestId("team-entry")).toHaveAttribute("data-owner", "sam");
  await expect
    .poll(async () => (await probe(page)).team.map((m) => `${m.id.split(":").at(-1)}:${m.count}`))
    .toEqual(["@acme/utils:1"]);
  await shot(page, "filtered");
  await page.getByRole("button", { name: "Show everyone" }).click();
  await expect(page.getByTestId("team-entry")).toHaveCount(3);
});

test("selecting a change set shows its rings, legend and changed nodes, and a node opens the inspector", async ({
  page,
}) => {
  await openMap(page);
  await toggle(page).click();
  await page.getByTestId("team-entry").filter({ hasText: "#145" }).getByRole("button").first().click();
  await expect(page.getByTestId("team-rings")).toBeVisible();
  const legend = page.getByTestId("review-legend");
  await expect(legend).toBeVisible();
  await expect(legend).toContainText("Directly affected");
  await expect(legend).toContainText("Reachable, or through a hub");
  // The map paints the change the way the review does.
  await expect.poll(async () => (await probe(page)).review?.changed.length ?? 0).toBeGreaterThan(0);
  // The markers give way to the change's own colors, and solid lines run from the direct consumers to the change.
  await expect.poll(async () => (await probe(page)).team.length).toBe(0);
  await expect.poll(async () => (await probe(page)).review?.drawn?.links.length ?? 0).toBeGreaterThan(0);
  const nodes = page.getByTestId("team-nodes");
  await expect(nodes.getByRole("button", { name: /listPosts/ })).toBeVisible();
  await shot(page, "selected");
  await nodes.getByRole("button", { name: /listPosts/ }).click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("listPosts");
});

test("the mock's team scenario: reachable entries get a dashed outline and a through-hub entry names its hub", async ({
  page,
}) => {
  await page.goto("/#/project-map?level=files&scenario=team");
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Collapse filters" }).click();
  await toggle(page).click();
  await expect.poll(async () => (await probe(page)).team.length).toBeGreaterThan(0);
  // Each person has their own color on the markers and in the filter.
  const chips = await page
    .locator(".team-people .team-chip")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(chips).size).toBe(2);
  await page.getByTestId("team-entry").filter({ hasText: "#214" }).locator(".team-entry-btn").click();
  await expect.poll(async () => (await probe(page)).review?.drawn?.reach ?? 0).toBeGreaterThan(0);
  const drawn = (await probe(page)).review?.drawn;
  expect(drawn?.hubs?.some((id) => id.endsWith("slug.ts"))).toBe(true);
  await expect(page.getByTestId("review-legend")).toContainText("Reachable, or through a hub");
  await shot(page, "selected-reachable");
});

test("keyboard only: reach the toggle, turn it on, move through the list and select with Enter", async ({
  page,
}) => {
  await openMap(page);
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  const panel = page.getByTestId("team-panel");
  await expect(panel).toBeFocused();
  // Tab walks the panel: close, Refresh, the people, then the entries.
  const item = (n: number) => page.getByTestId("team-entry").nth(n).locator(".team-entry-btn");
  const tabTo = async (n: number) => {
    for (let i = 0; i < 20 && !(await item(n).evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press("Tab");
    await expect(item(n)).toBeFocused();
  };
  await tabTo(0);
  await page.keyboard.press("Enter");
  await expect(item(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("team-rings")).toBeVisible();
  // The changed nodes follow the entry in the tab order; the next entry comes after them.
  await tabTo(1);
  await page.keyboard.press("Enter");
  await expect(item(1)).toHaveAttribute("aria-pressed", "true");
  await expect(item(0)).toHaveAttribute("aria-pressed", "false");
});

test("Refresh re-reads the cache without a team server", async ({ page }) => {
  await openMap(page);
  await toggle(page).click();
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  await page.getByTestId("team-freshness").getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => seen.filter((u) => u.includes("/api/team/layer")).length).toBe(1);
  expect(seen.every((u) => u.startsWith(`http://127.0.0.1:${PORT}/`))).toBe(true);
});

test("without a cache there is no toggle and the map is as before", async ({ page }) => {
  rmSync(cacheFile, { force: true });
  rmSync(`${cacheFile}-wal`, { force: true });
  rmSync(`${cacheFile}-shm`, { force: true });
  await openMap(page);
  await expect(page.getByRole("toolbar", { name: "Graph controls" })).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  await shot(page, "no-cache");
  const res = await page.request.get(`${new URL(url).origin}/api/team/layer`, {
    headers: { "x-gantry-token": new URL(url).searchParams.get("t") ?? "" },
  });
  expect(await res.json()).toEqual({ available: false, age_s: null, change_sets: [], people: [] });
});

test("a cache pulled after the page loaded shows the toggle once the top bar's Refresh has run", async ({
  page,
}) => {
  rmSync(cacheFile, { force: true });
  await openMap(page);
  await expect(toggle(page)).toHaveCount(0);
  seedTeamCache(cacheFile, changeSets);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(toggle(page)).toBeVisible();
  // And it goes again when the cache does.
  await toggle(page).click();
  await expect(page.getByTestId("team-panel")).toBeVisible();
  rmSync(cacheFile, { force: true });
  rmSync(`${cacheFile}-wal`, { force: true });
  rmSync(`${cacheFile}-shm`, { force: true });
  await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
  await expect(toggle(page)).toHaveCount(0);
  await expect(page.getByTestId("team-panel")).toHaveCount(0);
});
