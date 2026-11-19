// Spike: how many id-keyed overlay entries still point at the right function after hundreds of commits of
// renames and moves, with and without re-attaching by exactHash (or renamedHash).
// Usage: pnpm tsx docs/spikes/overlay-ids/run.ts --repo <name in evals/oss/repos.json> [--commits 500]
//        [--sample 1000] [--seed 1] [--write-results]
// Prints the repo's section of results.json (sorted keys, no timing) to stdout; timing goes to stderr.
// --write-results also merges the section into docs/spikes/overlay-ids/results.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { heal } from "../../../packages/core/src/heal/index.js";
import { indexRepo } from "../../../packages/core/src/indexer.js";
import { ensureDataDir, resolvePaths } from "../../../packages/core/src/paths/index.js";
import { reviewDiff } from "../../../packages/core/src/review/diff.js";
import { openStore } from "../../../packages/core/src/store/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const resultsPath = join(here, "results.json");
const FUNCTION_LIKE = ["function", "method", "component", "hook"];

interface RepoPin {
  name: string;
  url: string;
  sha: string;
}

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON with sorted keys at every level. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, stable(x)]),
    );
  }
  return v;
}

interface Sym {
  id: string;
  exact: string;
  renamed: string;
}

interface Graph {
  byId: Map<string, Sym>;
  byExact: Map<string, string[]>;
  byRenamed: Map<string, string[]>;
}

function loadGraph(dbPath: string, kinds?: string[]): { graph: Graph; kinds: Map<string, string> } {
  const store = openStore(dbPath);
  try {
    const rows = store.db
      .prepare(
        `SELECT s.id AS id, s.kind AS kind, s.exact_hash AS exact, s.renamed_hash AS renamed
         FROM symbols s JOIN files f ON f.id = s.file_id AND f.layer = s.layer
         WHERE s.layer = 'main' AND f.deleted = 0 ORDER BY s.id`,
      )
      .all() as { id: string; kind: string; exact: string | null; renamed: string | null }[];
    const graph: Graph = { byId: new Map(), byExact: new Map(), byRenamed: new Map() };
    const kindOf = new Map<string, string>();
    for (const r of rows) {
      if (kinds && !kinds.includes(r.kind)) continue;
      const s = { id: r.id, exact: r.exact ?? "", renamed: r.renamed ?? "" };
      graph.byId.set(s.id, s);
      kindOf.set(s.id, r.kind);
      if (s.exact !== "") graph.byExact.set(s.exact, [...(graph.byExact.get(s.exact) ?? []), s.id]);
      if (s.renamed !== "") graph.byRenamed.set(s.renamed, [...(graph.byRenamed.get(s.renamed) ?? []), s.id]);
    }
    return { graph, kinds: kindOf };
  } finally {
    store.close();
  }
}

type Method = "exactHash" | "renamedHash";

interface Entry {
  id0: string;
  exact0: string;
  renamed0: string;
  alive: boolean;
  truthId: string;
  truthExact: string;
  pathChanged: boolean;
  nameChanged: boolean;
  /** Where each re-attaching method currently points. */
  cur: Record<Method, string>;
  wrong: Record<Method, boolean>;
  ambiguous: Record<Method, boolean>;
  /** First commit at which the method pointed away from the truth (cleared when it points right again). */
  missAt: Record<Method, string | undefined>;
}

const METHODS: Method[] = ["exactHash", "renamedHash"];
const pathOf = (id: string): string => id.slice(4, id.indexOf("#"));

function attach(e: Entry, m: Method, g: Graph, sha: string): void {
  if (!g.byId.has(e.cur[m])) {
    const exact = e.exact0 === "" ? [] : (g.byExact.get(e.exact0) ?? []);
    let target: string | undefined;
    if (exact.length === 1) target = exact[0];
    else if (exact.length > 1) e.ambiguous[m] = true;
    else if (m === "renamedHash" && e.renamed0 !== "") {
      const r = g.byRenamed.get(e.renamed0) ?? [];
      if (r.length === 1) target = r[0];
      else if (r.length > 1) e.ambiguous[m] = true;
    }
    if (target !== undefined) {
      e.cur[m] = target;
      if (target !== e.truthId) e.wrong[m] = true;
    }
  }
  if (e.cur[m] !== e.truthId) e.missAt[m] ??= sha;
  else e.missAt[m] = undefined;
}

function workCopy(repo: RepoPin, commits: number): string {
  const src = join(
    process.env.GANTRY_OSS_DIR || join(process.env.HOME ?? "", "Dev", "gantry-oss"),
    `${repo.name}@${repo.sha.slice(0, 7)}`,
  );
  if (!existsSync(src) || git(src, "rev-parse", "HEAD") !== repo.sha) {
    throw new Error(`${src} is missing or not at ${repo.sha}: run pnpm eval:clone`);
  }
  // The shared clone is never touched. Its history may be shallow, so replay from a private copy whose history
  // is fetched from the pinned url at the pinned sha, deep enough for the replayed commits plus the base.
  const dir = join(tmpdir(), "gantry-overlay-ids-work", `${repo.name}-${repo.sha.slice(0, 7)}-${commits}`);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", repo.url);
    git(dir, "fetch", "-q", "--no-tags", `--depth=${commits + 1}`, "origin", repo.sha);
  }
  if (git(dir, "rev-parse", "FETCH_HEAD") !== repo.sha)
    throw new Error(`work copy ${dir} is not at ${repo.sha}`);
  return dir;
}

async function main(): Promise<void> {
  const name = arg("repo");
  if (!name) throw new Error("--repo <name> is required");
  const commits = Number(arg("commits", "500"));
  const sampleN = Number(arg("sample", "1000"));
  const seed = Number(arg("seed", "1"));
  const pins = (
    JSON.parse(readFileSync(resolve(here, "../../../evals/oss/repos.json"), "utf8")) as { repos: RepoPin[] }
  ).repos;
  const repo = pins.find((r) => r.name === name);
  if (!repo) throw new Error(`${name} is not in evals/oss/repos.json`);

  const t0 = Date.now();
  const dir = workCopy(repo, commits);
  const chain = git(dir, "rev-list", "--first-parent", "-n", String(commits + 1), repo.sha)
    .split("\n")
    .reverse();
  if (chain.length !== commits + 1) {
    throw new Error(`only ${chain.length - 1} first-parent commits end at ${repo.sha}, need ${commits}`);
  }
  const base = chain[0] as string;
  git(dir, "checkout", "-q", "--force", "--detach", base);

  // Index data in a fresh dir under os.tmpdir(), HOME too, so no global config is read.
  const tmp = mkdtempSync(join(tmpdir(), "gantry-overlay-ids-"));
  const paths = resolvePaths(dir, { HOME: join(tmp, "home"), CLAUDE_PLUGIN_DATA: join(tmp, "data") });
  ensureDataDir(paths);
  await indexRepo(paths, { layer: "main" });

  // Sample: function-like symbols sorted by id, a seeded partial Fisher-Yates shuffle, the first sampleN.
  const first = loadGraph(paths.dbPath, FUNCTION_LIKE).graph;
  const pool = [...first.byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rnd = mulberry32(seed);
  const take = Math.min(sampleN, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j] as string, pool[i] as string];
  }
  const picked = pool.slice(0, take).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries: Entry[] = picked.map((id) => {
    const s = first.byId.get(id) as Sym;
    return {
      id0: id,
      exact0: s.exact,
      renamed0: s.renamed,
      alive: true,
      truthId: id,
      truthExact: s.exact,
      pathChanged: false,
      nameChanged: false,
      cur: { exactHash: id, renamedHash: id },
      wrong: { exactHash: false, renamedHash: false },
      ambiguous: { exactHash: false, renamedHash: false },
      missAt: { exactHash: undefined, renamedHash: undefined },
    };
  });
  const functionLikeAtBase = pool.length;
  console.error(
    `${name}: base ${base.slice(0, 7)}, ${pool.length} function-like symbols, ${entries.length} sampled`,
  );

  let graph = loadGraph(paths.dbPath).graph;
  const counts = { renamed: 0, moved: 0, modified: 0, removed: 0, fullReindexes: 0 };
  for (let k = 1; k < chain.length; k++) {
    const prev = chain[k - 1] as string;
    const next = chain[k] as string;
    const diff = await reviewDiff(paths, prev, next);
    const byBefore = new Map(
      diff.changes.filter((c) => c.kind !== "added" && c.before).map((c) => [c.before?.id as string, c]),
    );
    for (const c of diff.changes) {
      if (c.kind === "renamed" || c.kind === "moved" || c.kind === "modified" || c.kind === "removed") {
        counts[c.kind]++;
      }
    }
    for (const e of entries) {
      if (!e.alive) continue;
      const c = byBefore.get(e.truthId);
      if (!c) continue;
      if (c.kind === "removed") e.alive = false;
      else if (c.after && (c.kind === "renamed" || c.kind === "moved")) {
        if (pathOf(c.after.id) !== pathOf(e.truthId)) e.pathChanged = true;
        else e.nameChanged = true;
        e.truthId = c.after.id;
        e.truthExact = c.after.exactHash;
      } else if (c.after && c.kind === "modified") {
        e.truthExact = c.after.exactHash;
      }
    }
    git(dir, "checkout", "-q", "--force", "--detach", next);
    const h = await heal(paths, { from: prev });
    if (h.full) counts.fullReindexes++;
    graph = loadGraph(paths.dbPath).graph;
    for (const e of entries) {
      if (!e.alive) continue;
      for (const m of METHODS) attach(e, m, graph, next);
    }
    if (k % 25 === 0)
      console.error(`${name}: ${k}/${commits} commits, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const alive = entries.filter((e) => e.alive);
  const survives = {
    id: (e: Entry) => e.id0 === e.truthId && graph.byId.has(e.id0),
    exactHash: (e: Entry) => e.cur.exactHash === e.truthId && graph.byId.has(e.truthId),
    renamedHash: (e: Entry) => e.cur.renamedHash === e.truthId && graph.byId.has(e.truthId),
  };
  const cause = (e: Entry, m: Method | "id"): string => {
    if (m !== "id" && e.ambiguous[m]) return "ambiguous_hash";
    const modified = e.truthExact !== e.exact0;
    if (e.pathChanged) return modified ? "modified_and_moved" : "moved";
    if (e.nameChanged) return modified ? "modified_and_renamed" : "renamed";
    return "other";
  };
  const causesFor = (m: Method | "id"): Record<string, number> => {
    const out: Record<string, number> = {
      ambiguous_hash: 0,
      modified_and_moved: 0,
      modified_and_renamed: 0,
      moved: 0,
      other: 0,
      renamed: 0,
    };
    for (const e of alive) if (!survives[m](e)) out[cause(e, m)] = (out[cause(e, m)] ?? 0) + 1;
    return out;
  };
  const examples = alive
    .filter((e) => !survives.exactHash(e))
    .slice(0, 10)
    .map((e) => ({
      cause: cause(e, "exactHash"),
      entry: e.id0,
      firstMissAtCommit: e.missAt.exactHash ?? null,
      pointsTo: e.cur.exactHash,
      truth: e.truthId,
      wrongReattach: e.wrong.exactHash,
    }));

  const section = {
    baseSha: base,
    commits,
    deleted: entries.length - alive.length,
    entries: entries.length,
    examples,
    functionLikeAtBase,
    headSha: repo.sha,
    replayStats: counts,
    seed,
    stillExist: alive.length,
    survived: {
      exactHash: alive.filter(survives.exactHash).length,
      id: alive.filter(survives.id).length,
      renamedHash: alive.filter(survives.renamedHash).length,
    },
    unresolvedByCause: {
      exactHash: causesFor("exactHash"),
      id: causesFor("id"),
      renamedHash: causesFor("renamedHash"),
    },
    wrongReattaches: {
      exactHash: entries.filter((e) => e.wrong.exactHash).length,
      renamedHash: entries.filter((e) => e.wrong.renamedHash).length,
    },
  };
  const text = `${JSON.stringify(stable(section), null, 2)}\n`;
  process.stdout.write(text);
  console.error(`${name}: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (process.argv.includes("--write-results")) {
    const all = existsSync(resultsPath)
      ? (JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, unknown>)
      : {};
    all[name] = section;
    writeFileSync(resultsPath, `${JSON.stringify(stable(all), null, 2)}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
