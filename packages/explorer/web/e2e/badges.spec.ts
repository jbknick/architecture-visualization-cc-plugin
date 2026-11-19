import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");
const shots = join(repoRoot, "docs/milestones/screenshots");

// M2 badges (dup / undescribed / misleading) on the maps, against the REAL server: the pnpm-turbo fixture is copied into a temp git repo,
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

test("project map draws M2 badges on function tiles, with a legend and tooltips", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  const base = url.replace(/#.*$/, "");
  await page.goto(`${base}#/project-map?level=symbols&focus=ws%3A%40acme%2Futils`);
  const canvas = page.getByTestId("graph-canvas");
  await expect(canvas.locator(".gc-sigma[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  const probe = async () =>
    JSON.parse(
      await canvas.locator(".gc-sigma").evaluate((el) => {
        el.dispatchEvent(new CustomEvent("gantry:probe"));
        return (el as HTMLElement).dataset.probe ?? "{}";
      }),
    ) as { badged?: { id: string; badges: string[] }[] };
  const p = await probe();
  expect(p.badged?.length ?? 0).toBeGreaterThan(0);
  const badgesById = new Map((p.badged ?? []).map((b) => [b.id, b.badges]));
  // A fresh index has no descriptions; the duplicate pairs from `init` are badged.
  expect(badgesById.get("sym:pnpm-turbo:packages/utils/src/slug.ts#slugify")).toEqual(["dup", "undescribed"]);
  expect(badgesById.get("sym:pnpm-turbo:packages/utils/src/date.ts#formatRelativeDate")).toContain("dup");
  expect(badgesById.get("sym:pnpm-turbo:packages/utils/src/time.ts#parseTimestamp")).toContain("dup");
  const key = page.getByTestId("badge-key");
  await expect(key).toBeVisible();
  await expect(key.getByText("duplicate")).toBeVisible();
  await expect(key.getByText("undescribed")).toBeVisible();
  await expect(key.getByText("misleading name")).toBeVisible();
  await expect(key.locator("li", { hasText: "undescribed" })).toHaveAttribute("title", /No description yet/);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: join(shots, "badges-project-map-fixture.png") });
});

const probeOf = async (canvas: Locator) =>
  JSON.parse(
    await canvas.evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as { rects: { id: string; type: string; badges?: string[] }[] };

test("ego view draws badges on the focus card and on caller rows", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  const base = url.replace(/#.*$/, "");
  const canvas = page.getByTestId("graph-canvas");
  // parseTimestamp is one end of a duplicate pair and has no description.
  const tsId = "sym:pnpm-turbo:packages/utils/src/time.ts#parseTimestamp";
  await page.goto(`${base}#/ego?focus=${encodeURIComponent(tsId)}`);
  await expect(canvas.locator("canvas[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
  expect((await probeOf(canvas)).rects.find((r) => r.id === tsId)?.badges).toEqual(["dup", "undescribed"]);
  await expect(page.getByTestId("badge-key")).toBeVisible();

  // formatRelativeDate is used by PostPage: an undescribed caller, not a duplicate.
  const dateId = "sym:pnpm-turbo:packages/utils/src/date.ts#formatRelativeDate";
  await page.goto(`${base}#/ego?focus=${encodeURIComponent(dateId)}`);
  await page.reload();
  await expect(canvas.locator("canvas[data-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
  const rows = (await probeOf(canvas)).rects.filter((r) => r.type === "row" && r.id !== dateId);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((r) => r.badges?.includes("undescribed"))).toBe(true);
  expect(rows.some((r) => r.badges?.includes("dup"))).toBe(false);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: join(shots, "badges-ego-fixture.png") });
});

test("the inspector lists a function's badges with their meaning", async ({ page }) => {
  const base = url.replace(/#.*$/, "");
  const tsId = "sym:pnpm-turbo:packages/utils/src/time.ts#parseTimestamp";
  await page.goto(`${base}#/project-map?level=symbols&sel=${encodeURIComponent(tsId)}`);
  await page.reload();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "parseTimestamp" })).toBeVisible();
  await expect(inspector.getByText("Not yet described")).toBeVisible();
  const pills = inspector.getByRole("list", { name: /badges/i });
  await expect(pills.getByRole("listitem").filter({ hasText: /^dup$/ })).toHaveAttribute(
    "title",
    /duplicate/i,
  );
  await expect(pills.getByRole("listitem").filter({ hasText: /^undescribed$/ })).toHaveAttribute(
    "title",
    /No description yet/,
  );
});
