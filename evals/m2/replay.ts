/**
 * Replay of real edits (issue #32, step 2; batch flow since #131). For each of the last N commits touching .ts/.tsx
 * (oldest first) the clone is put at the commit's parent and the main index is healed to it. Then the whole commit
 * is applied as one batch, as an agent's turn would leave it: every changed file (sources, package.json, tsconfig,
 * workspace files, anything else) is written at its commit version and every deleted file is removed. Each written
 * file goes through the real PostToolUse trigger (session id = the commit), which records it and re-indexes a source
 * file; a deletion runs no hook, as a shell `rm` would not. Once the batch is applied, the duplicate and import
 * checks run on the post-batch state, each finding is double-checked against disk, and the real Stop hook settles
 * the batch. Then the commit is undone (clone reset, working layer cleared).
 *
 * Per changed .ts/.tsx file (an "edit") it records, in `$GANTRY_PRIVATE_DIR/m2/replay.jsonl` (private):
 *   - `cands`: every duplicate candidate of the file's changed functions at LOOSE thresholds (nearJaccard 0.75, no
 *     token gate, codeVector 0.90), with the code vector computed for the new function, the shape and token Jaccard
 *     of near candidates and whether the double-check against disk kept it (`verified`), so sweep.ts can re-apply
 *     any thresholds without re-running the replay;
 *   - `imports`: import findings added against the parent, with `verified`;
 *   - `shipped`: on the batch's last edit, what the Stop hook printed (thresholds from the clone's config);
 *   - `stopMs`, `stopTimedOut` (batch's last edit) and `stopLost` (every edit): the Stop hook runs as Claude Code runs
 *     it, the built CLI in its own process with the real 1,500 ms budget. When it is cut off at the budget nothing is
 *     printed, so every finding of the batch counts as lost; a file it had no time for and left in the batch counts as
 *     lost too (the replay undoes the commit, so no later Stop sees it). sweep.ts drops the findings of lost edits.
 * Prints aggregate counts only.
 *
 * Usage: GANTRY_PRIVATE_DIR=... CLAUDE_PLUGIN_DATA=<data dir> pnpm tsx evals/m2/replay.ts <clone> [--commits 200]
 * The clone must be a throwaway (checked out and cleaned repeatedly); its original HEAD is restored at the end.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  changedSymbols,
  diskCheck,
  type Finding,
  importFindings,
} from "../../packages/cli/src/hooks/findings.js";
import { postToolUse } from "../../packages/cli/src/hooks/postToolUse.js";
import {
  adviseReuse,
  cachedEmbedder,
  fileId,
  findDuplicates,
  heal,
  isIndexable,
  loadConfig,
  minhashJaccard,
  normalizeForEmbedding,
  openStore,
  parseSource,
  pathOfFileId,
  resolvePaths,
} from "../../packages/core/src/index.js";
import { cliJs, git, privateDir } from "./lib.js";
import { assertThrowawayCopy, requireDataDir } from "./safety.js";

const repo = resolve(process.argv[2] ?? "");
const nArg = process.argv.indexOf("--commits");
const nCommits = nArg >= 0 ? Number(process.argv[nArg + 1]) : 200;
requireDataDir();
assertThrowawayCopy(repo);
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
    thresholds: {
      nearJaccard: 0.75,
      nearTokenJaccard: 0,
      codeVector: 0.9,
      codeVectorTokenJaccard: 0,
      semantic: config.duplicates.thresholds.semantic,
    },
  },
};
const isTs = (p: string): boolean => /\.(ts|tsx)$/.test(p);
let edits = 0;
let skippedEdits = 0;
let otherFiles = 0;
let deletions = 0;
const t0 = Date.now();
try {
  for (const [ci, c] of commits.entries()) {
    git(repo, ["checkout", "-q", "--detach", `${c}^`]);
    await heal(paths);
    const changes = git(repo, ["diff-tree", "--no-commit-id", "--name-status", "--no-renames", "-r", c])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t") as [string, string]);

    // Baselines before the batch: the parent's functions per changed source file.
    const before = openStore(paths.dbPath);
    const prev = new Map<string, Map<string, string>>();
    for (const [, rel] of changes) {
      prev.set(
        rel,
        new Map(before.effectiveSymbols({ fileId: fileId(paths.repo, rel) }).map((s) => [s.id, s.exactHash])),
      );
    }
    before.close();

    // 1. Apply the whole batch; each written file goes through the PostToolUse trigger.
    const session = `replay-${c}`;
    let lastMs = 0;
    for (const [status, rel] of changes) {
      const full = join(repo, rel);
      if (status === "D") {
        rmSync(full, { force: true });
        deletions++;
        continue;
      }
      if (status !== "A" && status !== "M" && status !== "T") continue;
      const buf = git(repo, ["show", `${c}:${rel}`]);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, buf);
      if (!isTs(rel)) otherFiles++;
      const t1 = Date.now();
      await postToolUse(paths, { toolName: "Write", filePath: full, cwd: repo, sessionId: session });
      lastMs = Math.max(lastMs, Date.now() - t1);
    }

    // 2. The checks on the post-batch state, at loose thresholds, each double-checked against disk.
    const store = openStore(paths.dbPath);
    const check = diskCheck(repo, store, config);
    const records: Record<string, unknown>[] = [];
    for (const [status, rel] of changes) {
      if (!isTs(rel) || (status !== "A" && status !== "M")) continue;
      if (!isIndexable(rel, config)) {
        skippedEdits++;
        continue;
      }
      const text = git(repo, ["show", `${c}:${rel}`]);
      const parsed = parseSource(paths.repo, rel, text);
      const changed = changedSymbols(
        store.effectiveSymbols({ fileId: fileId(paths.repo, rel) }),
        prev.get(rel) ?? new Map(),
      );
      const cands: Record<string, unknown>[] = [];
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
          const sameShape = !!m && m.shapeHash !== "" && m.shapeHash === s.shapeHash;
          const shapeScore =
            m && m.minhash.length === s.minhash.length && s.minhash.length > 0
              ? minhashJaccard(s.minhash, m.minhash)
              : null;
          const tokenScore =
            m?.nearMinhash && s.nearMinhash && m.nearMinhash.length === 64 && s.nearMinhash.length === 64
              ? minhashJaccard(s.nearMinhash, m.nearMinhash)
              : null;
          const finding: Finding | undefined = m
            ? {
                kind: "duplicate",
                symbolId: s.id,
                existingId: m.id,
                name: s.name,
                path: rel,
                line: s.startLine,
                existing: m.name,
                existingPath: pathOfFileId(m.fileId),
                existingLine: m.startLine,
                tier: f.tier,
                score: f.score,
                action: "",
                inline: false,
              }
            : undefined;
          cands.push({
            sym: s.id,
            name: s.name,
            line: s.startLine,
            stmt: s.stmtCount,
            match: f.symbolId,
            tier: f.tier,
            score: f.score,
            shapeScore,
            tokenScore,
            sameShape,
            inline: m ? adviseReuse(store, rel, m, null, config).some((a) => a.inline) : false,
            verified: finding ? check(finding) : false,
          });
        }
      }
      let head: ReturnType<typeof parseSource> | undefined;
      try {
        head = parseSource(paths.repo, rel, git(repo, ["show", `${c}^:${rel}`]));
      } catch {
        head = undefined;
      }
      const imports = importFindings(store, rel, parsed, head).map((i) => ({
        line: i.line,
        action: i.action,
        verified: check(i),
      }));
      records.push({ commit: c, status, path: rel, changed: changed.length, hookMs: lastMs, cands, imports });
      edits++;
    }
    store.close();

    // 3. The real Stop hook settles the batch: the built CLI, its own process, the real budget.
    const env = { ...process.env };
    delete env.GANTRY_POST_TOOL_BUDGET_MS;
    const ts = Date.now();
    const stop = spawnSync("node", [cliJs, "hook", "stop"], {
      cwd: repo,
      env,
      input: JSON.stringify({
        session_id: session,
        hook_event_name: "Stop",
        stop_hook_active: false,
        cwd: repo,
      }),
      encoding: "utf8",
    });
    const stopMs = Date.now() - ts;
    const shipped = (stop.stdout ?? "").trim() === "" ? null : (stop.stdout ?? "").trim();
    const stopTimedOut = shipped === null && stopMs >= 1500;
    const left = openStore(paths.dbPath);
    const unsettled = new Set(
      (
        left.db.prepare("SELECT path FROM pending_files WHERE session_id = ?").all(session) as {
          path: string;
        }[]
      ).map((r) => r.path),
    );
    left.db.prepare("DELETE FROM pending_files WHERE session_id = ?").run(session);
    left.close();
    records.forEach((r, i) => {
      const last = i === records.length - 1;
      r.shipped = last ? shipped : null;
      if (last) {
        r.stopMs = stopMs;
        r.stopTimedOut = stopTimedOut;
      }
      r.stopLost = stopTimedOut || unsettled.has(r.path as string);
      appendFileSync(out, `${JSON.stringify(r)}\n`);
    });

    // undo
    git(repo, ["checkout", "-q", "--force", "--detach", `${c}^`]);
    git(repo, ["clean", "-fdq"]);
    const s2 = openStore(paths.dbPath);
    s2.clearWorking();
    s2.close();
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
  `${JSON.stringify({ commits: commits.length, edits, notIndexable: skippedEdits, otherFilesWritten: otherFiles, deletions, seconds: Math.round((Date.now() - t0) / 1000) })}\n`,
);
