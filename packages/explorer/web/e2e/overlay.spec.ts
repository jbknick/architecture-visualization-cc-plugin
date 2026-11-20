import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");
const shots = join(repoRoot, "docs/milestones/screenshots");

// The curation controls (rename, hide, group, saved views, reset) against the REAL server on public data:
// fixtures/pnpm-turbo in a temp git repo. Needs `pnpm build` first.
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", colorScheme: "light" });

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
const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: join(tmp, "home"),
  CLAUDE_PLUGIN_DATA: join(tmp, "data"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Gantry Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Gantry Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});
let repo = "";
const fileIds: Record<string, string> = {};

const WEB_SLUG = "apps/web/src/lib/slug.ts";
const INTERNAL = "packages/ui/src/internal.ts";
const DATE = "packages/utils/src/date.ts";
const TIME = "packages/utils/src/time.ts";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  tmp = mkdtempSync(join(tmpdir(), "gantry-e2e-overlay-"));
  repo = join(tmp, "pnpm-turbo");
  cpSync(join(repoRoot, "fixtures/pnpm-turbo"), repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: env(), stdio: "ignore" });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  execFileSync("node", [cliJs, "init"], { cwd: repo, env: env(), stdio: "ignore", timeout: 100_000 });
  for (const p of [WEB_SLUG, INTERNAL, DATE, TIME]) {
    const out = execFileSync("node", [cliJs, "node", p, "--json"], {
      cwd: repo,
      env: env(),
      encoding: "utf8",
    });
    fileIds[p] = (JSON.parse(out) as { node: { id: string } }).node.id;
  }

  server = spawn("node", [cliJs, "map", "--no-open", "--port", "47812"], {
    cwd: repo,
    env: env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
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

const sel = (p: string) => `#/project-map?level=files&sel=${encodeURIComponent(fileIds[p] as string)}`;
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const curation = (page: Page) => page.getByRole("region", { name: "Curation" });
const savedView = (page: Page) => page.getByRole("combobox", { name: "Saved view" });

/** The paths of the files in the project map's files level, as the server sends them now. */
async function viewPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const r = await fetch("/api/view/project-map?level=files", { credentials: "same-origin" });
    const body = (await r.json()) as { nodes: { path?: string }[] };
    return body.nodes.flatMap((n) => (n.path ? [n.path] : []));
  });
}

async function open(page: Page, hash: string) {
  await page.goto(`${base}${hash}`);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toBeVisible({ timeout: 30_000 });
}

/** The top bar, the left panel and the inspector must fit: nothing wider than the window, no control off screen. */
async function expectFits(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0);
  for (const name of ["Saved view", "Refresh"]) {
    const box = await page.getByRole(name === "Refresh" ? "button" : "combobox", { name }).boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0), `${name} inside the window`).toBeLessThanOrEqual(
      (page.viewportSize()?.width ?? 0) + 0.5,
    );
  }
}

async function shoot(page: Page, name: string) {
  mkdirSync(shots, { recursive: true });
  await expect(page.locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

test("rename, hide, group, save a view, reload, switch and reset", async ({ page }) => {
  test.setTimeout(180_000);

  // 1. Rename
  await open(page, sel(WEB_SLUG));
  await inspector(page).getByRole("button", { name: "Rename", exact: true }).click();
  const label = inspector(page).getByRole("textbox", { name: "Label" });
  await label.fill("Web slug helper");
  await label.press("Enter");
  await expect(inspector(page).getByRole("heading", { name: "Web slug helper" })).toBeVisible();
  await expect(page.getByText("Web slug helper").first()).toBeVisible();
  await expect(inspector(page).getByText(/Original name/)).toBeVisible();
  await expect(curation(page).getByText("Web slug helper")).toBeVisible();

  // 2. Hide
  await page.goto(`${base}${sel(INTERNAL)}`);
  await expect(inspector(page).getByRole("button", { name: "Hide", exact: true })).toBeVisible();
  expect(await viewPaths(page)).toContain(INTERNAL);
  await inspector(page).getByRole("button", { name: "Hide", exact: true }).click();
  await expect(curation(page).getByRole("button", { name: "Show again" })).toBeVisible();
  expect(await viewPaths(page)).not.toContain(INTERNAL);
  await expect(curation(page).getByText(INTERNAL)).toBeVisible();

  // 3. Group: create Dates from date.ts, add time.ts
  await page.goto(`${base}${sel(DATE)}`);
  await expect(inspector(page).getByRole("combobox", { name: "Group" })).toBeVisible();
  await inspector(page).getByRole("combobox", { name: "Group" }).selectOption({ label: "New group…" });
  const newGroup = page.getByRole("dialog", { name: "New group" });
  await shoot(page, "overlay-new-group-light");
  await newGroup.getByRole("textbox", { name: "Name" }).fill("Dates");
  await newGroup.getByRole("button", { name: "Create" }).click();
  await expect(newGroup).toBeHidden();
  await page.goto(`${base}${sel(TIME)}`);
  await expect(inspector(page).getByRole("combobox", { name: "Group" })).toBeVisible();
  await inspector(page).getByRole("combobox", { name: "Group" }).selectOption({ label: "Dates" });
  const groups = curation(page).getByRole("list", { name: "Groups" });
  await expect(groups.getByText("Dates", { exact: true })).toBeVisible();
  await expect(groups.getByText("2 members")).toBeVisible();

  // 4. Save view
  await savedView(page).selectOption({ label: "Save view…" });
  const save = page.getByRole("dialog", { name: "Save view" });
  await shoot(page, "overlay-save-view-light");
  await save.getByRole("textbox", { name: "Name" }).fill("Curated");
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect(save).toBeHidden();
  await expect(savedView(page).locator("option", { hasText: "Curated" })).toHaveCount(1);

  // 5. Reload
  await page.reload();
  await expect(savedView(page)).toBeVisible({ timeout: 30_000 });

  // 6. All four are still there
  await expect(curation(page).getByText("Web slug helper")).toBeVisible();
  expect(await viewPaths(page)).not.toContain(INTERNAL);
  await expect(groups.getByText("Dates", { exact: true })).toBeVisible();
  await expect(groups.getByText("2 members")).toBeVisible();
  await expect(savedView(page).locator("option", { hasText: "Curated" })).toHaveCount(1);
  await page.evaluate(() => {
    window.location.hash = "#/project-map?level=files";
  });
  await savedView(page).selectOption({ label: "Curated" });
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/project-map?saved=curated");

  // Screenshots of the new and changed controls, light and dark, at 1440 and 1024 px.
  await page.goto(`${base}${sel(WEB_SLUG)}`);
  await expect(inspector(page).getByText(/Original name/)).toBeVisible();
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectFits(page);
      await curation(page).scrollIntoViewIfNeeded();
      await shoot(page, `overlay-curation-${width}-${scheme}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await inspector(page).getByRole("button", { name: "Rename", exact: true }).click();
    await expect(inspector(page).getByRole("textbox", { name: "Label" })).toBeVisible();
    await shoot(page, `overlay-rename-${scheme}`);
    await inspector(page).getByRole("textbox", { name: "Label" }).press("Escape");
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await inspector(page).getByRole("combobox", { name: "Group" }).selectOption({ label: "New group…" });
  await shoot(page, "overlay-new-group-dark");
  await page.getByRole("dialog", { name: "New group" }).getByRole("button", { name: "Cancel" }).click();
  await savedView(page).selectOption({ label: "Save view…" });
  await shoot(page, "overlay-save-view-dark");
  await page.getByRole("dialog", { name: "Save view" }).getByRole("button", { name: "Cancel" }).click();
  await savedView(page).selectOption({ label: "Reset curation…" });
  await shoot(page, "overlay-reset-dark");
  await page.getByRole("dialog", { name: "Reset curation" }).getByRole("button", { name: "Cancel" }).click();
  await page.emulateMedia({ colorScheme: "light" });

  // 7. Reset
  await savedView(page).selectOption({ label: "Reset curation…" });
  await shoot(page, "overlay-reset-light");
  await page
    .getByRole("dialog", { name: "Reset curation" })
    .getByRole("button", { name: "Reset", exact: true })
    .click();
  await expect(curation(page).getByText(/Nothing renamed, hidden or grouped/)).toBeVisible();
  await expect(savedView(page).locator("option", { hasText: "Curated" })).toHaveCount(0);
  expect(await viewPaths(page)).toContain(INTERNAL);
});
