// Corpus selection of the plan-estimates spike (#304). Applies the rule written in docs/spikes/plan-estimates.md:
//   pnpm tsx docs/spikes/plan-estimates/select.ts [--per-repo 55]
// Per corpus repo, newest first, a merged pull request is kept when
//   - it was merged into the default branch (main) before the pinned SHA and its merge commit is an ancestor of it;
//   - its author is not a bot and its title is not a dependency bump;
//   - it changes 2 to 40 indexable files (git diff of the first parent against the merge commit);
//   - its description, or else the body of the issue it closes, has at least 200 characters.
// Writes prs.json ({ repo, number, base, merge } only), subset.json (the first 20 of prs.json by a seeded
// shuffle, seed 1) and pilot.json (the first 10 of the same shuffle). PR text goes to the git-ignored
// evals/oss/cache/ and is never committed. Needs the history clones (see README of the report) and `gh`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GantryPaths, isIndexable, loadConfig } from "../../../packages/core/src/index.js";
import {
  corpusRepos,
  git,
  here,
  historyClone,
  type PlanText,
  type Pr,
  planCacheFile,
  prKey,
  seededShuffle,
  stable,
} from "./lib.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PER_REPO = Number(arg("--per-repo") ?? 55);
const MAX_FILES = 40;
const MIN_FILES = 2;
const MIN_TEXT = 200;

const config = loadConfig({ configPath: "/nonexistent", globalConfigPath: "/nonexistent" } as GantryPaths);

interface GhPr {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  mergeCommit: { oid: string } | null;
  author: { login: string; is_bot: boolean } | null;
}

const gh = (...args: string[]): string =>
  execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const BUMP =
  /^(chore|build|ci|fix)\(deps|\bbump(s|ed)?\b|update (dependency|dependencies)|\bdependabot\b|\brenovate\b/i;
const BOT_LOGIN = /\[bot\]$|^(dependabot|renovate|github-actions|copilot)/i;
const CLOSES =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/|[\w.-]+\/[\w.-]+#|#)(\d+)/i;

const isAncestor = (clone: string, sha: string, of: string): boolean => {
  try {
    git(clone, "merge-base", "--is-ancestor", sha, of);
    return true;
  } catch {
    return false;
  }
};

function indexableFiles(clone: string, base: string, merge: string): number {
  const out = git(clone, "diff", "--name-only", "--no-renames", base, merge);
  return out === "" ? 0 : out.split("\n").filter((p) => isIndexable(p, config)).length;
}

const prs: Pr[] = [];
const report: string[] = [];
for (const repo of corpusRepos()) {
  const clone = historyClone(repo.name);
  if (!existsSync(clone))
    throw new Error(`missing ${clone}: git clone --bare --filter=blob:none ${repo.url} ${clone}`);
  const pinnedDate = git(clone, "log", "-1", "--format=%cI", repo.sha);
  const kept: Pr[] = [];
  const dropped: Record<string, number> = {};
  const drop = (why: string) => {
    dropped[why] = (dropped[why] ?? 0) + 1;
  };
  // Search is not available for every repo (cal.com), so list the newest 600 merged PRs and order them by merge time.
  const batch = (
    JSON.parse(
      gh(
        "pr",
        "list",
        "--repo",
        repo.slug,
        "--state",
        "merged",
        "--base",
        "main",
        "--limit",
        "600",
        "--json",
        "number,title,body,mergedAt,mergeCommit,author",
      ),
    ) as GhPr[]
  )
    .filter((p) => p.mergedAt <= pinnedDate)
    .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
  for (const p of batch) {
    if (kept.length >= PER_REPO) break;
    if (kept.some((k) => k.number === p.number)) continue;
    const merge = p.mergeCommit?.oid;
    if (!merge || !isAncestor(clone, merge, repo.sha)) {
      drop("not before the pinned SHA");
      continue;
    }
    if (!p.author || p.author.is_bot || BOT_LOGIN.test(p.author.login)) {
      drop("bot author");
      continue;
    }
    if (BUMP.test(p.title)) {
      drop("dependency bump");
      continue;
    }
    let base: string;
    try {
      base = git(clone, "rev-parse", `${merge}^1`);
    } catch {
      drop("no parent");
      continue;
    }
    const n = indexableFiles(clone, base, merge);
    if (n < MIN_FILES || n > MAX_FILES) {
      drop(`${n < MIN_FILES ? "under 2" : "over 40"} indexable files`);
      continue;
    }
    const text: PlanText = { title: p.title, body: p.body ?? "", issueBody: "" };
    if (text.body.trim().length < MIN_TEXT) {
      const m = CLOSES.exec(text.body);
      if (m) {
        try {
          text.issueBody =
            (JSON.parse(gh("api", `repos/${repo.slug}/issues/${m[1]}`)) as { body?: string }).body ?? "";
        } catch {
          text.issueBody = "";
        }
      }
      if (`${text.body.trim()}${text.issueBody.trim()}`.length < MIN_TEXT) {
        drop("description under 200 characters");
        continue;
      }
    }
    kept.push({ repo: repo.name, number: p.number, base, merge });
    const f = planCacheFile({ repo: repo.name, number: p.number });
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(text));
  }
  prs.push(...kept);
  report.push(`${repo.name}: kept ${kept.length}; dropped ${JSON.stringify(dropped)}`);
}

prs.sort((a, b) => (a.repo === b.repo ? b.number - a.number : a.repo < b.repo ? -1 : 1));
writeFileSync(join(here, "prs.json"), stable(prs));
const order = seededShuffle(prs.map(prKey), 1);
writeFileSync(join(here, "subset.json"), stable(order.slice(0, 20)));
writeFileSync(join(here, "pilot.json"), stable(order.slice(0, 10)));
console.log(report.join("\n"));
console.log(`prs.json: ${prs.length}`);
