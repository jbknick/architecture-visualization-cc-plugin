import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");

// The explorer's chrome is built from the UI kit (SmoothUI components, shadcn primitives, Hugeicons). This spec opens
// every view of the built explorer, served by the real `gantry map` on fixtures/pnpm-turbo, in light and dark, with
// reduced motion forced (so nothing animates and a screenshot is stable), and checks that the chrome is there and that
// nothing logged an error or broke the server's Content-Security-Policy. Needs `pnpm build` first (pnpm e2e does it).
test.describe.configure({ mode: "serial" });
test.use({
  reducedMotion: "reduce",
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
});

let tmp = "";
let server: ChildProcess | undefined;
let url = "";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  tmp = mkdtempSync(join(tmpdir(), "gantry-e2e-ui-kit-"));
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

for (const scheme of ["light", "dark"] as const) {
  test(`every view's chrome renders in ${scheme}, with Hugeicons in the top bar and no console error or CSP violation`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || /content security policy|violat/i.test(m.text())) problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(String(e)));

    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto(url);
    await expect(page.getByRole("tab", { name: "Project map" })).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
      scheme === "dark",
    );
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    const topbar = page.locator("header.topbar");
    const left = page.getByRole("complementary", { name: "Filters" });
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const status = page.locator("footer.statusbar");
    const search = page.getByRole("combobox", { name: "Search symbols" });

    // The tabs are the server's view list; the debug view's tab is a developer aid and not shown by default.
    const names = (await page.getByRole("tab").allTextContents()).map((t) => t.trim()).filter(Boolean);
    expect(names).toEqual(
      expect.arrayContaining([
        "Project map",
        "Function ego graph",
        "Duplicates",
        "Pages",
        "Feature slices",
        "Review",
      ]),
    );
    // The cross-stack views (#48) are tabs too.
    expect(names.length).toBeGreaterThanOrEqual(10);

    const open = async (tab: string) => {
      if (tab === "Review") {
        await page.goto(`${url.split("#")[0]}#/review?range=HEAD~0...HEAD`);
        await page.reload();
      } else {
        // The strip scrolls sideways: a tab off the end is brought into sight by the scroll buttons or its own focus.
        const t = page.getByRole("tab", { name: tab, exact: true });
        await t.scrollIntoViewIfNeeded();
        await t.click();
        await expect(t).toHaveAttribute("aria-selected", "true");
      }
      await expect(topbar).toBeVisible();
      await expect(left).toBeVisible();
      await expect(status).toBeVisible();
      // At least one svg drawn by HugeiconsIcon sits in the top bar (the refresh and search icons).
      expect(await topbar.locator("svg").count()).toBeGreaterThan(0);
    };

    for (const tab of names) {
      if (tab.startsWith("Debug")) continue;
      await open(tab);
      // Select a node through search (it works the same in every view) and check the inspector shows its name.
      await search.fill("Button");
      await expect(page.getByRole("option", { name: /Button/ }).first()).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(inspector).toBeVisible();
      await expect(inspector.getByRole("heading", { name: "Button" }).first()).toBeVisible();
      await expect(topbar).toBeVisible();
      await expect(status).toBeVisible();
      await inspector.getByRole("button", { name: "Close inspector" }).click();
      await expect(inspector).toHaveCount(0);
    }

    // The review view with a range, opened by link as the review spec does.
    await open("Review");
    await expect(page.getByRole("textbox", { name: "Range to review" })).toHaveValue("HEAD~0...HEAD");
    await search.fill("Button");
    await expect(page.getByRole("option", { name: /Button/ }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(inspector.getByRole("heading", { name: "Button" }).first()).toBeVisible();
    await expect(topbar).toBeVisible();
    await expect(left).toBeVisible();
    await expect(status).toBeVisible();

    expect(problems, "console errors / CSP violations / page errors").toEqual([]);
  });
}
