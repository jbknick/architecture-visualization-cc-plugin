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
  writeFileSync(
    button,
    readFileSync(button, "utf8").replace(
      "{ label, onClick }: { label: string; onClick?: () => void }",
      "{ label, onClick, size }: { label: string; onClick?: () => void; size?: number }",
    ),
  );
  const slug = join(repo, "packages/utils/src/slug.ts");
  writeFileSync(
    slug,
    `${readFileSync(slug, "utf8")}export function slugifyAll(xs: string[]): string[] {\n  return xs.map(slugify);\n}\n`,
  );
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
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

/** Labels inside the SVG stay inside the canvas and the left panel's rows do not overflow it. */
async function expectTidy(page: Page) {
  const out = await page.evaluate(() => {
    const bad: string[] = [];
    const canvas = document.querySelector("[data-testid=review-canvas]")?.getBoundingClientRect();
    if (!canvas) return ["no canvas"];
    // The top bar holds one more tab now: everything in it, the search box included, stays on screen.
    for (const el of document.querySelectorAll(".topbar .tab, .topbar .search, .topbar .repo-name")) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1) bad.push(`top bar item runs off the edge: ${el.className}`);
    }
    for (const t of document.querySelectorAll(".rv-label, .rv-ring-label")) {
      const r = t.getBoundingClientRect();
      if (r.left < canvas.left - 1 || r.right > canvas.right + 1)
        bad.push(`label leaves the canvas: ${t.textContent}`);
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

test("rings: Button in the centre with its signature outlined, callers on rings, risk and reasons on the left", async ({
  page,
}) => {
  const t0 = Date.now();
  await open(page, "#/review?range=main...feature");
  expect(Date.now() - t0).toBeLessThan(10_000);
  const canvas = page.getByTestId("review-canvas");
  await expect(canvas).toHaveAttribute("data-mode", "rings");
  const button = canvas.getByRole("button", { name: "Button, modified" });
  await expect(button).toBeVisible();
  await expect(button.locator("circle")).toHaveClass(/rv-sig/);
  await expect(canvas.getByRole("button", { name: "slugifyAll, added" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "HomePage, hop 1 callers" })).toBeVisible();
  await expect(canvas.getByText(/^Hop 1 callers \(\d+\)$/)).toBeVisible();

  const risk = page.getByRole("region", { name: "Risk" });
  await expect(risk.getByText("Medium risk")).toBeVisible();
  await expect(risk.getByText("+30 signature changed on an exported symbol")).toBeVisible();
  const files = page.getByRole("region", { name: "Changed files" });
  await expect(files.getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Crossings" }).getByRole("button").first()).toBeVisible();
  await expectTidy(page);
  await page.screenshot({ path: join(shots, "review-rings-fixture.png") });
});

test("clicking a ring node opens the inspector with the signature before and after", async ({ page }) => {
  await open(page, "#/review?range=main...feature");
  await page
    .getByTestId("review-canvas")
    .getByRole("button", { name: "Button, modified" })
    .locator("circle")
    .click();
  await expect(page).toHaveURL(
    new RegExp(`sel=${encodeURIComponent(BUTTON).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const change = inspector.getByRole("region", { name: "Change in this review" });
  await expect(change.locator("[data-side=before]")).toContainText("onClick?: () => void }");
  await expect(change.locator("[data-side=after]")).toContainText("size?: number");
  await expect(change.getByText(/direct callers?/)).toBeVisible();
  // A left-panel item focuses its node too.
  await page
    .getByRole("region", { name: "Changed symbols" })
    .getByRole("button", { name: /slugifyAll/ })
    .click();
  await expect(inspector.getByRole("heading", { name: "slugifyAll" })).toBeVisible();
  await expect(change.getByText("Added")).toBeVisible();
  await page.screenshot({ path: join(shots, "review-inspector-fixture.png") });
});

test("a focus-only deep link (as gantry_open_view returns) opens that symbol in the inspector", async ({
  page,
}) => {
  await open(page, `#/review?focus=${encodeURIComponent(BUTTON)}&range=main...feature`);
  const heading = page.locator("aside[aria-label=Inspector] h2").first();
  await expect(heading).toHaveAttribute("title", BUTTON);
});

test("overlay: the project map with the changed file and the caller files lit, the rest dimmed", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature");
  await page.getByRole("radio", { name: "Map overlay" }).click();
  await expect(page).toHaveURL(/mode=overlay/);
  const canvas = page.locator("[data-testid=review-canvas][data-mode=overlay]");
  await expect(canvas).toBeVisible();
  await expect(canvas.locator('[data-mark="changed"]')).toHaveCount(2);
  expect(await canvas.locator('[data-mark="affected"]').count()).toBeGreaterThan(0);
  expect(await canvas.locator('[data-mark="none"]').count()).toBeGreaterThan(0);
  await canvas.locator('[data-id="file:packages/ui/src/button.tsx"]').click();
  await expect(
    page.getByRole("complementary", { name: "Inspector" }).getByRole("heading", { name: "button.tsx" }),
  ).toBeVisible();
  await page.screenshot({ path: join(shots, "review-overlay-fixture.png") });
});

test("dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, "#/review?range=main...feature");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(243, 244, 247)");
  await expectTidy(page);
  await page.screenshot({ path: join(shots, "review-rings-fixture-dark.png") });
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
  expect((await request.get(`${u.origin}/api/view/review?filters=${q}`)).status()).toBe(403);
  const token = u.searchParams.get("t") ?? "";
  const ok = await request.get(`${u.origin}/api/view/review?filters=${q}`, {
    headers: { "x-gantry-token": token },
  });
  expect(ok.status()).toBe(200);
  const evil = await request.get(`${u.origin}/api/view/review?filters=${q}`, {
    headers: { "x-gantry-token": token, origin: "http://evil.example" },
  });
  expect(evil.status()).toBe(403);
});
