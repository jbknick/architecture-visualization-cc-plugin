/**
 * M6 regression benchmark (issue #48): page -> endpoint -> table chains against hand-traced expectations, and the
 * load times of the cross-stack views 7-11.
 *
 * Usage: pnpm build && pnpm tsx evals/bench/m6.ts <repo> [<expected.json>] [--data <dir>] [--out <private dir>]
 *        [--runs 5]
 *
 * <expected.json> defaults to evals/private/m6-expected.json (git-ignored; never commit it). Its shape:
 *   { features: [{ name, route, endpoints: [id], tables: [id], raw_sql_tables?: [id], pages: [id] }] }
 * `endpoints` must all appear in trace(route) (down); `tables` must equal the tables of trace(endpoint) (down) over
 * those endpoints; `pages` must appear in trace(table) (up) for every table. Raw-SQL tables are listed apart and
 * not expected (the Drizzle adapter does not read raw SQL).
 *
 * The repo is only read: a fresh index is built into --data (default a temp dir; refused inside the repo), and
 * `git status --porcelain` is compared before and after. The same checks run through the views' API (page -> API,
 * API -> tables, feature path, table usage), so the views are diffed too.
 *
 * Page loads: each view is opened through the `gantry_open_view` tool's own code (the production build served by
 * `gantry map`, started on the fresh data dir) in headless Chromium, timed to the drawn canvas, `--runs` times.
 *
 * Output: aggregate numbers only (counts, ms, match yes/no) on stdout. Raw per-feature diffs (with ids) go to
 * --out only, which must be outside this repository unless it is under evals/private/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GantryPaths,
  indexRepo,
  loadConfig,
  openStore,
  resolvePaths,
  resolveTraceTarget,
  type Store,
  type TraceResult,
  trace,
} from "../../packages/core/src/index.js";
import { handleApi } from "../../packages/explorer/server/api.js";
import type { ApiContext, ViewResult } from "../../packages/explorer/server/types.js";
import { openViewTool } from "../../packages/mcp/src/tools/openView.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const positional = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const repo = positional[0] ? resolve(positional[0]) : undefined;
if (!repo || !existsSync(repo)) {
  process.stderr.write(
    "usage: tsx evals/bench/m6.ts <repo> [<expected.json>] [--data <dir>] [--out <dir>]\n",
  );
  process.exit(2);
}
const expectedPath = resolve(positional[1] ?? join(root, "evals", "private", "m6-expected.json"));
const runs = Number(arg("--runs") ?? 5);
const requireFromExplorer = createRequire(join(root, "packages", "explorer", "package.json"));
const log = (s: string) => process.stderr.write(`${s}\n`);

const inside = (child: string, parent: string) => {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
};
const scratch = mkdtempSync(join(tmpdir(), "gantry-m6-"));
const dataDir = resolve(arg("--data") ?? join(scratch, "data"));
if (inside(dataDir, repo)) throw new Error("--data is inside the repository under test");
const outDir = arg("--out") ? resolve(arg("--out") as string) : undefined;
if (outDir) {
  if (inside(outDir, root) && !inside(outDir, join(root, "evals", "private")))
    throw new Error("--out is inside this repository (only evals/private/ is allowed)");
  if (inside(outDir, repo)) throw new Error("--out is inside the repository under test");
  mkdirSync(outDir, { recursive: true });
}
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

interface Feature {
  name: string;
  route: string;
  endpoints: string[];
  tables: string[];
  raw_sql_tables?: string[];
  pages: string[];
}
const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as { features: Feature[] };

const gitStatus = () => execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor((s.length - 1) / 2)] as number);
};
const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const round = (x: number) => Math.round(x * 10) / 10;

// ---- fresh index ------------------------------------------------------------------------------------------------
const before = gitStatus();
const paths: GantryPaths = resolvePaths(repo, { HOME: join(scratch, "home"), CLAUDE_PLUGIN_DATA: dataDir });
rmSync(paths.dataDir, { recursive: true, force: true });
log(`indexing into a fresh data dir ...`);
let t0 = process.hrtime.bigint();
await indexRepo(paths, { layer: "main" });
const indexMs = ms(t0);
const config = loadConfig(paths);
const open = (): { store: Store; ctx: ApiContext } => {
  const store = openStore(paths.dbPath);
  return { store, ctx: { store, paths, config } };
};
const main = open();
const { store, ctx } = main;

const view = <T extends ViewResult>(c: ApiContext, id: string, qs = ""): T =>
  handleApi(c, `/api/view/${id}`, new URLSearchParams(qs)) as T;
const ofKind = (t: TraceResult | null, kind: string) =>
  new Set((t?.chain ?? []).filter((s) => s.kind === kind).map((s) => s.id));
const minus = (a: Iterable<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();

// ---- chains ----------------------------------------------------------------------------------------------------
interface FeatureResult {
  name: string;
  match: boolean;
  views: boolean;
  route: string | null;
  missingEndpoints: string[];
  tables: { expected: string[]; trace: string[]; view: string[]; missing: string[]; extra: string[] };
  missingPages: Record<string, string[]>;
  viewDiffs: string[];
  counts: { downChain: number; downEndpoints: number; downTables: number; gaps: number };
}
const results: FeatureResult[] = [];
for (const f of expected.features) {
  const routeId = resolveTraceTarget(store, f.route);
  const down = routeId ? trace(store, routeId, { direction: "down" }) : null;
  const missingEndpoints = minus(f.endpoints, ofKind(down, "endpoint"));
  const traceTables = new Set<string>();
  for (const ep of f.endpoints)
    for (const t of ofKind(trace(store, ep, { direction: "down" }), "table")) traceTables.add(t);
  const want = new Set(f.tables);
  const missingTables = minus(want, traceTables);
  const extraTables = minus(traceTables, want);
  const missingPages: Record<string, string[]> = {};
  for (const t of f.tables) {
    const miss = minus(f.pages, ofKind(trace(store, t, { direction: "up" }), "route"));
    if (miss.length > 0) missingPages[t] = miss;
  }
  // The same through the views' API.
  const viewDiffs: string[] = [];
  const pageApi = view(ctx, "page-api");
  for (const ep of f.endpoints)
    if (!pageApi.edges.some((e) => e.src === routeId && e.dst === ep))
      viewDiffs.push(`page-api: no ${routeId} -> ${ep}`);
  const apiTables = view<
    ViewResult & { endpointTables: { endpoint: string; reads: string[]; writes: string[] }[] }
  >(ctx, "api-tables");
  const viewTables = new Set<string>();
  for (const ep of f.endpoints) {
    const row = apiTables.endpointTables.find((r) => r.endpoint === ep);
    if (!row) viewDiffs.push(`api-tables: no row for ${ep}`);
    for (const t of [...(row?.reads ?? []), ...(row?.writes ?? [])]) viewTables.add(t);
  }
  for (const t of minus(want, viewTables)) viewDiffs.push(`api-tables: missing ${t}`);
  for (const t of minus(viewTables, want)) viewDiffs.push(`api-tables: extra ${t}`);
  if (routeId) {
    const fp = view(ctx, "feature-path", `focus=${encodeURIComponent(routeId)}`);
    const ids = new Set(fp.nodes.map((n) => n.id));
    for (const x of [...f.endpoints, ...f.tables])
      if (!ids.has(x)) viewDiffs.push(`feature-path: missing ${x}`);
  }
  for (const t of f.tables) {
    const tu = view(ctx, "table-usage", `focus=${encodeURIComponent(t)}`);
    const ids = new Set(tu.nodes.map((n) => n.id));
    for (const p of f.pages) if (!ids.has(p)) viewDiffs.push(`table-usage ${t}: missing ${p}`);
  }
  const match =
    routeId !== null &&
    missingEndpoints.length === 0 &&
    missingTables.length === 0 &&
    extraTables.length === 0 &&
    Object.keys(missingPages).length === 0;
  results.push({
    name: f.name,
    match,
    views: viewDiffs.length === 0,
    route: routeId,
    missingEndpoints,
    tables: {
      expected: [...want].sort(),
      trace: [...traceTables].sort(),
      view: [...viewTables].sort(),
      missing: missingTables,
      extra: extraTables,
    },
    missingPages,
    viewDiffs,
    counts: {
      downChain: down?.chain.length ?? 0,
      downEndpoints: ofKind(down, "endpoint").size,
      downTables: ofKind(down, "table").size,
      gaps: down?.gaps.length ?? 0,
    },
  });
}

// ---- aggregate counts ------------------------------------------------------------------------------------------
const count = (kind: string) => store.effectiveAdapterNodes({ kind }).length;
const ep = view<ViewResult & { totals: Record<string, number> }>(ctx, "endpoints");
const pa = view<ViewResult & { totals: Record<string, number> }>(ctx, "page-api");
const at = view<ViewResult & { totals: Record<string, number> }>(ctx, "api-tables");
const aggregate = {
  routes: count("route"),
  endpoints: count("endpoint"),
  tables: count("table"),
  middleware: count("middleware"),
  unmatchedClientCalls: count("client_call"),
  endpointsView: { nodes: ep.nodes.length, edges: ep.edges.length, withoutHandler: ep.totals.withoutHandler },
  pageApi: {
    links: pa.edges.length,
    lowLinks: pa.edges.filter((e) => e.confidence === "low").length,
    routesWithout: pa.totals.routesWithout,
    endpointsWithout: pa.totals.endpointsWithout,
  },
  apiTables: {
    endpointsWithTables: at.totals.withTables,
    readEdges: at.edges.filter((e) => e.kind === "reads").length,
    writeEdges: at.edges.filter((e) => e.kind === "writes").length,
    tablesReached: at.totals.tables,
  },
};

// ---- load times ------------------------------------------------------------------------------------------------
// Cold: a newly opened store (no snapshot or trace cache) answering its first request. Warm: the same request again.
const focusRoute = results.find((r) => r.route)?.route ?? null;
const focusTable = expected.features.flatMap((f) => f.tables)[0] ?? null;
const timed: [string, string][] = [
  ["endpoints", ""],
  ["page-api", ""],
  ["api-tables", ""],
  ...(focusRoute
    ? ([["feature-path", `focus=${encodeURIComponent(focusRoute)}`]] as [string, string][])
    : []),
  ...(focusTable ? ([["table-usage", `focus=${encodeURIComponent(focusTable)}`]] as [string, string][]) : []),
];
const loadTimes: Record<
  string,
  { coldMs: number; warmMs: number; bytes: number; nodes: number; edges: number }
> = {};
for (const [id, qs] of timed) {
  const cold: number[] = [];
  const warm: number[] = [];
  let last: ViewResult | null = null;
  for (let i = 0; i < runs; i++) {
    const fresh = open();
    t0 = process.hrtime.bigint();
    last = view(fresh.ctx, id, qs);
    cold.push(ms(t0));
    t0 = process.hrtime.bigint();
    view(fresh.ctx, id, qs);
    warm.push(ms(t0));
    fresh.store.close();
  }
  loadTimes[id] = {
    coldMs: round(median(cold)),
    warmMs: round(median(warm)),
    bytes: JSON.stringify(last).length,
    nodes: last?.nodes.length ?? 0,
    edges: last?.edges.length ?? 0,
  };
}

// Page loads: the production explorer on the fresh data dir, timed to the drawn canvas.
const pageLoads: Record<string, { medianMs: number }> = {};
let explorerPid: number | undefined;
try {
  // biome-ignore lint/suspicious/noExplicitAny: playwright is resolved from packages/explorer at run time
  const pw = requireFromExplorer("playwright") as any;
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  for (const [id, qs] of timed) {
    const focus = new URLSearchParams(qs).get("focus") ?? undefined;
    // biome-ignore lint/suspicious/noExplicitAny: the tool context is only partly needed here
    const r = (await openViewTool.run({ view: id, ...(focus ? { focus } : {}) }, { paths, env } as any)) as {
      url?: string;
      error?: string;
    };
    if (!r.url) throw new Error(`gantry_open_view: ${r.error ?? "no url"}`);
    try {
      explorerPid = (
        JSON.parse(readFileSync(join(paths.dataDir, "explorer.json"), "utf8")) as { pid: number }
      ).pid;
    } catch {
      // reused
    }
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      await page.goto("about:blank");
      t0 = process.hrtime.bigint();
      await page.goto(r.url);
      await page.locator("canvas.flow-canvas[data-ready=true]").waitFor({ timeout: 60_000 });
      times.push(ms(t0));
    }
    pageLoads[id] = { medianMs: Math.round(median(times)) };
  }
  await browser.close();
} catch (err) {
  log(`page loads skipped: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (explorerPid) {
    try {
      process.kill(explorerPid, "SIGTERM");
    } catch {
      // gone
    }
  }
}
store.close();
const after = gitStatus();

// ---- report ----------------------------------------------------------------------------------------------------
const matched = results.filter((r) => r.match).length;
const summary = {
  chainsMatch: `${matched}/${results.length}`,
  viewsAgree: `${results.filter((r) => r.views).length}/${results.length}`,
  features: results.map((r, i) => ({
    feature: i + 1,
    match: r.match,
    views: r.views,
    expected: {
      endpoints: expected.features[i]?.endpoints.length ?? 0,
      tables: expected.features[i]?.tables.length ?? 0,
      rawSqlTables: expected.features[i]?.raw_sql_tables?.length ?? 0,
      pages: expected.features[i]?.pages.length ?? 0,
    },
    missingEndpoints: r.missingEndpoints.length,
    missingTables: r.tables.missing.length,
    extraTables: r.tables.extra.length,
    missingPages: Object.values(r.missingPages).flat().length,
    viewDiffs: r.viewDiffs.length,
    downTrace: r.counts,
  })),
  indexMs: Math.round(indexMs),
  aggregate,
  loadTimes,
  pageLoads,
  runs,
  repoUnchanged: before === after,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (outDir) {
  writeFileSync(join(outDir, "48-m6-results.json"), `${JSON.stringify({ summary, results }, null, 2)}\n`);
  log(`raw results: ${join(outDir, "48-m6-results.json")}`);
}
if (before !== after) {
  log("the repository's git status changed during the run");
  process.exitCode = 1;
}
