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

const BUTTON_FILE = "file:packages/ui/src/button.tsx";
const HOME_FILE = "file:apps/web/src/routes/index.tsx";
const HOME = "sym:apps/web/src/routes/index.tsx#HomePage";

interface ReviewProbe {
  positions: Record<string, [number, number]>;
  review: {
    changed: { id: string; change: string }[];
    affected: { id: string; hop: number }[];
    drawn: {
      changed: number;
      affected: number;
      faded: number;
      links: { src: string; dst: string; change: string; colour: string }[];
    } | null;
  } | null;
}

const surface = (page: Page) => page.getByTestId("graph-canvas").locator(".gc-sigma");

/** Waits for the 2D map to settle (laid out, camera still) and reads its probe. */
async function probe2d(page: Page): Promise<ReviewProbe> {
  const box = page.locator("[data-testid=graph-canvas] .gc-sigma[data-ready=true]");
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box).not.toHaveAttribute("data-moving", "true");
  return JSON.parse(
    await surface(page).evaluate((el) => {
      el.dispatchEvent(new CustomEvent("gantry:probe", { detail: { positions: true } }));
      return (el as HTMLElement).dataset.probe ?? "{}";
    }),
  ) as ReviewProbe;
}

/** The left panel's rows and the legend stay inside their boxes. */
async function expectTidy(page: Page) {
  const out = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll(".topbar .tab, .topbar .search, .topbar .repo-name")) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1) bad.push(`top bar item runs off the edge: ${el.className}`);
    }
    const canvas = document.querySelector("[data-testid=review-canvas]")?.getBoundingClientRect();
    const legend = document.querySelector(".rv-legend")?.getBoundingClientRect();
    if (canvas && legend && (legend.right > canvas.right + 1 || legend.bottom > canvas.bottom + 1))
      bad.push("legend leaves the canvas");
    for (const t of document.querySelectorAll(".rv-ring-label")) {
      const r = t.getBoundingClientRect();
      if (canvas && (r.left < canvas.left - 1 || r.right > canvas.right + 1))
        bad.push(`ring label leaves the canvas: ${t.textContent}`);
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

test("2D map: Button's file coloured by its change, caller files tinted, file-to-file lines, the rest faded; risk on the left", async ({
  page,
}) => {
  const t0 = Date.now();
  await open(page, "#/review?range=main...feature");
  const canvas = page.getByTestId("review-canvas");
  await expect(canvas).toHaveAttribute("data-mode", "map");
  await expect(canvas).toHaveAttribute("data-map", "2d");
  const p = await probe2d(page);
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(p.review?.changed).toContainEqual({ id: BUTTON_FILE, change: "signature" });
  expect(p.review?.affected).toContainEqual({ id: HOME_FILE, hop: 1 });
  const drawn = p.review?.drawn;
  expect(drawn?.changed).toBeGreaterThan(0);
  expect(drawn?.affected).toBeGreaterThan(0);
  expect(drawn?.faded).toBeGreaterThan(drawn?.changed ?? 0);
  expect(drawn?.links).toContainEqual(
    expect.objectContaining({ src: HOME_FILE, dst: BUTTON_FILE, change: "signature" }),
  );
  for (const l of drawn?.links ?? [])
    expect([BUTTON_FILE, "file:packages/utils/src/slug.ts"]).toContain(l.dst);

  await expect(page.getByRole("complementary", { name: "Review legend" })).toContainText("Signature changed");
  const risk = page.getByRole("region", { name: "Risk" });
  await expect(risk.getByText("Medium risk")).toBeVisible();
  await expect(risk.getByText("+30 signature changed on an exported symbol")).toBeVisible();
  await expect(page.getByRole("region", { name: "Changed files" }).getByRole("button")).toHaveCount(2);
  await expectTidy(page);
  await page.screenshot({ path: join(shots, "review-map-fixture.png") });
});

test("positions: every node of the review map sits exactly where it sits on the plain project map", async ({
  page,
}) => {
  for (const level of ["files", "symbols"]) {
    await open(page, `#/review?range=main...feature&level=${level}`);
    const review = await probe2d(page);
    await page.goto(`${base}#/project-map?level=${level}`);
    const plain = await probe2d(page);
    expect(Object.keys(review.positions).length).toBeGreaterThan(10);
    expect(review.positions).toEqual(plain.positions);
    expect(plain.review).toBeNull();
  }
});

test("function level: Button itself coloured, a function-to-function line from HomePage", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature&level=symbols");
  const p = await probe2d(page);
  expect(p.review?.changed).toContainEqual({ id: BUTTON, change: "signature" });
  expect(p.review?.drawn?.links).toContainEqual(
    expect.objectContaining({ src: HOME, dst: BUTTON, change: "signature" }),
  );
});

test("clicking a changed symbol in the panel focuses its file on the map and opens the inspector", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature");
  await probe2d(page);
  await page
    .getByRole("region", { name: "Changed symbols" })
    .getByRole("button", { name: /Button/ })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`sel=${encodeURIComponent(BUTTON).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const change = inspector.getByRole("region", { name: "Change in this review" });
  await expect(change.locator("[data-side=before]")).toContainText("onClick?: () => void }");
  await expect(change.locator("[data-side=after]")).toContainText("size?: number");
  // The map zoomed in to the file that holds Button.
  await expect(page.getByTestId("map-crumb")).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: join(shots, "review-inspector-fixture.png") });
});

test("a focus-only deep link (as gantry_open_view returns) opens that symbol in the inspector", async ({
  page,
}) => {
  await open(page, `#/review?focus=${encodeURIComponent(BUTTON)}&range=main...feature`);
  const heading = page.locator("aside[aria-label=Inspector] h2").first();
  await expect(heading).toHaveAttribute("title", BUTTON);
});

test("3D map: the settlements with Button's building coloured, caller buildings tinted, arcs between them", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature");
  await page.getByRole("radio", { name: "3D map" }).click();
  await expect(page).toHaveURL(/map=3d/);
  await expect(page.getByTestId("review-canvas")).toHaveAttribute("data-map", "3d");
  await expect(page.locator(".map3d[data-ready='true'][data-style='settlements']")).toBeVisible({
    timeout: 30_000,
  });
  const host = page.getByTestId("map3d-canvas");
  await expect(host).toHaveAttribute("data-review", /signature|packages/, { timeout: 20_000 });
  const review = JSON.parse((await host.getAttribute("data-review")) ?? "null") as {
    changed: string[];
    affected: string[];
    faded: number;
    links: { src: string; dst: string; change: string }[];
  };
  expect(review.changed).toContain(BUTTON_FILE);
  expect(review.affected).toContain(HOME_FILE);
  expect(review.faded).toBeGreaterThan(review.changed.length);
  expect(review.links).toContainEqual({ src: HOME_FILE, dst: BUTTON_FILE, change: "signature" });
  await page.getByTestId("map3d-pause").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "review-3d-fixture.png") });
});

test("rings: plain-words ring labels with counts, file groups, names on changed nodes, hover keeps the path", async ({
  page,
}) => {
  await open(page, "#/review?range=main...feature&mode=rings");
  const canvas = page.getByTestId("review-canvas");
  await expect(canvas).toHaveAttribute("data-mode", "rings");
  await expect(
    canvas.getByText("Centre: what changed. Each ring out: code that calls the ring inside it."),
  ).toBeVisible();
  await expect(canvas.getByText(/^Changed in this range \(2\)$/)).toBeVisible();
  await expect(canvas.getByText(/^Call the changed code directly \(\d+\)$/)).toBeVisible();
  expect(await canvas.locator(".rv-group-label").count()).toBeGreaterThan(1);
  const button = canvas.getByRole("button", { name: "Button, modified, signature changed" });
  await expect(button.locator("circle")).toHaveClass(/rv-fill-signature/);
  await expect(canvas.locator(".rv-label", { hasText: "Button" })).toBeVisible();
  const home = canvas.getByRole("button", { name: "HomePage, calls the changed code directly" });
  await home.locator("circle").hover();
  await expect(canvas.getByRole("tooltip")).toContainText("apps/web/src/routes/index.tsx");
  await expect(home).not.toHaveClass(/rv-dim/);
  await expect(canvas.getByRole("button", { name: /slugifyAll, added/ })).toHaveClass(/rv-dim/);
  await expect(canvas.locator(`[data-edge="${HOME}->${BUTTON}"]`)).toHaveClass(/rv-edge-hot/);
  await page.mouse.move(2, 2);
  await expectTidy(page);
  await page.screenshot({ path: join(shots, "review-rings-fixture.png") });
});

test("dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, "#/review?range=main...feature");
  await probe2d(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(243, 244, 247)");
  await expectTidy(page);
  await page.screenshot({ path: join(shots, "review-map-fixture-dark.png") });
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
  for (const view of ["review", "project-map"]) {
    expect((await request.get(`${u.origin}/api/view/${view}?filters=${q}`)).status()).toBe(403);
    const token = u.searchParams.get("t") ?? "";
    const ok = await request.get(`${u.origin}/api/view/${view}?filters=${q}`, {
      headers: { "x-gantry-token": token },
    });
    expect(ok.status()).toBe(200);
    const evil = await request.get(`${u.origin}/api/view/${view}?filters=${q}`, {
      headers: { "x-gantry-token": token, origin: "http://evil.example" },
    });
    expect(evil.status()).toBe(403);
    const badHost = await request.get(`${u.origin}/api/view/${view}?filters=${q}`, {
      headers: { "x-gantry-token": token, host: "evil.example" },
    });
    expect(badHost.status()).toBe(403);
  }
});
