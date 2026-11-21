// Shared helpers of the plan-estimates spike (#304): paths, the corpus files, the seeded shuffle and the
// summary statistics. No model calls here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
export const cliPath = join(repoRoot, "plugin/dist/cli.js");
export const mcpPath = join(repoRoot, "plugin/dist/mcp.js");

/** Where the spike keeps its history clones, worktrees and data dirs (outside this repository). */
export const workDir = process.env.GANTRY_PE_DIR || join(homedir(), "Dev", "gantry-oss", "plan-estimates");
/** Git-ignored: plan text fetched with `gh` (never committed). */
export const cacheDir = join(repoRoot, "evals/oss/cache/plan-estimates");

export interface Pr {
  repo: string;
  number: number;
  base: string;
  merge: string;
}
export const prKey = (p: { repo: string; number: number }): string => `${p.repo}#${p.number}`;

export interface RepoEntry {
  name: string;
  url: string;
  sha: string;
}

/** The corpus repositories (names as in evals/oss/repos.json, GitHub slug from the URL). */
export const CORPUS = ["formbricks", "cal.com"] as const;

export function corpusRepos(): (RepoEntry & { slug: string })[] {
  const all = (
    JSON.parse(readFileSync(join(repoRoot, "evals/oss/repos.json"), "utf8")) as { repos: RepoEntry[] }
  ).repos;
  return CORPUS.map((n) => {
    const r = all.find((x) => x.name === n);
    if (!r) throw new Error(`${n} is not in evals/oss/repos.json`);
    const slug = r.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    return { ...r, slug };
  });
}

/** The bare, blob-less history clone of a corpus repo (`git clone --bare --filter=blob:none <url>`). */
export const historyClone = (name: string): string => join(workDir, `${name}.git`);

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "core.quotepath=off", "-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
export const loadPrs = (): Pr[] => readJson<Pr[]>(join(here, "prs.json"));
export const loadKeys = (name: "subset" | "pilot"): string[] =>
  readJson<string[]>(join(here, `${name}.json`));

export interface PlanText {
  title: string;
  body: string;
  /** The body of the issue the PR closes, when the PR body itself is shorter than 200 characters. */
  issueBody: string;
}
export const planCacheFile = (p: { repo: string; number: number }): string =>
  join(cacheDir, p.repo, `${p.number}.json`);

/** The plan: title and PR description; the linked issue body only stands in for a description under 200 characters. */
export function planText(t: PlanText): string {
  const text =
    t.body.trim().length >= 200 ? t.body.trim() : `${t.body.trim()}\n\n${t.issueBody.trim()}`.trim();
  return `${t.title.trim()}\n\n${text}`.trim();
}

export const loadPlan = (p: { repo: string; number: number }): PlanText => {
  const f = planCacheFile(p);
  if (!existsSync(f)) throw new Error(`no cached plan text for ${prKey(p)}: run select.ts first`);
  return readJson<PlanText>(f);
};

/** mulberry32: a small seeded generator, so the shuffle is the same everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy, seeded. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Linear-interpolated quantile of a list (q in 0..1); NaN for an empty list. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}
export const median = (xs: readonly number[]): number => quantile(xs, 0.5);
export const round4 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : x);

export const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v;
export const stable = (v: unknown): string => `${JSON.stringify(sortKeys(v), null, 2)}\n`;
