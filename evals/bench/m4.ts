/**
 * M4 regression benchmark (issue #40): the explorer's Refresh on request (spec section 11 (c)).
 *
 * Usage: pnpm build && pnpm tsx evals/bench/m4.ts [<repo>|fixture] [--out <private dir>] [--edits 1,5,20]
 *        [--repeat 3] [--gl metal|swiftshader] [--headed] [--level symbols]
 *
 * <repo> is a git repository; it is never edited: the script `git clone`s it into a scratch directory and edits the
 * clone. `fixture` (the default) copies fixtures/pnpm-turbo into a throwaway git repo. The data directory
 * (CLAUDE_PLUGIN_DATA) is in the scratch directory too (set TMPDIR to choose where that is).
 *
 * For every edit count n (repeated --repeat times): append one new exported function to n source files of the clone,
 * then
 *   marker    one GET /api/meta: does `stale.files` say n (the "Out of date" marker appears within one request)
 *   server    POST /api/refresh: wall time and the server's own `ms`, and what it says changed
 *   browser   the project map open at --level (default: Functions): focus event, the marker shows, click Refresh, time
 *             until the canvas has drawn the new layout with every new function highlighted ("shows the new code")
 *   moved     positions of every node outside the edited files, before and after: how many moved (must be 0)
 * plus the cost of the stale check itself (GET /api/meta with and without dirty files).
 * Output: aggregate numbers only (counts, ms, yes/no) on stdout, and in <out>/m4.json with --out (keep that directory
 * outside any public repo). Nothing printed names a path, a file or a symbol of <repo>.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathOfId } from "../../packages/core/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cli = join(root, "plugin", "dist", "cli.js");
const requireFromExplorer = createRequire(join(root, "packages", "explorer", "package.json"));
// biome-ignore lint/suspicious/noExplicitAny: playwright is resolved from packages/explorer at run time
const pw = requireFromExplorer("playwright") as any;
// biome-ignore lint/suspicious/noExplicitAny: playwright types are not resolvable from this directory
type Page = any;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);
const positional = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const target = positional ?? "fixture";
const outDir = arg("--out") ? resolve(arg("--out") as string) : undefined;
const edits = (arg("--edits") ?? "1,5,20").split(",").map(Number);
const repeat = Number(arg("--repeat") ?? 3);
const level = arg("--level") ?? "symbols";
const headed = flag("--headed");
const glArgs =
  (arg("--gl") ?? "metal") === "swiftshader"
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    : ["--use-angle=metal", "--ignore-gpu-blocklist"];

const insideDir = (child: string, parent: string) => {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
};
if (outDir) {
  if (insideDir(outDir, root) && !insideDir(outDir, join(root, "evals", "private")))
    throw new Error("--out is inside this repository (only evals/private/ is allowed)");
  if (target !== "fixture" && insideDir(outDir, resolve(target)))
    throw new Error("--out is inside the repository under test");
  mkdirSync(outDir, { recursive: true });
}

const scratch = mkdtempSync(join(tmpdir(), "gantry-m4-"));
const children: ChildProcess[] = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children) c.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });

const log = (s: string) => process.stderr.write(`${s}\n`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor((s.length - 1) / 2)] as number);
};
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Gantry Bench",
  GIT_AUTHOR_EMAIL: "bench@example.invalid",
  GIT_COMMITTER_NAME: "Gantry Bench",
  GIT_COMMITTER_EMAIL: "bench@example.invalid",
};
const statusHash = (repo: string) =>
  sha(
    spawnSync("git", ["status", "--porcelain=v1", "-z", "--ignored"], { cwd: repo, encoding: "utf8" }).stdout,
  );

/** The working copy the script edits: a clone of <repo>, or the fixture in a fresh git repo. */
function prepare(): { repo: string; source?: string } {
  const repo = join(scratch, "repo");
  if (target === "fixture") {
    cpSync(join(root, "fixtures", "pnpm-turbo"), repo, { recursive: true });
    for (const a of [
      ["init", "-q"],
      ["add", "-A"],
      ["commit", "-q", "-m", "fixture"],
    ])
      execFileSync("git", a, { cwd: repo, env: gitEnv, stdio: "ignore" });
    return { repo };
  }
  const source = resolve(target);
  execFileSync("git", ["clone", "-q", "--no-hardlinks", source, repo], { env: gitEnv, stdio: "ignore" });
  return { repo, source };
}

async function startMap(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; token: string; origin: string }> {
  const child = spawn("node", [cli, "map", "--no-open"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const url = await new Promise<string>((ok, fail) => {
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) ok(line.trim());
    });
    child.on("exit", (code) => fail(new Error(`gantry map exited with ${code}`)));
  });
  const u = new URL(url);
  return { url, token: u.searchParams.get("t") ?? "", origin: u.origin };
}

async function api(origin: string, token: string, path: string, init: RequestInit = {}) {
  const t0 = performance.now();
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: { "x-gantry-token": token, ...(init.headers ?? {}) },
  });
  const body = await res.json();
  return { status: res.status, body, ms: performance.now() - t0 };
}

const surface = (page: Page) => page.getByTestId("graph-canvas").locator(".gc-sigma");

async function probe(page: Page, positions: boolean) {
  return JSON.parse(
    await surface(page).evaluate((el: HTMLElement, withPositions: boolean) => {
      el.dispatchEvent(new CustomEvent("gantry:probe", { detail: { positions: withPositions } }));
      return el.dataset.probe ?? "{}";
    }, positions),
  ) as { positions?: Record<string, [number, number]>; generation: number; fresh: string[]; kept: boolean };
}

async function main() {
  const { repo, source } = prepare();
  const sourceBefore = source ? statusHash(source) : undefined;
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: join(scratch, "data"), HOME: join(scratch, "home") };
  log("indexing…");
  const t0 = Date.now();
  const init = spawnSync("node", [cli, "init"], { cwd: repo, env, encoding: "utf8", maxBuffer: 64 << 20 });
  if (init.status !== 0) throw new Error("gantry init failed");
  const initMs = Date.now() - t0;
  const { url, token, origin } = await startMap(repo, env);
  const meta = (await api(origin, token, "/api/meta")).body;

  // Source files to edit: indexed .ts/.tsx files that are not tests or declarations, spread evenly over the sorted list.
  const filesView = (await api(origin, token, "/api/view/project-map?level=files")).body as {
    nodes: { id: string; kind: string; path?: string }[];
  };
  const candidates = filesView.nodes
    .filter(
      (n) => n.kind === "file" && n.path && /\.tsx?$/.test(n.path) && !/\.(test|spec|d)\.tsx?$/.test(n.path),
    )
    .map((n) => n.path as string)
    .sort();
  const maxEdits = Math.max(...edits);
  if (candidates.length < maxEdits) throw new Error("not enough source files to edit");
  const pick = (n: number, round: number) =>
    Array.from(
      { length: n },
      (_, k) => candidates[(Math.floor((k * candidates.length) / n) + round) % candidates.length] as string,
    );

  // The stale check itself, clean tree: median of 10 GET /api/meta.
  const cleanMeta: number[] = [];
  for (let k = 0; k < 10; k++) cleanMeta.push((await api(origin, token, "/api/meta")).ms);

  const browser = await pw.chromium.launch({ headless: !headed, args: glArgs });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // tsx's esbuild wraps named functions in a `__name` helper that does not exist inside the page.
  await page.addInitScript("window.__name = (f) => f;");
  page.setDefaultTimeout(60_000);
  const u = new URL(url);
  u.hash = `#/project-map?level=${level}`;
  await page.goto(u.toString());
  await page.waitForFunction(
    () => document.querySelector(".gc-sigma")?.getAttribute("data-ready") === "true",
  );

  const rounds: Record<string, unknown>[] = [];
  let generation = 0;
  let serial = 0;
  for (const n of edits) {
    for (let r = 0; r < repeat; r++) {
      const files = pick(n, rounds.length);
      const before = await probe(page, true);
      for (const f of files) {
        const p = join(repo, f);
        writeFileSync(
          p,
          `${readFileSync(p, "utf8")}\nexport function gantryM4Probe${++serial}(): number {\n  return ${serial};\n}\n`,
        );
      }
      // The marker: the next request after the save says how many files changed.
      const staleMeta = await api(origin, token, "/api/meta");
      // The browser asks too when the tab gets focus back; then the user presses Refresh.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.getByTestId("stale-marker").waitFor();
      const marker = await page.getByTestId("stale-marker").textContent();
      const refreshed = page.waitForResponse((res: { url(): string }) => res.url().endsWith("/api/refresh"));
      const tClick = Date.now();
      await page.getByRole("button", { name: "Refresh" }).click();
      const resp = await refreshed;
      const tServer = Date.now();
      const body = (await resp.json()) as {
        changed: { files: number; functions: number };
        ms: number;
        files: string[];
        functions: { added: string[] };
      };
      generation++;
      const want = body.functions.added;
      await page.waitForFunction(
        ([gen, ids]: [number, string[]]) => {
          const el = document.querySelector(".gc-sigma") as HTMLElement | null;
          if (el?.dataset.ready !== "true") return false;
          el.dispatchEvent(new CustomEvent("gantry:probe"));
          const p = JSON.parse(el.dataset.probe ?? "{}") as { generation?: number; fresh?: string[] };
          return p.generation === gen && ids.every((id) => p.fresh?.includes(id));
        },
        [generation, want],
        { polling: 10, timeout: 60_000 },
      );
      const tShown = Date.now();
      const after = await probe(page, true);
      const edited = new Set(files);
      const inEdited = (id: string) => {
        const m = pathOfId(id);
        return m !== undefined ? edited.has(m) : false;
      };
      const compared = Object.keys(before.positions ?? {}).filter(
        (id) => !inEdited(id) && id in (after.positions ?? {}),
      );
      const movedIds = compared.filter((id) => {
        const a = before.positions?.[id] as [number, number];
        const b = after.positions?.[id] as [number, number];
        return a[0] !== b[0] || a[1] !== b[1];
      });
      const moved = movedIds.length;
      // Debugging aid: names of the repo under test, so only ever into the private --out directory.
      if (moved > 0 && outDir && flag("--dump-moved"))
        writeFileSync(
          join(outDir, `moved-${rounds.length}.json`),
          JSON.stringify({ files, movedIds }, null, 1),
        );
      const row = {
        edited: n,
        staleReported: staleMeta.body.stale?.files,
        markerShown: marker === `Out of date (${n} ${n === 1 ? "file" : "files"})`,
        staleCheckMs: Math.round(staleMeta.ms),
        refreshServerMs: body.ms,
        clickToResponseMs: tServer - tClick,
        clickToShownMs: tShown - tClick,
        changedFiles: body.changed.files,
        changedFunctions: body.changed.functions,
        addedHighlighted: want.length,
        layoutKept: after.kept,
        nodesCompared: compared.length,
        moved,
      };
      log(JSON.stringify(row));
      rounds.push(row);
    }
  }
  await browser.close();

  const byN = edits.map((n) => {
    const rs = rounds.filter((r) => r.edited === n);
    const col = (k: string) => rs.map((r) => r[k] as number);
    return {
      edited: n,
      runs: rs.length,
      medianRefreshServerMs: median(col("refreshServerMs")),
      maxRefreshServerMs: Math.max(...col("refreshServerMs")),
      medianClickToShownMs: median(col("clickToShownMs")),
      maxClickToShownMs: Math.max(...col("clickToShownMs")),
      medianStaleCheckMs: median(col("staleCheckMs")),
      allMarkersRight: rs.every((r) => r.markerShown === true && r.staleReported === n),
      totalMoved: col("moved").reduce((a, b) => a + b, 0),
      minNodesCompared: Math.min(...col("nodesCompared")),
    };
  });
  const report = {
    target: target === "fixture" ? "fixture" : "private repo (clone)",
    level,
    counts: { files: meta.counts.files, symbols: meta.counts.symbols, workspaces: meta.counts.workspaces },
    initMs,
    cleanStaleCheckMs: Math.round(median(cleanMeta)),
    byEdits: byN,
    sourceUntouched: source ? statusHash(source) === sourceBefore : null,
    rounds,
  };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (outDir) writeFileSync(join(outDir, "m4.json"), text);
}

main().then(
  () => {
    cleanup();
    process.exit(0);
  },
  (err) => {
    log(String(err instanceof Error ? err.message : err));
    cleanup();
    process.exit(1);
  },
);
