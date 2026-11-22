/**
 * Java call coverage, a sanity count. Usage (from the repo root):
 *   pnpm exec tsx docs/spikes/java-coverage/count.ts [--core <checkout>]
 * Clones the pinned public repo into a temp directory (nothing of it is committed), indexes it with the indexer of
 * `<checkout>` (default: the checkout this script is in; pass another checkout of this repo to count with its code) and
 * prints, for main code (the `.java` files under a `src/main/` folder):
 *   sites           method-invocation nodes
 *   sitesWithEdge   sites whose `path:line` is evidence of a `calls` edge from that file
 *   high, low       `calls` edges whose source is in main code, by confidence
 *   calls           the sum of the `count` of those edges
 *   capped          calls whose line is not kept because an edge keeps at most 20 evidence lines
 * `sitesWithEdge` is by line: two calls on one line count together, and a call past the evidence cap is not seen, so it
 * is a little high for chained calls on one line and low by at most `capped`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "https://github.com/google/gson.git";
/** The commit the counts are taken at (tag `gson-parent-2.13.2`). */
const SHA = "686fad782d969d8f15c7581a5435a208b810caa7";

const here = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf("--core");
const checkout = resolve(at > 0 ? (process.argv[at + 1] ?? "") : join(here, "../../.."));
const core = (file: string): Promise<Record<string, unknown>> =>
  import(pathToFileURL(join(checkout, "packages/core/src", file)).href);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Edge {
  kind: string;
  src: string;
  confidence: string;
  count: number;
  evidence: string[];
}
interface Node {
  field(name: string): Node | null;
  range(): { start: { line: number } };
  findAll(rule: { rule: Record<string, unknown> }): Node[];
}

const work = mkdtempSync(join(tmpdir(), "gantry-java-coverage-"));
try {
  const repo = join(work, "gson");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "fetch", "-q", "--depth", "1", REPO, SHA);
  git(repo, "checkout", "-q", "FETCH_HEAD");
  if (git(repo, "rev-parse", "HEAD") !== SHA) throw new Error("the clone is not at the pinned commit");

  const { indexRepo, dumpGraph } = (await core("indexer.ts")) as {
    indexRepo: (paths: unknown, opts: { layer: "main" }) => Promise<unknown>;
    dumpGraph: (store: unknown) => { files: { path: string; lang: string }[]; edges: Edge[] };
  };
  const { resolvePaths } = (await core("paths/index.ts")) as {
    resolvePaths: (cwd: string, env: Record<string, string>) => { dbPath: string };
  };
  const { openStore } = (await core("store/index.ts")) as {
    openStore: (dbPath: string) => { close(): void };
  };
  const { javaPack } = (await core("lang/packs/index.ts")) as { javaPack: unknown };
  const { parseTree } = (await core("lang/engine/grammar.ts")) as {
    parseTree: (pack: unknown, source: string) => Node;
  };

  const data = join(work, "data");
  const paths = resolvePaths(repo, { HOME: join(work, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  const dump = dumpGraph(store);
  store.close();

  const isMain = (path: string): boolean => path.endsWith(".java") && `/${path}`.includes("/src/main/");
  const pathOf = (symId: string): string => symId.replace(/^sym:[^:]+:/, "").replace(/#.*$/, "");
  const edges = dump.edges.filter((e) => e.kind === "calls" && isMain(pathOf(e.src)));
  const lines = new Set(edges.flatMap((e) => e.evidence));

  let files = 0;
  let sites = 0;
  let sitesWithEdge = 0;
  for (const f of dump.files) {
    if (!isMain(f.path) || !existsSync(join(repo, f.path))) continue;
    files++;
    const root = parseTree(javaPack, readFileSync(join(repo, f.path), "utf8"));
    for (const site of root.findAll({ rule: { kind: "method_invocation" } })) {
      sites++;
      const line = (site.field("name") ?? site).range().start.line + 1;
      if (lines.has(`${f.path}:${line}`)) sitesWithEdge++;
    }
  }
  const sum = (list: Edge[], of: (e: Edge) => number): number => list.reduce((n, e) => n + of(e), 0);
  const result = {
    repo: REPO,
    sha: SHA,
    files,
    sites,
    sitesWithEdge,
    share: `${((100 * sitesWithEdge) / Math.max(1, sites)).toFixed(1)}%`,
    high: edges.filter((e) => e.confidence === "high").length,
    low: edges.filter((e) => e.confidence === "low").length,
    calls: sum(edges, (e) => e.count),
    capped: sum(edges, (e) => Math.max(0, e.count - e.evidence.length)),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
