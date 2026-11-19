import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

// Refresh on request (spec section 11 (c), issue #40) against the REAL server: the pnpm-turbo fixture is copied into a
// temp git repo, indexed, served by `gantry map --no-open`, then edited on disk. Needs `pnpm build` first.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");
const EDITED = "packages/utils/src/slug.ts";

test.describe.configure({ mode: "serial" });
test.use({
  viewport: { width: 1440, height: 900 },
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
});

let tmp = "";
let repo = "";
let server: ChildProcess | undefined;
let url = "";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  tmp = mkdtempSync(join(tmpdir(), "gantry-e2e-refresh-"));
  repo = join(tmp, "pnpm-turbo");
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
    server?.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) ok(line);
    });
    server?.on("exit", (code) => fail(new Error(`gantry map exited with ${code}`)));
  });
});

test.afterAll(() => {
  server?.kill("SIGINT");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

interface Probe {
  positions: Record<string, [number, number]>;
  kept: boolean;
  generation: number;
  fresh: string[];
}

const surface = (page: Page) => page.getByTestId("graph-canvas").locator(".gc-sigma");

async function probe(page: Page): Promise<Probe> {
  return JSON.parse(
    await surface(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe", { detail: { positions: true } }));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as Probe;
}

test("edit a file, see the marker, refresh: the new function is highlighted and nothing else moved", async ({
  page,
}) => {
  const target = new URL(url);
  target.hash = "#/project-map?level=symbols";
  await page.goto(target.toString());
  await expect(surface(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(page.getByTestId("stale-marker")).toHaveCount(0);
  const before = await probe(page);
  expect(Object.keys(before.positions).length).toBeGreaterThan(20);

  // Save in the editor: one new function in one file.
  const original = readFileSync(join(repo, EDITED), "utf8");
  writeFileSync(
    join(repo, EDITED),
    `${original}\nexport function refreshedSlugHelper(value: string): string {\n  return value.trim();\n}\n`,
  );
  // The first request after the save carries the stale count (here: the tab gets focus back).
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("stale-marker")).toHaveText("Out of date (1 file)");

  const refreshed = page.waitForResponse((r) => r.url().endsWith("/api/refresh") && r.status() === 200);
  await page.getByRole("button", { name: "Refresh" }).click();
  const body = (await (await refreshed).json()) as {
    changed: { files: number; functions: number };
    files: string[];
    functions: { added: string[] };
  };
  expect(body.changed).toEqual({ files: 1, functions: 1 });
  const added = body.functions.added[0] as string;
  expect(added).toContain("refreshedSlugHelper");

  await expect.poll(async () => (await probe(page)).fresh, { timeout: 15_000 }).toEqual([added]);
  await expect(page.getByTestId("stale-marker")).toHaveCount(0);
  const after = await probe(page);
  expect(after.kept).toBe(true);
  expect(after.generation).toBe(1);
  expect(after.positions[added]).toBeDefined();

  // Every node outside the changed file is exactly where it was (the file itself keeps its cell too).
  const changedFile = `file:pnpm-turbo:${EDITED}`;
  const unchanged = Object.keys(before.positions).filter((id) => !id.startsWith(`sym:pnpm-turbo:${EDITED}`));
  expect(unchanged).toContain(changedFile);
  for (const id of unchanged) expect(after.positions[id], id).toEqual(before.positions[id]);
});
