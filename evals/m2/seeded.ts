/**
 * Seeded duplicates (issue #32, step 1). For each case in `evals/seeded-duplicates/cases.json` and its private
 * binding (existing symbol id + target file, in `$GANTRY_PRIVATE_DIR/m2/seeded-bindings.json`):
 *   1. gantry_find_similar, code form and query form, before the file exists (as an agent would call it);
 *   2. write the new code to the target file in the throwaway copy and run the real PostToolUse hook CLI;
 *   3. diagnostics for the threshold fit: the cosine between the draft's code vector (computed here, the
 *      product does not embed a draft) and the existing function's stored vector, and the query's cosine to
 *      the existing function's description vector.
 * A case is FOUND when the existing function is returned by the hook or by either find_similar form; its advice
 * is CORRECT when the situation adviseReuse gives for the target file equals the expected situation.
 *
 * Usage: GANTRY_PRIVATE_DIR=... CLAUDE_PLUGIN_DATA=<data dir of the copy> pnpm tsx evals/m2/seeded.ts <copy>
 * The data dir is copied first and the copy is the one written to, so the original index stays clean. The copy
 * of the repo gets the seeded files and is restored with `git checkout`/`git clean` at the end.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  adviseReuse,
  cachedEmbedder,
  contentKey,
  getVector,
  knn,
  normalizeForEmbedding,
  openStore,
  parseSource,
  resolvePaths,
  type Store,
} from "../../packages/core/src/index.js";
import { findSimilarTool } from "../../packages/mcp/src/tools/findSimilar.js";
import {
  gantryRoot,
  git,
  readPrivate,
  runPostToolHook,
  type SeededBinding,
  type SeededCase,
  writePrivate,
} from "./lib.js";
import { assertThrowawayCopy } from "./safety.js";
import { type FormResult, printSeeded, type SeededResult } from "./seeded-report.js";

const repo = resolve(process.argv[2] ?? "");
const dataSrc = process.env.CLAUDE_PLUGIN_DATA;
if (!dataSrc) throw new Error("set CLAUDE_PLUGIN_DATA to the data dir used to index the copy");
const cases = JSON.parse(
  readFileSync(join(gantryRoot, "evals", "seeded-duplicates", "cases.json"), "utf8"),
) as SeededCase[];
const bindings = new Map(readPrivate<SeededBinding[]>("seeded-bindings.json").map((b) => [b.id, b]));

assertThrowawayCopy(repo);
const dataCopy = mkdtempSync(join(tmpdir(), "gantry-seeded-data-"));
cpSync(dataSrc, dataCopy, { recursive: true });
const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataCopy };
process.env.CLAUDE_PLUGIN_DATA = dataCopy;
const paths = resolvePaths(repo);
const store: Store = openStore(paths.dbPath);
const embedder = await cachedEmbedder()();
if (!embedder) throw new Error("embedding model is not cached");

function derivedCopy(existingId: string, newName: string): string {
  const sym = store.getSymbol(existingId);
  if (!sym) throw new Error("existing symbol missing");
  const rel = sym.fileId.replace(/^file:/, "");
  const lines = readFileSync(join(repo, rel), "utf8")
    .split("\n")
    .slice(sym.startLine - 1, sym.endLine);
  let text = lines.join("\n").replace(sym.name, newName);
  if (!/^\s*export\b/.test(text)) text = `export ${text}`;
  return `${text}\n`;
}

const ctx = {
  paths,
  store,
  env,
  log: { error() {}, info() {} },
  getEmbedder: cachedEmbedder(),
};
type Match = { id: string; tier: string; score: number; advice: { situation: number } | null };
async function similar(args: Record<string, unknown>): Promise<Match[]> {
  const r = (await findSimilarTool.run({ limit: 10, ...args }, ctx as never)) as { matches?: Match[] };
  return r.matches ?? [];
}
function form(matches: Match[], existing: string): FormResult {
  const i = matches.findIndex((m) => m.id === existing);
  const m = matches[i];
  return {
    found: i >= 0,
    rank: i >= 0 ? i + 1 : null,
    tier: m?.tier ?? null,
    score: m?.score ?? null,
    situation: m?.advice?.situation ?? null,
  };
}

const results: SeededResult[] = [];
const written: string[] = [];
try {
  for (const c of cases) {
    const b = bindings.get(c.id);
    if (!b) throw new Error(`no binding for ${c.id}`);
    const existing = store.getSymbol(b.existing);
    if (!existing) throw new Error(`binding of ${c.id} does not resolve`);
    const code = c.newCode ?? derivedCopy(b.existing, b.copyAs ?? "copiedHelper");
    const query = b.query ?? c.query;
    if (query === undefined) throw new Error(`no query for ${c.id}`);
    const lang = b.targetFile.endsWith("x") ? "tsx" : "ts";

    const codeMatches = await similar({ code, caller_path: b.targetFile });
    const queryMatches = await similar({ query, caller_path: b.targetFile });

    // diagnostics
    const parsed = parseSource(`scratch.${lang}`, code);
    const sym = parsed.symbols.find((s) => ["function", "component", "hook", "method"].includes(s.kind));
    const range = sym && parsed.bodies.get(sym.id);
    let draftCos: number | null = null;
    if (range) {
      const text = normalizeForEmbedding(code, range, lang).slice(0, 1500);
      const [v] = await embedder.embed([text], "code");
      const ev =
        existing.exactHash === "" ? undefined : getVector(store, "vec_code", contentKey(existing.exactHash));
      if (v && ev) draftCos = v.reduce((s, x, i) => s + x * (ev[i] as number), 0);
    }
    let queryCos: number | null = null;
    let queryRank: number | null = null;
    let bestOther: number | null = null;
    const [qv] = await embedder.embed([query], "query");
    if (qv) {
      const near = knn(store, "vec_descriptions", qv, 200);
      const ek = existing.exactHash === "" ? "" : contentKey(existing.exactHash);
      const at = near.findIndex((n) => n.contentKey === ek);
      queryCos = at >= 0 ? (near[at]?.cosine ?? null) : null;
      queryRank = at >= 0 ? at + 1 : null;
      bestOther = near.find((n) => n.contentKey !== ek)?.cosine ?? null;
    }

    // write the file and run the real hook
    mkdirSync(dirname(join(repo, b.targetFile)), { recursive: true });
    writeFileSync(join(repo, b.targetFile), code);
    written.push(b.targetFile);
    const hook = runPostToolHook(repo, b.targetFile, env);
    let hookFound = false;
    let hookTier: string | null = null;
    let hookScore: number | null = null;
    if (hook.stdout.trim() !== "") {
      const ctxText = (JSON.parse(hook.stdout) as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext;
      const re = new RegExp(
        ` looks like ${existing.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} in ${existing.fileId
          .replace(/^file:/, "")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+ \\[(\\w+) ([0-9.]+)\\]`,
      );
      const m = re.exec(ctxText);
      if (m) {
        hookFound = true;
        hookTier = m[1] ?? null;
        hookScore = Number(m[2]);
      }
    }

    const advice = adviseReuse(store, b.targetFile, existing)[0];
    const situation = advice?.situation ?? null;
    const cf = form(codeMatches, b.existing);
    const qf = form(queryMatches, b.existing);
    const foundBy = [hookFound ? "hook" : "", cf.found ? "code" : "", qf.found ? "query" : ""].filter(
      Boolean,
    );
    const tiers = [hookTier, cf.tier, qf.tier].filter((t): t is string => t !== null);
    results.push({
      id: c.id,
      misleading: c.misleading,
      hook: { found: hookFound, tier: hookTier, score: hookScore },
      code: cf,
      query: qf,
      situation,
      expectedSituation: c.expected.situation,
      found: foundBy.length > 0,
      adviceCorrect: foundBy.length > 0 && situation === c.expected.situation,
      tierOk: tiers.some((t) => c.expected.tiers.includes(t)),
      foundBy,
      draftCodeCosine: draftCos,
      queryDescCosine: queryCos,
      queryDescRank: queryRank,
      queryBestOtherCosine: bestOther,
    });
  }
} finally {
  store.close();
  git(repo, ["checkout", "--", "."]);
  for (const f of written) rmSync(join(repo, f), { force: true });
  spawnSync("git", ["clean", "-fdq"], { cwd: repo });
  rmSync(dataCopy, { recursive: true, force: true });
}

writePrivate("seeded-results.json", results);
printSeeded(results);
