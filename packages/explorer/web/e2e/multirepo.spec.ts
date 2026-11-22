import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cliJs = join(repoRoot, "plugin/dist/cli.js");

// The built explorer against the real server, on a workspace of two repos: fixtures/multirepo is copied to a temp
// dir, `web/` and `api/` become two git repos, `gantry init` indexes both and `gantry map --no-open` serves them.
// Needs `pnpm build` first.
test.describe.configure({ mode: "serial" });
test.use({
  reducedMotion: "reduce",
  viewport: { width: 1440, height: 900 },
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
});

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
let url = "";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(cliJs)) throw new Error("plugin/dist/cli.js is missing: run `pnpm build` first");
  tmp = mkdtempSync(join(tmpdir(), "gantry-e2e-multirepo-"));
  const root = join(tmp, "multirepo");
  cpSync(join(repoRoot, "fixtures/multirepo"), root, { recursive: true });
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
  for (const repo of ["web", "api"]) {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: join(root, repo), env, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
  }
  const web = join(root, "web");
  execFileSync("node", [cliJs, "init"], { cwd: web, env, stdio: "ignore", timeout: 100_000 });
  server = spawn("node", [cliJs, "map", "--no-open", "--port", "47821"], {
    cwd: web,
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

interface Region {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Probe {
  groups: (Region & { label: string })[];
  regions: Region[];
  edges: { crossRepo: boolean }[];
}

const canvas = (page: Page) => page.getByTestId("graph-canvas").locator(".gc-sigma");

/** The canvas's probe once the layout for the current level is drawn (`data-ready`); `groups` is set by then. */
async function probe(page: Page): Promise<Probe> {
  await expect(page.getByTestId("graph-canvas").locator(".gc-sigma[data-ready=true]")).toBeVisible();
  const p = JSON.parse(
    await canvas(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe"));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as Partial<Probe>;
  return { groups: p.groups ?? [], regions: p.regions ?? [], edges: p.edges ?? [] };
}

const inside = (inner: Region, outer: Region) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

test("the project map groups the workspaces by repo and draws the dependency between them", async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.getByTestId("graph-canvas").locator(".gc-sigma[data-ready=true]")).toBeVisible({
    timeout: 30_000,
  });
  const levels = page.getByRole("radiogroup", { name: "Detail level" });

  // Repos level: two boxes, one edge between them.
  const reposResponse = page.waitForResponse(
    (r) => r.url().includes("/api/view/project-map") && r.url().includes("level=repos"),
  );
  await levels.getByRole("radio", { name: "Repos" }).click();
  const repos = (await (await reposResponse).json()) as {
    edges: { src: string; dst: string; crossRepo?: boolean }[];
  };
  expect(repos.edges).toHaveLength(1);
  expect(repos.edges[0]).toMatchObject({ src: "repo:web", dst: "repo:acme/api", crossRepo: true });
  await expect
    .poll(async () => (await probe(page)).groups.map((g) => g.label).sort())
    .toEqual(["acme/api", "web"]);
  await expect.poll(async () => (await probe(page)).edges.map((e) => e.crossRepo)).toEqual([true]);

  // Workspaces level: the workspaces sit inside their repo's container.
  await levels.getByRole("radio", { name: "Workspaces" }).click();
  await expect.poll(async () => (await probe(page)).regions.length).toBe(3);
  const p = await probe(page);
  const group = (label: string) => p.groups.find((g) => g.label === label) as Region;
  expect(p.groups.map((g) => g.label).sort()).toEqual(["acme/api", "web"]);
  const region = (id: string) => p.regions.find((r) => r.id === id) as Region;
  expect(inside(region("ws:web:."), group("web"))).toBe(true);
  expect(inside(region("ws:acme/api:mr-server"), group("acme/api"))).toBe(true);
  expect(inside(region("ws:acme/api:@mr/contracts"), group("acme/api"))).toBe(true);
  expect(inside(region("ws:web:."), group("acme/api"))).toBe(false);
  expect(p.edges.some((e) => e.crossRepo)).toBe(true);

  // Filter to one repo.
  await page.getByRole("region", { name: "Repos" }).getByRole("checkbox", { name: "acme/api" }).click();
  await expect.poll(async () => (await probe(page)).groups.map((g) => g.label)).toEqual(["web"]);
  await expect.poll(async () => (await probe(page)).regions.map((r) => r.id)).toEqual(["ws:web:."]);
});
