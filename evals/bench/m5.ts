/**
 * M5 regression benchmark (issue #44): review data and the review view on real commit ranges, with no re-index.
 *
 * Usage: pnpm build && pnpm tsx evals/bench/m5.ts [<repo>|fixture] [--out <private dir>] [--targets 5,20,40]
 *        [--ranges <a>,<b>,...] [--max-back 300]
 *
 * <repo> is a git repository (for example a throwaway clone of a private monorepo); `fixture` (the default) copies
 * fixtures/pnpm-turbo into a temp git repo with three feature commits. The repo is only read: its data directory is
 * `CLAUDE_PLUGIN_DATA` under --out (else a temp dir), and `git status` is compared before and after.
 *
 * Steps:
 *   1. `gantry init` once at the repo's HEAD (the timed runs below never index again).
 *   2. Ranges: with --ranges, those; otherwise, for each target file count, the range `HEAD~k...HEAD` (first-parent
 *      history) whose count of changed indexable files is closest to the target.
 *   3. Per range: wall time of `gantry review <range> --json` (diff plus impact), the review view through the
 *      `gantry_open_view` tool's own code (start or reuse the explorer, tokenised URL), API time cold and cached, and
 *      a page load to the first drawn ring (headless Chromium). The store's content hash and `git status` are taken
 *      before and after: both must be unchanged.
 *   4. Hand-check material for the range closest to 20 files: the changed ids and callers by hop, written to --out
 *      only (`handcheck.json`), and a cross-check: how many hop-1 callers' files mention the changed symbol's name.
 * Output: aggregate numbers only (counts, ms, yes/no) on stdout. Nothing printed names a path, a file, a symbol or a
 * commit of <repo>; ranges are printed as `HEAD~k...HEAD`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIndexable, loadConfig, openStore, resolvePaths } from "../../packages/core/src/index.js";
import { openViewTool } from "../../packages/mcp/src/tools/openView.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cli = join(root, "plugin", "dist", "cli.js");
const requireFromExplorer = createRequire(join(root, "packages", "explorer", "package.json"));
// biome-ignore lint/suspicious/noExplicitAny: playwright is resolved from packages/explorer at run time
const pw = requireFromExplorer("playwright") as any;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const positional = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const target = positional ?? "fixture";
const outDir = arg("--out") ? resolve(arg("--out") as string) : undefined;
const targets = (arg("--targets") ?? "5,20,40").split(",").map(Number);
const maxBack = Number(arg("--max-back") ?? 300);
const scratch = mkdtempSync(join(tmpdir(), "gantry-m5-"));
const log = (s: string) => process.stderr.write(`${s}\n`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const inside = (child: string, parent: string) => {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
};
if (outDir) {
  if (inside(outDir, root) && !inside(outDir, join(root, "evals", "private")))
    throw new Error("--out is inside this repository (only evals/private/ is allowed)");
  if (target !== "fixture" && inside(outDir, resolve(target)))
    throw new Error("--out is inside the repository under test");
  mkdirSync(outDir, { recursive: true });
}
const dataDir = join(outDir ?? scratch, "data");
let explorerPid: number | undefined;
process.on("exit", () => {
  if (explorerPid) {
    try {
      process.kill(explorerPid, "SIGTERM");
    } catch {
      // gone
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

// ---- the repo under test ----------------------------------------------------------------------------------------

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Gantry Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Gantry Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** fixtures/pnpm-turbo plus three commits: Button's props, a new helper, a renamed export. */
function prepareFixture(): string {
  const repo = join(scratch, "pnpm-turbo");
  cpSync(join(root, "fixtures", "pnpm-turbo"), repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, env: gitEnv, stdio: "ignore" });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const edit = (rel: string, f: (s: string) => string) => {
    const p = join(repo, rel);
    writeFileSync(p, f(readFileSync(p, "utf8")));
  };
  edit("packages/ui/src/button.tsx", (s) =>
    s.replace(
      "{ label, onClick }: { label: string; onClick?: () => void }",
      "{ label, onClick, size }: { label: string; onClick?: () => void; size?: number }",
    ),
  );
  git("commit", "-qam", "button size");
  edit(
    "packages/utils/src/slug.ts",
    (s) => `${s}export function slugifyAll(xs: string[]): string[] {\n  return xs.map(slugify);\n}\n`,
  );
  git("commit", "-qam", "slugifyAll");
  edit("packages/utils/src/date.ts", (s) =>
    s.replace("export function formatRelativeDate", "export function formatTimeAgo"),
  );
  git("commit", "-qam", "rename");
  return repo;
}

const repo = target === "fixture" ? prepareFixture() : resolve(target);
const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
const paths = resolvePaths(repo, env);
const config = loadConfig(paths);
const gitStatus = () =>
  sha(
    spawnSync("git", ["status", "--porcelain=v1", "-z", "--ignored"], { cwd: repo, encoding: "utf8" }).stdout,
  );

/** Content hash of the index: files, symbols and the indexed head. Timestamps of reads are not part of it. */
function storeHash(): string {
  const store = openStore(paths.dbPath);
  try {
    const files = store.effectiveFiles().map((f) => `${f.id}\0${f.contentHash}\0${f.mtimeMs}`);
    const symbols = store.effectiveSymbols().map((s) => `${s.id}\0${s.exactHash}`);
    return sha([store.getMeta("head_sha") ?? "", ...files, ...symbols].join("\n"));
  } finally {
    store.close();
  }
}

function changedFiles(range: string): number {
  const [base, head] = range.split("...") as [string, string];
  const r = spawnSync("git", ["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return r.stdout.split("\0").filter((p) => p && isIndexable(p, config)).length;
}

function pickRanges(): string[] {
  const given = arg("--ranges");
  if (given) return given.split(",");
  const depth = Number(
    spawnSync("git", ["rev-list", "--first-parent", "--count", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim(),
  );
  const counts: { k: number; files: number }[] = [];
  for (let k = 1; k < Math.min(depth, maxBack + 1); k++)
    counts.push({ k, files: changedFiles(`HEAD~${k}...HEAD`) });
  return targets.map((t) => {
    const best = [...counts].sort((a, b) => Math.abs(a.files - t) - Math.abs(b.files - t) || a.k - b.k)[0];
    if (!best) throw new Error("the repository has no history to pick a range from");
    return `HEAD~${best.k}...HEAD`;
  });
}

// ---- measurements -------------------------------------------------------------------------------------------------

interface ReviewJson {
  files: unknown[];
  changes: { id: string; kind: string; signatureChanged: boolean; before?: { id: string } }[];
  impact: {
    callersByHop: { hop: number; ids: string[] }[];
    crossings: unknown[];
    risk: { score: number; level: string };
    notes: string[];
  } | null;
}

function cliReview(range: string): { ms: number; json: ReviewJson } {
  const t0 = performance.now();
  const r = spawnSync("node", [cli, "review", range, "--json"], {
    cwd: repo,
    env,
    encoding: "utf8",
    maxBuffer: 256 << 20,
  });
  const ms = Math.round(performance.now() - t0);
  if (r.status !== 0) throw new Error(`gantry review failed: ${r.stderr.slice(0, 300)}`);
  return { ms, json: JSON.parse(r.stdout) as ReviewJson };
}

async function openUrl(range: string): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: the tool context is only partly needed here
  const r = (await openViewTool.run({ view: "review", filters: { range } }, { paths, env } as any)) as {
    url?: string;
    error?: string;
  };
  if (!r.url)
    throw new Error(`gantry_open_view: ${r.error ?? "no url"} ${(r as { message?: string }).message ?? ""}`);
  try {
    explorerPid = (JSON.parse(readFileSync(join(paths.dataDir, "explorer.json"), "utf8")) as { pid: number })
      .pid;
  } catch {
    // reused
  }
  return r.url;
}

async function main() {
  const t0 = Date.now();
  const init = spawnSync("node", [cli, "init"], { cwd: repo, env, encoding: "utf8", maxBuffer: 64 << 20 });
  if (init.status !== 0) throw new Error("gantry init failed");
  const initMs = Date.now() - t0;
  const store = openStore(paths.dbPath);
  const repoStats = {
    files: store.effectiveFiles().length,
    symbols: store.effectiveSymbols().length,
    workspaces: store.listWorkspaces().length,
  };
  store.close();
  const ranges = pickRanges();
  log(`ranges: ${ranges.join(", ")}`);

  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript("window.__name = (f) => f;");
  const page = await context.newPage();

  const rows: Record<string, unknown>[] = [];
  let handcheck: { range: string; data: unknown; mentions: { checked: number; mention: number } } | undefined;
  for (const range of ranges) {
    const statusBefore = gitStatus();
    const hashBefore = storeHash();
    const cliRun = cliReview(range);
    const cliAgain = cliReview(range);

    const tOpen = performance.now();
    const url = await openUrl(range);
    const openMs = Math.round(performance.now() - tOpen);
    const u = new URL(url);
    const token = u.searchParams.get("t") ?? "";
    const api = async () => {
      const q = encodeURIComponent(JSON.stringify({ range }));
      const t = performance.now();
      const res = await fetch(`${u.origin}/api/view/review?filters=${q}`, {
        headers: { "x-gantry-token": token },
      });
      // biome-ignore lint/suspicious/noExplicitAny: ad hoc JSON
      const body = (await res.json()) as any;
      return { ms: Math.round(performance.now() - t), status: res.status, body };
    };
    // A fresh merge base/head pair per range, so the first request is cold (nothing cached for it yet).
    const cold = await api();
    const cached = await api();
    const tPage = performance.now();
    await page.goto(url);
    await page.locator("[data-testid=review-canvas][data-ready=true]").waitFor({ timeout: 60_000 });
    const pageMs = Math.round(performance.now() - tPage);
    if (outDir) await page.screenshot({ path: join(outDir, `review-${rows.length + 1}.png`) });

    const statusAfter = gitStatus();
    const hashAfter = storeHash();
    const impact = cliRun.json.impact;
    const files = cliRun.json.files.length;
    rows.push({
      range,
      files,
      changes: cliRun.json.changes.length,
      signatureChanges: cliRun.json.changes.filter((c) => c.signatureChanged).length,
      callersByHop: impact?.callersByHop.map((h) => h.ids.length) ?? null,
      crossings: impact?.crossings.length ?? null,
      notes: impact?.notes.length ?? null,
      risk: impact ? `${impact.risk.level} ${impact.risk.score}` : null,
      cliJsonMs: cliRun.ms,
      cliJsonAgainMs: cliAgain.ms,
      openViewMs: openMs,
      apiColdMs: cold.ms,
      apiCachedMs: cached.ms,
      apiStatus: cold.status,
      viewNodes: cold.body?.nodes?.length ?? null,
      pageFirstRenderMs: pageMs,
      dataPlusViewMs: cliRun.ms + pageMs,
      dataPlusViewUnder10s: cliRun.ms + pageMs < 10_000 && cold.ms + pageMs < 10_000,
      storeUnchanged: hashBefore === hashAfter,
      treeUnchanged: statusBefore === statusAfter,
      viewMatchesCli:
        JSON.stringify(cold.body?.review?.risk) === JSON.stringify(impact?.risk) &&
        JSON.stringify(cold.body?.review?.callersByHop) ===
          JSON.stringify(impact?.callersByHop.map((h) => ({ hop: h.hop, count: h.ids.length }))),
    });

    const closest = Math.min(...ranges.map((r) => Math.abs(changedFiles(r) - 20)));
    if (!handcheck && Math.abs(changedFiles(range) - 20) === closest && impact) {
      // Cross-check without the graph: does each hop-1 caller's file mention a changed symbol's name (old or new)?
      const names = new Set(
        cliRun.json.changes
          .filter((c) => c.kind !== "added")
          .flatMap((c) => [c.id, c.before?.id ?? c.id].map((id) => id.slice(id.lastIndexOf("#") + 1))),
      );
      const hop1 = impact.callersByHop[0]?.ids ?? [];
      let mention = 0;
      for (const id of hop1) {
        const p = id.startsWith("sym:") ? id.slice(4, id.lastIndexOf("#")) : id.slice(5);
        let text = "";
        try {
          text = readFileSync(join(repo, p), "utf8");
        } catch {
          // gone at head
        }
        if ([...names].some((n) => text.includes(n))) mention++;
      }
      handcheck = {
        range,
        data: {
          changed: cliRun.json.changes.map((c) => ({
            id: c.id,
            kind: c.kind,
            signatureChanged: c.signatureChanged,
          })),
          callersByHop: impact.callersByHop,
          crossings: impact.crossings,
          risk: impact.risk,
          notes: impact.notes,
        },
        mentions: { checked: hop1.length, mention },
      };
    }
  }
  await browser.close();

  if (handcheck && outDir)
    writeFileSync(join(outDir, "handcheck.json"), `${JSON.stringify(handcheck, null, 2)}\n`);
  const out = {
    repo: target === "fixture" ? "fixtures/pnpm-turbo" : "private",
    repoStats,
    initMs,
    ranges: rows,
    handcheck: handcheck
      ? {
          range: handcheck.range,
          hop1Callers: handcheck.mentions.checked,
          hop1CallersWhoseFileNamesAChangedSymbol: handcheck.mentions.mention,
          written: outDir ? "handcheck.json in --out" : "not written (no --out)",
        }
      : null,
  };
  if (outDir) writeFileSync(join(outDir, "m5.json"), `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    log(String(e instanceof Error ? e.message : e));
    process.exit(1);
  },
);
