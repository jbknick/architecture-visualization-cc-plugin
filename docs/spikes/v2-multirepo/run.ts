// Spike v2-multirepo: does one store with a repo column hold two related repos correctly, and at what cost?
// Usage: pnpm tsx docs/spikes/v2-multirepo/run.ts <hono-clone> <middleware-clone>
// Needs `pnpm build` first (it imports the built core). Everything is done in copies under a fresh temp dir with its
// own HOME, so the clones are never modified. Prints the results table as JSON on stdout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createResolver,
  detectWorkspaces,
  discoverFiles,
  ensureDataDir,
  hybridSearch,
  indexRepo,
  loadConfig,
  openStore,
  type ParsedFile,
  parseSource,
  rebuildSimilarEdges,
  repoOfId,
  type Store,
  type WorkspaceRecord,
} from "../../../packages/core/dist/index.js";
import {
  copyClone,
  createCombined,
  dbBytes,
  dropRepo,
  dupGroups,
  git,
  indexSeparate,
  loadAvg,
  median,
  mergeRepo,
  pathsFor,
  repoRowHashes,
} from "./lib.js";
import { workspaceFileScenarios } from "./workspace-file.js";

const [honoSrc, mwSrc] = process.argv.slice(2);
if (!honoSrc || !mwSrc) throw new Error("usage: run.ts <hono-clone> <middleware-clone>");
const RUNS = 3;
const HONO = "honojs/hono";
const MW = "honojs/middleware";

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gantry-multirepo-")));
const wsDir = path.join(work, "ws");
fs.mkdirSync(wsDir);
const honoRoot = path.join(wsDir, "hono");
const mwRoot = path.join(wsDir, "middleware");
copyClone(honoSrc, honoRoot);
copyClone(mwSrc, mwRoot);
const shas = { hono: git(honoRoot, "rev-parse", "HEAD"), middleware: git(mwRoot, "rev-parse", "HEAD") };

// ---- cost: index time (median of 3) and db size, one store vs two separate stores ------------------------------
const costRuns: {
  load: string;
  honoMs: number;
  mwMs: number;
  mergeMs: number;
  separateBytes: number;
  oneBytes: number;
}[] = [];
let keep: { a: string; b: string; one: string } | undefined;
for (let i = 0; i < RUNS; i++) {
  const home = path.join(work, `home-cost-${i}`);
  const pA = pathsFor(honoRoot, home);
  const pB = pathsFor(mwRoot, home);
  const load = loadAvg();
  const a = await indexSeparate(pA);
  const b = await indexSeparate(pB);
  const oneDb = path.join(home, "one", "gantry.db");
  const t0 = performance.now();
  const one = createCombined(oneDb);
  mergeRepo(one, pA.dbPath, pA.repo);
  mergeRepo(one, pB.dbPath, pB.repo);
  one.close();
  const mergeMs = Math.round(performance.now() - t0);
  costRuns.push({
    load,
    honoMs: a.ms,
    mwMs: b.ms,
    mergeMs,
    separateBytes: dbBytes(pA.dbPath) + dbBytes(pB.dbPath),
    oneBytes: dbBytes(oneDb),
  });
  if (i === 0) keep = { a: pA.dbPath, b: pB.dbPath, one: oneDb };
}
if (!keep) throw new Error("no run");
const sepMs = costRuns.map((r) => r.honoMs + r.mwMs);
const oneMs = costRuns.map((r) => r.honoMs + r.mwMs + r.mergeMs);
const sepBytes = costRuns.map((r) => r.separateBytes);
const oneBytes = costRuns.map((r) => r.oneBytes);

// Analysis works on copies, so the cost-run stores stay as they were.
const an = path.join(work, "analysis");
fs.mkdirSync(an);
const dbA = path.join(an, "a.db");
const dbB = path.join(an, "b.db");
const dbOne = path.join(an, "one.db");
fs.copyFileSync(keep.a, dbA);
fs.copyFileSync(keep.b, dbB);
fs.copyFileSync(keep.one, dbOne);
const anPathsA = pathsFor(honoRoot, path.join(work, "home-cost-0"));
const config = loadConfig(anPathsA);

// ---- ids ----------------------------------------------------------------------------------------------------------
const sA = openStore(dbA);
const sB = openStore(dbB);
sA.db.prepare("ATTACH DATABASE ? AS b").run(dbB);
const count = (sql: string): number => (sA.db.prepare(sql).get() as { n: number }).n;
const idCollisions = {
  files: count("SELECT COUNT(*) n FROM files x JOIN b.files y ON x.id = y.id AND x.layer = y.layer"),
  symbols: count("SELECT COUNT(*) n FROM symbols x JOIN b.symbols y ON x.id = y.id AND x.layer = y.layer"),
  edges: count(
    "SELECT COUNT(*) n FROM edges x JOIN b.edges y ON x.src = y.src AND x.dst = y.dst AND x.kind = y.kind AND x.layer = y.layer",
  ),
  adapterNodes: count(
    "SELECT COUNT(*) n FROM adapter_nodes x JOIN b.adapter_nodes y ON x.id = y.id AND x.layer = y.layer",
  ),
  searchRows: count("SELECT COUNT(*) n FROM fts_symbols x JOIN b.fts_symbols y ON x.symbol_id = y.symbol_id"),
  workspaces: count("SELECT COUNT(*) n FROM workspaces x JOIN b.workspaces y ON x.id = y.id"),
};
const wsIdCollisions = (
  sA.db.prepare("SELECT x.id FROM workspaces x JOIN b.workspaces y ON x.id = y.id ORDER BY x.id").all() as {
    id: string;
  }[]
).map((r) => r.id);
sA.db.exec("DETACH DATABASE b");
const totals = {
  hono: { files: count("SELECT COUNT(*) n FROM files"), symbols: count("SELECT COUNT(*) n FROM symbols") },
  middleware: {
    files: (sB.db.prepare("SELECT COUNT(*) n FROM files").get() as { n: number }).n,
    symbols: (sB.db.prepare("SELECT COUNT(*) n FROM symbols").get() as { n: number }).n,
  },
};

// ---- stock indexer, two passes into one unmodified store ------------------------------------------------------
const stockHome = path.join(work, "home-stock");
const spA = pathsFor(honoRoot, stockHome);
const spB = pathsFor(mwRoot, stockHome);
const stock = openStore(path.join(stockHome, "stock", "gantry.db"));
ensureDataDir(spA);
ensureDataDir(spB);
const stockCount = (): { files: number; symbols: number; search: number } => ({
  files: (stock.db.prepare("SELECT COUNT(*) n FROM files WHERE layer='main'").get() as { n: number }).n,
  symbols: (stock.db.prepare("SELECT COUNT(*) n FROM symbols WHERE layer='main'").get() as { n: number }).n,
  search: (stock.db.prepare("SELECT COUNT(*) n FROM fts_symbols").get() as { n: number }).n,
});
await indexRepo(spA, { layer: "main", store: stock });
const stockAfterHono = stockCount();
await indexRepo(spB, { layer: "main", store: stock });
const stockAfterBoth = stockCount();
const honoFilesLeft = (
  stock.db
    .prepare("SELECT COUNT(*) n FROM files WHERE layer='main' AND id LIKE 'file:honojs/hono:%'")
    .get() as {
    n: number;
  }
).n;
const stockMeta = { repo: stock.getMeta("repo"), head_sha: stock.getMeta("head_sha") };
stock.close();

// ---- duplicates ---------------------------------------------------------------------------------------------------
const simOpts = { tiers: ["exact", "near"] as ("exact" | "near")[], config };
const one = openStore(dbOne);
const dupMs: Record<string, number> = {};
let t = performance.now();
const edgesA = await rebuildSimilarEdges(sA, simOpts);
dupMs.hono = Math.round(performance.now() - t);
t = performance.now();
const edgesB = await rebuildSimilarEdges(sB, simOpts);
dupMs.middleware = Math.round(performance.now() - t);
t = performance.now();
const edgesOne = await rebuildSimilarEdges(one, simOpts);
dupMs.one = Math.round(performance.now() - t);
const gA = dupGroups(sA.db);
const gB = dupGroups(sB.db);
const gOne = dupGroups(one.db);
const sepGroups = [...gA.groups, ...gB.groups];
const sepKeys = new Set(sepGroups.map((g) => g.key));
const oneSets = gOne.groups.map((g) => new Set(g.members));
const lost = sepGroups.filter((g) => !oneSets.some((s) => g.members.every((m) => s.has(m))));
const gained = gOne.groups.filter((g) => !sepKeys.has(g.key));
const cross = gOne.groups.filter((g) => new Set(g.members.map((m) => repoOfId(m))).size > 1);
const sepEdges = new Set([...gA.edges, ...gB.edges]);
const oneEdgeSet = new Set(gOne.edges);
const dups = {
  separateGroups: { hono: gA.groups.length, middleware: gB.groups.length, union: sepGroups.length },
  oneStoreGroups: gOne.groups.length,
  lost: lost.length,
  gained: gained.length,
  crossRepo: cross.length,
  // Which repo's rows hold the cross-repo similar_to edges: the lower id is `src`, and the edge sits on src's file.
  crossRepoEdgesStoredOnRepo: Object.fromEntries(
    (
      one.db
        .prepare(
          `SELECT f.repo AS repo, COUNT(*) AS n FROM edges e JOIN files f ON f.id = e.file_id AND f.layer = e.layer
           WHERE e.kind = 'similar_to' AND substr(e.dst, 1, length('sym:' || f.repo || ':')) != 'sym:' || f.repo || ':'
           GROUP BY f.repo`,
        )
        .all() as { repo: string; n: number }[]
    ).map((r) => [r.repo, r.n]),
  ),
  crossRepoSamples: cross.slice(0, 5).map((g) => g.members),
  gainedNotCross: gained.filter((g) => !cross.includes(g)).length,
  edges: {
    separateUnion: sepEdges.size,
    one: oneEdgeSet.size,
    lost: [...sepEdges].filter((e) => !oneEdgeSet.has(e)).length,
    gained: [...oneEdgeSet].filter((e) => !sepEdges.has(e)).length,
    rebuildReturned: { hono: edgesA, middleware: edgesB, one: edgesOne },
  },
  rebuildMs: dupMs,
};

// ---- search -------------------------------------------------------------------------------------------------------
const HONO_ONLY = [
  "getCookie",
  "setCookie",
  "serveStatic",
  "createMiddleware",
  "secureHeaders",
  "bodyLimit",
  "basicAuth",
  "languageDetector",
  "trimTrailingSlash",
  "ipRestriction",
];
const MW_ONLY = [
  "sValidator",
  "trpcServer",
  "oidcAuthMiddleware",
  "clerkMiddleware",
  "graphqlServer",
  "prometheus",
  "sentry",
  "uaBlocker",
  "casbin",
  "createEmitter",
];
const nameCount = (db: Store["db"], name: string): number =>
  (db.prepare("SELECT COUNT(*) n FROM symbols WHERE name = ? AND layer = 'main'").get(name) as { n: number })
    .n;
/** 1-based rank of the symbol named `name` of `wantRepo` in the results for `query`; null when not in the top 50. */
async function rankOf(store: Store, query: string, name: string, wantRepo: string): Promise<number | null> {
  const hits = await hybridSearch(store, query, { limit: 50 });
  const i = hits.findIndex((h) => h.name === name && repoOfId(h.id) === wantRepo);
  return i < 0 ? null : i + 1;
}
/** `getCookie` -> `get cookie`: the same query as words, so the exact-name boost does not decide it. */
const asWords = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
async function searchDirection(names: string[], wantRepo: string, otherDb: Store["db"], ownStore: Store) {
  const rows: {
    query: string;
    onlyInWantedRepo: boolean;
    rankOneStore: number | null;
    rankOneStoreAsWords: number | null;
    foundInOwnStore: boolean;
  }[] = [];
  for (const q of names) {
    const wantDb = wantRepo === HONO ? sA.db : sB.db;
    rows.push({
      query: q,
      onlyInWantedRepo: nameCount(wantDb, q) > 0 && nameCount(otherDb, q) === 0,
      rankOneStore: await rankOf(one, q, q, wantRepo),
      rankOneStoreAsWords: await rankOf(one, asWords(q), q, wantRepo),
      foundInOwnStore: (await rankOf(ownStore, q, q, wantRepo)) !== null,
    });
  }
  const top5 = (pick: (r: (typeof rows)[number]) => number | null): number =>
    rows.filter((r) => pick(r) !== null && (pick(r) as number) <= 5).length;
  return { rows, top5: top5((r) => r.rankOneStore), top5AsWords: top5((r) => r.rankOneStoreAsWords) };
}
// Queries typed in middleware naming hono functions: the querying repo's own store is B.
const searchFromMiddleware = await searchDirection(HONO_ONLY, HONO, sB.db, sB);
const searchFromHono = await searchDirection(MW_ONLY, MW, sA.db, sA);
// Workspace ids: `ws:.` names the root workspace of each repo.
const wsIdUse = {
  filesWithWorkspaceIdRootByRepo: Object.fromEntries(
    (
      one.db
        .prepare("SELECT repo, COUNT(*) n FROM files WHERE workspace_id = 'ws:.' GROUP BY repo")
        .all() as {
        repo: string;
        n: number;
      }[]
    ).map((r) => [r.repo, r.n]),
  ),
  listWorkspacesRowsWithIdRoot: one.listWorkspaces().filter((w) => w.id === "ws:.").length,
  workspaceFilterRootHitsFromRepos: [
    ...new Set(
      (await hybridSearch(one, "index", { workspace: "ws:.", limit: 50 })).map((h) => repoOfId(h.id)),
    ),
  ].sort(),
};

// ---- sibling packages ---------------------------------------------------------------------------------------------
interface Parsed {
  rel: string;
  pf: ParsedFile;
}
function parseRepo(root: string, home: string, repoLabel: string, prefix: string) {
  const p = pathsFor(root, home);
  const cfg = loadConfig(p);
  const ws = detectWorkspaces(root, cfg);
  const files: Parsed[] = discoverFiles(p, cfg, ws).map((d) => ({
    rel: d.path,
    pf: parseSource(repoLabel, prefix + d.path, fs.readFileSync(path.join(root, d.path), "utf8")),
  }));
  return { ws, files };
}
const sibHome = path.join(work, "home-sibling");
const mwOnly = parseRepo(mwRoot, sibHome, "mw", "");
const honoParsed = parseRepo(honoRoot, sibHome, "ws", "hono/");
const mwInUnion = parseRepo(mwRoot, sibHome, "ws", "middleware/");
const isHonoSpec = (s: string): boolean => s === "hono" || s.startsWith("hono/");
const pairs: { file: string; spec: string }[] = [];
for (const f of mwInUnion.files) {
  const specs = new Set<string>();
  for (const i of f.pf.imports) if (isHonoSpec(i.specifier)) specs.add(i.specifier);
  for (const e of f.pf.exports)
    if (e.fromSpecifier && isHonoSpec(e.fromSpecifier)) specs.add(e.fromSpecifier);
  for (const spec of [...specs].sort()) pairs.push({ file: f.rel, spec });
}
// Without the sibling: the resolver of the middleware repo alone (the single-repo case), fresh clone, no install.
const solo = createResolver({
  root: mwRoot,
  repo: "mw",
  workspaces: mwOnly.ws,
  parsed: new Map(mwOnly.files.map((f) => [f.pf.fileId, f.pf])),
});
const withoutKinds: Record<string, number> = { file: 0, external: 0, unresolved: 0 };
for (const p of pairs) {
  const r = solo.resolveSpecifier(`file:mw:${p.file}`, p.spec);
  withoutKinds[r.kind] = (withoutKinds[r.kind] ?? 0) + 1;
}
// With the sibling: one resolver rooted at the workspace dir, both repos' workspaces (dirs prefixed by the repo dir).
const prefixWs = (dir: string, list: WorkspaceRecord[]): WorkspaceRecord[] =>
  list.map((w) => ({ ...w, id: `ws:${dir}:${w.id.slice(3)}`, dir: w.dir === "." ? dir : `${dir}/${w.dir}` }));
const unionWs = [...prefixWs("hono", honoParsed.ws), ...prefixWs("middleware", mwInUnion.ws)];
const union = createResolver({
  root: wsDir,
  repo: "ws",
  workspaces: unionWs,
  parsed: new Map([...honoParsed.files, ...mwInUnion.files].map((f) => [f.pf.fileId, f.pf])),
});
const withKinds: Record<string, number> = { file: 0, external: 0, unresolved: 0 };
const toHonoSource: string[] = [];
const notToHonoSource: { file: string; spec: string; kind: string; to?: string }[] = [];
for (const p of pairs) {
  const r = union.resolveSpecifier(`file:ws:middleware/${p.file}`, p.spec);
  withKinds[r.kind] = (withKinds[r.kind] ?? 0) + 1;
  if (r.kind === "file" && r.fileId.startsWith("file:ws:hono/src/"))
    toHonoSource.push(r.fileId.slice("file:ws:hono/".length));
  else notToHonoSource.push({ ...p, kind: r.kind, ...(r.kind === "file" ? { to: r.fileId } : {}) });
}
const specMapping = new Map<string, string>();
for (const p of pairs) {
  const r = union.resolveSpecifier(`file:ws:middleware/${p.file}`, p.spec);
  if (r.kind === "file") specMapping.set(p.spec, r.fileId.slice("file:ws:hono/".length));
}
const bySpec = new Set(pairs.map((p) => p.spec));
const notBySpec = new Map<string, number>();
for (const n of notToHonoSource) notBySpec.set(n.spec, (notBySpec.get(n.spec) ?? 0) + 1);
const sibling = {
  pairs: pairs.length,
  importerFiles: new Set(pairs.map((p) => p.file)).size,
  distinctSpecifiers: bySpec.size,
  withoutSibling: { toHonoSource: 0, kinds: withoutKinds },
  withSibling: {
    toHonoSource: toHonoSource.length,
    pct: Math.round((1000 * toHonoSource.length) / pairs.length) / 10,
    kinds: withKinds,
    distinctHonoFilesReached: new Set(toHonoSource).size,
    specifierToFile: Object.fromEntries([...specMapping].sort()),
    notResolvedBySpecifier: Object.fromEntries([...notBySpec].sort()),
    sample: notToHonoSource.slice(0, 5),
  },
};

// ---- heal of one repo ---------------------------------------------------------------------------------------------
const hashesBefore = repoRowHashes(one.db, MW, false);
const hashesBeforeDerived = repoRowHashes(one.db, MW, true);
const honoBefore = repoRowHashes(one.db, HONO, false);
const oldSha = git(honoRoot, "rev-list", "-n", "1", "--skip=100", "HEAD");
const oldDate = git(honoRoot, "log", "-1", "--format=%cs", oldSha);
git(honoRoot, "checkout", "-q", "--detach", oldSha);
const changedPaths = git(honoRoot, "diff", "--name-only", oldSha, shas.hono).split("\n").filter(Boolean);
const healHome = path.join(work, "home-heal");
const pHeal = pathsFor(honoRoot, healHome);
const healIdx = await indexSeparate(pHeal);
const danglingBefore = (
  one.db
    .prepare(
      "SELECT COUNT(*) n FROM edges e WHERE e.kind = 'similar_to' AND (NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.dst) OR NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.src))",
    )
    .get() as { n: number }
).n;
t = performance.now();
dropRepo(one, HONO);
mergeRepo(one, pHeal.dbPath, HONO);
const replaceMs = Math.round(performance.now() - t);
const hashesAfter = repoRowHashes(one.db, MW, false);
const hashesAfterDerived = repoRowHashes(one.db, MW, true);
const honoAfter = repoRowHashes(one.db, HONO, false);
const danglingAfter = (
  one.db
    .prepare(
      "SELECT COUNT(*) n FROM edges e WHERE e.kind = 'similar_to' AND (NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.dst) OR NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.src))",
    )
    .get() as { n: number }
).n;
await rebuildSimilarEdges(one, simOpts); // what `heal` does after a change: derived edges follow the main layer
const hashesAfterRebuild = repoRowHashes(one.db, MW, true);
const changedSet = new Set(changedPaths);
const reachedChanged = [...new Set(toHonoSource)].filter((p) => changedSet.has(p)).length;
const heal = {
  honoCheckedOut: { sha: oldSha, date: oldDate, filesChangedAgainstPinned: changedPaths.length },
  otherRepoRowsSha256: {
    before: hashesBefore.all,
    after: hashesAfter.all,
    equal: hashesBefore.all === hashesAfter.all,
  },
  otherRepoRowsPerTable: Object.fromEntries(
    Object.keys(hashesBefore)
      .filter((k) => k !== "all")
      .map((k) => [k, hashesBefore[k] === hashesAfter[k]]),
  ),
  withDerivedEdgesBeforeVsAfterReplace: hashesBeforeDerived.all === hashesAfterDerived.all,
  withDerivedEdgesAfterRebuildSimilarEdges: hashesBeforeDerived.all === hashesAfterRebuild.all,
  honoRowsChanged: honoBefore.all !== honoAfter.all,
  danglingSimilarEdges: { before: danglingBefore, afterReplace: danglingAfter },
  reindexMs: healIdx.ms,
  replaceRowsMs: replaceMs,
  siblingTargetsTouchedByHonoChange: { reachedFiles: new Set(toHonoSource).size, changed: reachedChanged },
};
one.close();
sA.close();
sB.close();

// ---- workspace file -----------------------------------------------------------------------------------------------
const workspaceFile = workspaceFileScenarios(work, honoSrc);

// ---- output -------------------------------------------------------------------------------------------------------
const cpus = os.cpus();
const ratio = (a: number, b: number): number => Math.round((1000 * a) / b) / 1000;
const table = {
  setup: {
    shas,
    machine: `${cpus[0]?.model ?? "unknown"}, ${cpus.length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.type()} ${os.release()}`,
    node: process.version,
    loadAtEnd: loadAvg(),
    totals,
  },
  idCollisions: { ...idCollisions, workspaceIdsColliding: wsIdCollisions },
  stockIndexerTwoPassesIntoOneStore: {
    afterHonoPass: stockAfterHono,
    afterMiddlewarePass: stockAfterBoth,
    honoFilesLeft,
    meta: stockMeta,
  },
  search: {
    fromMiddlewareForHonoFunctions: {
      top5: searchFromMiddleware.top5,
      top5AsWords: searchFromMiddleware.top5AsWords,
      of: HONO_ONLY.length,
      rows: searchFromMiddleware.rows,
    },
    fromHonoForMiddlewareFunctions: {
      top5: searchFromHono.top5,
      top5AsWords: searchFromHono.top5AsWords,
      of: MW_ONLY.length,
      rows: searchFromHono.rows,
    },
    workspaceIds: wsIdUse,
  },
  duplicates: dups,
  heal,
  sibling,
  cost: {
    runs: costRuns,
    medianMs: {
      separateSum: median(sepMs),
      oneStore: median(oneMs),
      ratio: ratio(median(oneMs), median(sepMs)),
    },
    medianBytes: {
      separateSum: median(sepBytes),
      oneStore: median(oneBytes),
      ratio: ratio(median(oneBytes), median(sepBytes)),
    },
  },
  workspaceFile,
};
console.log(JSON.stringify(table, null, 2));
if (!process.env.KEEP_WORK) fs.rmSync(work, { recursive: true, force: true });
else console.error(`kept ${work}`);
