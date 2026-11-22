import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");

// The review view's reachable tier against the REAL server on the deep-radius fixture (`main` and a `feature` branch
// that changes `base`): the outer ring "4 or more calls away", a hub that expands on click, and the panel's
// "Reachable" group. Needs `pnpm build` first.
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });

// The hub's users (the fixture's `hubUsers.ts` files), as node ids.
const USERS = '[data-id*="webUser"], [data-id*="apiUser"]';

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
  tmp = mkdtempSync(join(tmpdir(), "gantry-e2e-deep-"));
  const repo = join(tmp, "repo");
  execFileSync("pnpm", ["exec", "tsx", "scripts/fixture-repo.ts", "deep-radius", repo], {
    cwd: repoRoot,
    stdio: "ignore",
    timeout: 100_000,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(tmp, "home"),
    CLAUDE_PLUGIN_DATA: join(tmp, "data"),
  };
  execFileSync("node", [cliJs, "init"], { cwd: repo, env, stdio: "ignore", timeout: 100_000 });
  server = spawn("node", [cliJs, "map", "--no-open", "--port", "47821"], {
    cwd: repo,
    env,
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

test("rings: one outer ring for hop 4 and more, a hub that expands and collapses, the panel's Reachable group", async ({
  page,
}) => {
  // 1. Rings mode.
  await page.goto(`${base}#/review?range=main...feature&mode=rings`);
  const canvas = page.getByTestId("review-canvas");
  await expect(canvas).toHaveAttribute("data-mode", "rings", { timeout: 30_000 });
  await expect(page.locator("[data-testid=review-canvas][data-ready=true]")).toBeVisible();

  // 2. One outer ring, no ring past it.
  await expect(canvas.locator(".rv-ring-reachable")).toHaveCount(1);
  await expect(canvas.locator('[data-hop="5"]')).toHaveCount(0);
  await expect(canvas.getByText(/^4 or more calls away \(\d+\)$/)).toBeVisible();

  // 3. The hub is collapsed: its users are not on the canvas.
  const hub = canvas.getByRole("button", { name: /^hub, \d+ consumers, collapsed$/ });
  await expect(hub).toBeVisible();
  await expect(canvas.locator(USERS)).toHaveCount(0);

  // 4. Click it: it expands, its users appear; click again: it collapses.
  await hub.click();
  const open = canvas.getByRole("button", { name: /^hub, \d+ consumers, expanded$/ });
  await expect(open).toHaveAttribute("aria-expanded", "true");
  await expect(canvas.locator(USERS).first()).toBeVisible();
  await open.click();
  await expect(canvas.getByRole("button", { name: /^hub, \d+ consumers, collapsed$/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(canvas.locator(USERS)).toHaveCount(0);
  // The keyboard does the same.
  await canvas.getByRole("button", { name: /^hub, \d+ consumers, collapsed$/ }).focus();
  await page.keyboard.press("Enter");
  await expect(canvas.getByRole("button", { name: /^hub, \d+ consumers, expanded$/ })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(canvas.getByRole("button", { name: /^hub, \d+ consumers, collapsed$/ })).toBeVisible();

  // 5. The left panel: select the change `base`; Reachable (n) has a hub row listing both app workspaces.
  await page.getByRole("region", { name: "Changed symbols" }).getByRole("button", { name: /^base/ }).click();
  const tiers = page.getByRole("region", { name: "Consumers of base" });
  await expect(tiers.getByRole("heading", { name: /^Reachable \(\d+\)$/ })).toBeVisible();
  const row = tiers.getByRole("button", { name: /^hub · \d+ consumers$/ });
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(tiers.getByText(/^@deep\/web \(\d+\)$/)).toBeVisible();
  await expect(tiers.getByText(/^@deep\/api \(\d+\)$/)).toBeVisible();
});
