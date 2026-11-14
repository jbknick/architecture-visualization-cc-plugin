/**
 * Replay of real edits (issue #32, step 2). For each of the last N commits touching .ts/.tsx (oldest first) the
 * clone is put at the commit's parent, the main index is healed to it, and each changed .ts/.tsx file is written
 * back at its commit version, as an Edit would, and handed to the real PostToolUse code path. Then the edit is
 * undone (file restored, working layer re-indexed).
 *
 * Per edit it records, in `$GANTRY_PRIVATE_DIR/m2/replay.jsonl` (private):
 *   - `shipped`: what the hook printed (thresholds from the clone's config, stored vectors only);
 *   - `cands`: every duplicate candidate for the changed functions at LOOSE thresholds (nearJaccard 0.75,
 *     codeVector 0.90), with the code vector computed for the new function, so sweep.ts can re-apply any
 *     thresholds without re-running the replay;
 *   - `imports`: import findings.
 * Prints aggregate counts only.
 *
 * Usage: GANTRY_PRIVATE_DIR=... CLAUDE_PLUGIN_DATA=<data dir> pnpm tsx evals/m2/replay.ts <clone> [--commits 200]
 * The clone must be a throwaway (checked out and cleaned repeatedly); its original HEAD is restored at the end.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { changedSymbols, importFindings } from "../../packages/cli/src/hooks/findings.js";
import { postToolUse } from "../../packages/cli/src/hooks/postToolUse.js";
import {
  adviseReuse,
  cachedEmbedder,
  findDuplicates,
  heal,
  indexRepo,
  isIndexable,
  loadConfig,
  normalizeForEmbedding,
  openStore,
  parseSource,
  resolvePaths,
} from "../../packages/core/src/index.js";
import { git, privateDir } from "./lib.js";

const repo = resolve(process.argv[2] ?? "");
const nArg = process.argv.indexOf("--commits");
const nCommits = nArg >= 0 ? Number(process.argv[nArg + 1]) : 200;
const paths = resolvePaths(repo);
const config = loadConfig(paths);
const embedder = await cachedEmbedder()();
if (!embedder) throw new Error("embedding model is not cached");
const out = join(privateDir(), "replay.jsonl");
writeFileSync(out, "");

const startHead = git(repo, ["rev-parse", "HEAD"]).trim();
const commits = git(repo, [
  "log",
  "--no-merges",
  "-n",
  String(nCommits),
  "--format=%H",
  "--",
  "*.ts",
  "*.tsx",
])
  .split("\n")
  .filter(Boolean)
  .reverse();

const LOOSE = {
  ...config,
  duplicates: {
    ...config.duplicates,
    thresholds: { nearJaccard: 0.75, codeVector: 0.9, semantic: config.duplicates.thresholds.semantic },
  },
};
let edits = 0;
let skippedEdits = 0;
const t0 = Date.now();
try {
  for (const [ci, c] of commits.entries()) {
    git(repo, ["checkout", "-q", "--detach", `${c}^`]);
    await heal(paths);
    const changes = git(repo, [
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "-r",
      c,
      "--",
      "*.ts",
      "*.tsx",
    ])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t") as [string, string])
      .filter(([s]) => s === "A" || s === "M");
    for (const [status, rel] of changes) {
      if (!isIndexable(rel, config)) {
        skippedEdits++;
        continue;
      }
      const full = join(repo, rel);
      const text = git(repo, ["show", `${c}:${rel}`]);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);

      // what the user's hook would have said
      const before = openStore(paths.dbPath);
      const prev = new Map(
        before.effectiveSymbols({ fileId: `file:${rel}` }).map((s) => [s.id, s.exactHash]),
      );
      before.close();
      const t1 = Date.now();
      const shipped = await postToolUse(paths, { toolName: "Write", filePath: full, cwd: repo });
      const hookMs = Date.now() - t1;

      // loose candidates with fresh code vectors for the changed functions (the working layer now holds the edit)
      const store = openStore(paths.dbPath);
      const cands: {
        sym: string;
        name: string;
        line: number;
        stmt: number;
        match: string;
        tier: string;
        score: number;
        sameShape: boolean;
        inline: boolean;
      }[] = [];
      const parsed = parseSource(rel, text);
      const changed = changedSymbols(store.effectiveSymbols({ fileId: `file:${rel}` }), prev);
      for (const s of changed) {
        let code: Float32Array | undefined;
        const range = parsed.bodies.get(s.id);
        if (range && s.stmtCount >= 3) {
          const t = normalizeForEmbedding(text, range, rel.endsWith(".tsx") ? "tsx" : "ts").slice(0, 1500);
          if (t !== "") [code] = await embedder.embed([t], "code");
        }
        const found = await findDuplicates(
          store,
          { symbol: s, ...(code ? { vectors: { code } } : {}) },
          { tiers: ["exact", "near", "code_vector"], limit: 10, config: LOOSE },
        );
        for (const f of found) {
          const m = store.getSymbol(f.symbolId);
          cands.push({
            sym: s.id,
            name: s.name,
            line: s.startLine,
            stmt: s.stmtCount,
            match: f.symbolId,
            tier: f.tier,
            score: f.score,
            sameShape: !!m && m.shapeHash !== "" && m.shapeHash === s.shapeHash,
            inline: m ? adviseReuse(store, rel, m, null, config).some((a) => a.inline) : false,
          });
        }
      }
      let head: ReturnType<typeof parseSource> | undefined;
      try {
        head = parseSource(rel, git(repo, ["show", `HEAD:${rel}`]));
      } catch {
        head = undefined;
      }
      const imports = importFindings(store, rel, parsed, head);
      store.close();

      appendFileSync(
        out,
        `${JSON.stringify({ commit: c, status, path: rel, changed: changed.length, shipped: shipped ?? null, hookMs, cands, imports })}\n`,
      );
      edits++;

      // undo
      if (status === "A") rmSync(full, { force: true });
      else git(repo, ["checkout", "--", rel]);
      await indexRepo(paths, { layer: "working", files: [rel] });
    }
    if (ci % 10 === 0)
      process.stderr.write(
        `commit ${ci + 1}/${commits.length}, edits ${edits}, ${Math.round((Date.now() - t0) / 1000)} s\n`,
      );
  }
} finally {
  git(repo, ["checkout", "-q", "--force", startHead]);
  git(repo, ["clean", "-fdq"]);
}
process.stdout.write(
  `${JSON.stringify({ commits: commits.length, edits, notIndexable: skippedEdits, seconds: Math.round((Date.now() - t0) / 1000) })}\n`,
);
void readFileSync;
