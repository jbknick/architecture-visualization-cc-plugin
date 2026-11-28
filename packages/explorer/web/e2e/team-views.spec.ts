import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Group, openTeamCache, resolvePaths, seedTeamCache, teamCachePath } from "@gantry/core";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");
const changeSets = join(repoRoot, "fixtures/team-changesets/change-sets.json");
const results = join(repoRoot, "test-results/team-views");
const REPO = "fixture/overlay-groups";
const PORT = 47833;
const PORT_NO_CACHE = 47834;

// Shared views and the team default on the real explorer server: a copy of `fixtures/overlay-groups` in a temp git
// repo, indexed with `gantry init`, a `team-cache.db` that holds three team views (one the default) and two team
// groups, and the fake team server for the publish calls (the person is a member). Motion is forced off. Needs
// `pnpm build` first.
test.describe.configure({ mode: "serial" });
test.use({
  reducedMotion: "reduce",
  launchOptions: {
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  },
});

const spec = (level: "workspaces" | "files", groups: string[] = []) => ({
  view: "project-map",
  level,
  hidden: [],
  groups,
  filters: {},
});
const TEAM_VIEWS = [
  { id: "layers-overview", name: "Layers overview", spec: spec("workspaces") },
  { id: "order-flow", name: "Order flow", spec: spec("files", ["orders"]) },
  { id: "catalog-edges", name: "Catalog edges", spec: spec("files", ["catalog"]) },
];
const TEAM_GROUPS: Group[] = [
  { id: "orders", name: "Orders area", selectors: [{ type: "glob", glob: "src/orders/**" }], mayUse: [] },
  {
    id: "catalog",
    name: "Catalog area",
    selectors: [{ type: "glob", glob: "src/catalog/**" }],
    mayUse: ["orders"],
  },
];
const DEFAULT_VIEW = "layers-overview";

let tmp = "";
let fake: FakeServer | undefined;
let server: ChildProcess | undefined;
let plain: ChildProcess | undefined;
let url = "";
let plainUrl = "";
let cacheFile = "";
let paths: ReturnType<typeof resolvePaths>;

function makeRepo(name: string): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = join(tmp, name);
  cpSync(join(repoRoot, "fixtures/overlay-groups"), repo, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(tmp, `${name}-home`),
    CLAUDE_PLUGIN_DATA: join(tmp, `${name}-data`),
    GANTRY_CREDENTIALS_FILE: join(tmp, `${name}-credentials.json`),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Gantry Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Gantry Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  // No team variable of the machine running the test reaches the explorer.
  for (const key of ["GANTRY_SERVER", "GANTRY_ORG", "GANTRY_TOKEN"]) delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/${REPO}.git`);
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  execFileSync("node", [cliJs, "init"], { cwd: repo, env, stdio: "ignore", timeout: 100_000 });
  return { repo, env };
}

function startMap(
  repo: string,
  env: NodeJS.ProcessEnv,
  port: number,
): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("node", [cliJs, "map", "--no-open", "--port", String(port)], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((ok, fail) => {
    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) ok({ proc, url: line });
    });
    proc.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
    });
    proc.on("exit", (code) => fail(new Error(`gantry map exited with ${code}: ${err}`)));
  });
}

/** Writes the cache: the team views and groups, the default, and a pull 12 minutes ago from the fake server. */
function seedCache(): void {
  seedTeamCache(cacheFile, changeSets);
  const cache = openTeamCache(paths);
  try {
    const put = (table: "team_views" | "team_groups", item: { id: string; name: string }) =>
      cache.db
        .prepare(`INSERT OR REPLACE INTO ${table}(id, name, spec) VALUES (?, ?, ?)`)
        .run(item.id, item.name, JSON.stringify(item));
    for (const v of TEAM_VIEWS) put("team_views", v);
    for (const g of TEAM_GROUPS) put("team_groups", g);
    cache.db
      .prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('default_view', ?)")
      .run(DEFAULT_VIEW);
    const meta = cache.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    meta.run("server", fake?.url ?? "");
    meta.run("org", "acme");
    meta.run("repo", REPO);
    meta.run("pulled_at", new Date(Date.now() - 12 * 60_000).toISOString());
  } finally {
    cache.close();
  }
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  tmp = mkdtempSync(join(tmpdir(), "gantry-team-views-e2e-"));
  fake = await startFakeServer({ role: "member", repo: REPO });
  fake.state.views.set(REPO, new Map(TEAM_VIEWS.map((v) => [v.id, v])));
  fake.state.groups.set(REPO, new Map(TEAM_GROUPS.map((g) => [g.id, g])));
  const withTeam = makeRepo("with-cache");
  const env = {
    ...withTeam.env,
    GANTRY_SERVER: fake.url,
    GANTRY_ORG: "acme",
    GANTRY_TOKEN: "fake-user",
  };
  paths = resolvePaths(withTeam.repo, env);
  cacheFile = teamCachePath(paths);
  seedCache();
  const started = await startMap(withTeam.repo, env, PORT);
  server = started.proc;
  url = started.url;
  // A second explorer on another copy, with no team cache at all.
  const bare = makeRepo("no-cache");
  const second = await startMap(bare.repo, bare.env, PORT_NO_CACHE);
  plain = second.proc;
  plainUrl = second.url;
});

test.afterAll(async () => {
  server?.kill("SIGINT");
  plain?.kill("SIGINT");
  await fake?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** A light and a dark screenshot of the page, for the pull request. */
async function shots(page: Page, name: string) {
  mkdirSync(results, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    // Colors of the kit's controls ease over 150 ms: let them settle before the picture is taken.
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(results, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
}

const trigger = (page: Page) => page.getByRole("button", { name: "Saved view" });
const menu = (page: Page) => page.getByRole("menu", { name: "Saved views" });
const teamGroup = (page: Page) => menu(page).getByTestId("team-group");
const teamItems = (page: Page) => teamGroup(page).getByTestId("team-view-item");
const map = (page: Page) => page.locator(".gc-sigma[data-ready=true]");

async function openMenu(page: Page) {
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
}

test("a fresh session opens on the team default, and the menu lists it under Team with the Default badge", async ({
  page,
}) => {
  await page.goto(url);
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain(`saved=${DEFAULT_VIEW}`);
  await expect(trigger(page)).toContainText("Layers overview");
  await openMenu(page);
  await expect(teamGroup(page)).toContainText("Team");
  await expect(teamGroup(page).getByTestId("views-pulled")).toHaveText("pulled 12 min ago");
  await expect(teamItems(page)).toHaveCount(3);
  const badge = teamGroup(page).getByTestId("default-badge");
  await expect(badge).toHaveText("Default");
  const defaultItem = teamItems(page).filter({ has: page.getByTestId("default-badge") });
  await expect(defaultItem).toContainText("Layers overview");
  await expect(defaultItem).toContainText("Team default");
  await expect(defaultItem).toHaveAttribute("aria-checked", "true");
  // Reduced motion: the menu appears without an animation.
  expect(await menu(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await shots(page, "views-menu");
});

test("a team view is read-only; Save a personal copy makes a personal view above the Team heading", async ({
  page,
}) => {
  await page.goto(`${url}#/project-map?level=files&saved=order-flow`);
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
  const bar = page.getByRole("region", { name: "Team view" });
  await expect(bar).toContainText("Order flow");
  await expect(bar.getByTestId("team-view-note")).toHaveText("Team view: read-only");
  await expect(bar.getByRole("button", { name: "Save a personal copy" })).toBeVisible();
  await shots(page, "read-only");
  await bar.getByRole("button", { name: "Save a personal copy" }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain("saved=order-flow-copy");
  await expect(bar).toHaveCount(0);
  await openMenu(page);
  const mine = menu(page).getByRole("group", { name: "Your views" });
  await expect(mine).toContainText("Order flow copy");
  // The copy is above the Team heading.
  const order = await menu(page).evaluate((el) => {
    const copy = [...el.querySelectorAll("[data-testid=own-view-item]")].find((n) =>
      n.textContent?.includes("Order flow copy"),
    );
    const heading = el.querySelector("[data-testid=team-group]");
    return copy && heading
      ? Boolean(copy.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)
      : false;
  });
  expect(order).toBe(true);
});

test("publish a personal view: the fake server gets it and the line says so; remove it and it leaves the Team heading", async ({
  page,
}) => {
  await page.goto(`${url}#/project-map?level=files&saved=order-flow-copy`);
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
  await openMenu(page);
  const mine = menu(page).getByRole("group", { name: "Your views" });
  await mine.getByRole("menuitem", { name: "More actions for Order flow copy" }).click();
  await expect(menu(page).getByRole("menuitem", { name: "Remove from team" })).toHaveCount(0);
  await shots(page, "publish-menu");
  await menu(page).getByRole("menuitem", { name: "Publish to team" }).click();
  const line = menu(page).getByTestId("views-result");
  await expect(line).toHaveText("Published to team.");
  await expect(line).toHaveAttribute("aria-live", "polite");
  expect(fake?.state.views.get(REPO)?.has("order-flow-copy")).toBe(true);
  // It stays under Your views with the Published marker and the check, and is not repeated under Team.
  await expect(teamItems(page).filter({ hasText: "Order flow copy" })).toHaveCount(0);
  await expect(mine.getByTestId("published-marker")).toBeVisible();
  await expect(mine.getByRole("menuitemradio", { name: /Order flow copy/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Opening it is not opening someone else's view: there is no read-only bar.
  await expect(page.getByTestId("team-view-bar")).toHaveCount(0);
  await shots(page, "published");
  await mine.getByRole("menuitem", { name: "More actions for Order flow copy" }).click();
  await menu(page).getByRole("menuitem", { name: "Remove from team" }).click();
  await expect(line).toHaveText("Removed from team.");
  expect(fake?.state.views.get(REPO)?.has("order-flow-copy")).toBe(false);
  await expect(teamItems(page).filter({ hasText: "Order flow copy" })).toHaveCount(0);
  await expect(mine.getByTestId("published-marker")).toHaveCount(0);
});

test("a refusal from the server (403) shows its reason inline and leaves the item as it was", async ({
  page,
}) => {
  await page.goto(`${url}#/project-map?level=files`);
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
  const curation = page.getByRole("region", { name: "Curation" });
  const groups = curation.getByRole("list", { name: "Team groups" });
  await expect(groups.getByText("Team group: read-only")).toHaveCount(2);
  const remove = groups.getByRole("button", { name: "Remove from team" }).first();
  await remove.click();
  const line = curation.getByTestId("group-result");
  await expect(line).toContainText("only an owner or admin may delete a group");
  await expect(curation.getByTestId("group-result-line")).toHaveAttribute("data-tone", "error");
  // The button was never disabled, so it kept focus through the request and the refusal.
  await expect(remove).toBeFocused();
  await expect(groups.getByText("Team group: read-only")).toHaveCount(2);
  expect(fake?.state.groups.get(REPO)?.size).toBe(2);
  await shots(page, "refused");
});

test("keyboard only: open the menu, move with the arrow keys, select with Enter, close with Escape", async ({
  page,
}) => {
  await page.goto(`${url}#/project-map?level=files`);
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? "");
  const first = await focused();
  await page.keyboard.press("ArrowDown");
  expect(await focused()).not.toBe(first);
  await page.keyboard.press("ArrowUp");
  expect(await focused()).toBe(first);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  // Walk to the team view "Catalog edges" and pick it.
  for (let i = 0; i < 30; i++) {
    if ((await focused()).includes("Catalog edges")) break;
    await page.keyboard.press("ArrowDown");
  }
  expect(await focused()).toContain("Catalog edges");
  await page.keyboard.press("Enter");
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain("saved=catalog-edges");
  await expect(trigger(page)).toContainText("Catalog edges");
  await expect(trigger(page)).toBeFocused();
});

test("keyboard only: publish a view from the menu, then Escape still closes it and returns focus to the button", async ({
  page,
}) => {
  await page.goto(`${url}#/project-map?level=files`);
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  const label = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  const MORE = "More actions for Order flow copy";
  for (let i = 0; i < 30 && (await label()) !== MORE; i++) await page.keyboard.press("ArrowDown");
  expect(await label()).toBe(MORE);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => document.activeElement?.textContent ?? "")).toContain("Publish to team");
  await page.keyboard.press("Enter");
  await expect(menu(page).getByTestId("views-result")).toHaveText("Published to team.");
  expect(fake?.state.views.get(REPO)?.has("order-flow-copy")).toBe(true);
  // Focus is back on the row's … button, inside the menu, so the keys still work.
  expect(await label()).toBe(MORE);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
});

test("without a team cache there is no Team heading and no publish items, and the select is as it was", async ({
  page,
}) => {
  await page.goto(`${plainUrl}#/project-map?level=files`);
  await expect(map(page)).toBeVisible({ timeout: 30_000 });
  const select = page.getByRole("combobox", { name: "Saved view" });
  await expect(select).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);
  await expect(page.getByText("Publish to team")).toHaveCount(0);
  await expect(page.getByText("Team group: read-only")).toHaveCount(0);
  await expect(page.getByTestId("team-view-bar")).toHaveCount(0);
  expect(await select.locator("option").allTextContents()).toEqual([
    "Saved views",
    "Save view…",
    "Reset curation…",
  ]);
  // Nothing about the team shows in the page text at all.
  expect(await page.locator("header.topbar").textContent()).not.toMatch(/team/i);
  await shots(page, "no-cache");
});
