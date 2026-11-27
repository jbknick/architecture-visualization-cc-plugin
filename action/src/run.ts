// The Action's script (issue #282), bundled into the release tarball as dist/action.js. It runs after the install and
// index steps of action.yml: it asks the installed CLI for the review and the duplicates of the pull request, builds
// the comment and posts it. No model calls. It fails open: a Gantry error (a failed install, index, embed or review,
// or a review that is not JSON) is logged as a warning and the comment says that the analysis failed and why; a comment
// that cannot be posted never fails the job either, the body goes to the job summary instead. Only a misconfigured
// workflow (no base and head to review) fails the job.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  buildComment,
  buildFailureComment,
  type CommentInput,
  type CrossingFinding,
  type DuplicatesJson,
  type ReviewJson,
} from "./comment.js";
import { type CommentResult, GithubComments } from "./github.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** `env` replaces the child's whole environment; without it the child inherits this process's. */
export type Exec = (
  file: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<ExecResult>;

/** Runs a program and collects its output; a program that cannot start is a result with code 127, not a throw. */
export const defaultExec: Exec = (file, args, cwd, env) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => resolve({ code: 127, stdout: "", stderr: String(e.message) }));
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });

export interface RunDeps {
  exec?: Exec;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Where log lines go (workflow commands such as `::notice::` are lines of stdout). */
  log?: (line: string) => void;
  /** Milliseconds clock for the timings in the log. */
  now?: () => number;
  cwd?: string;
}

export interface RunResult {
  /** `created` or `updated` when a comment was posted, `summary` when the body went to the job summary. */
  comment: "created" | "updated" | "summary";
  url: string;
  body: string;
  /** Why no comment was posted, when `comment` is `summary`. */
  reason?: string;
}

interface PullRequestPayload {
  number?: number;
  base?: { sha?: string; repo?: { full_name?: string } | null };
  head?: { sha?: string; repo?: { full_name?: string } | null };
}
interface EventPayload {
  pull_request?: PullRequestPayload;
  number?: number;
}

const PR_RE = /^[1-9]\d{0,8}$/;

function readEvent(path: string | undefined): EventPayload {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EventPayload;
  } catch {
    return {};
  }
}

/** A pull request whose head lives in another repository (or in a deleted one) is a fork's. */
export function isForkPullRequest(pr: PullRequestPayload | undefined): boolean {
  if (!pr) return false;
  const head = pr.head?.repo?.full_name;
  const base = pr.base?.repo?.full_name;
  return head === undefined || base === undefined || head.toLowerCase() !== base.toLowerCase();
}

/**
 * The crossings that `gantry team boundaries --json` printed, or why they cannot be used. The text comes from the
 * team's groups and the repository, so each field is checked to be a string or a number before the comment sees it.
 */
function parseTeamBoundaries(text: string): NonNullable<CommentInput["teamBoundaries"]> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the answer was not JSON");
  }
  const list = (raw as { crossings?: unknown } | null)?.crossings;
  if (!Array.isArray(list)) throw new Error("the answer has no crossings");
  const strings = ["srcName", "srcPath", "srcGroup", "dstName", "dstPath", "dstGroup"] as const;
  const crossings = list.filter(
    (f): f is CrossingFinding =>
      typeof f === "object" &&
      f !== null &&
      strings.every((k) => typeof (f as Record<string, unknown>)[k] === "string") &&
      typeof (f as Record<string, unknown>).srcLine === "number" &&
      typeof (f as Record<string, unknown>).dstLine === "number",
  );
  return { crossings, total: crossings.length };
}

function failure(what: string, r: ExecResult): Error {
  const detail = r.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  return new Error(`${what} failed (exit ${r.code})${detail ? `: ${detail}` : ""}`);
}

/** Writes `text` to a file named by an environment variable of the Actions runtime (summary, outputs). */
function append(path: string | undefined, text: string): void {
  if (path) appendFileSync(path, text);
}

export async function run(env: NodeJS.ProcessEnv, deps: RunDeps = {}): Promise<RunResult> {
  const exec = deps.exec ?? defaultExec;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  const cwd = deps.cwd ?? process.cwd();
  const gantryBin = env.GANTRY_BIN;
  if (!gantryBin) throw new Error("GANTRY_BIN is not set: the install step of action.yml sets it");
  const gantry: string = gantryBin;

  const event = readEvent(env.GITHUB_EVENT_PATH);
  const pr = event.pull_request;
  const prNumber = pr?.number ?? event.number;
  const baseRef = env.GANTRY_BASE || pr?.base?.sha;
  const headRef = env.GANTRY_HEAD || pr?.head?.sha;
  if (!baseRef || !headRef) {
    throw new Error(
      "no base and head to review: run on a pull_request event, or set the base and head inputs",
    );
  }
  const base: string = baseRef;
  const head: string = headRef;

  // Every child but the team one starts with the step's environment minus the team values, so the team token only
  // ever reaches the one child that talks to the team server.
  const plainEnv: NodeJS.ProcessEnv = { ...env };
  for (const k of ["GANTRY_TEAM_SERVER", "GANTRY_TEAM_ORG", "GANTRY_TEAM_TOKEN"]) delete plainEnv[k];

  const timed = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
    const t0 = now();
    try {
      return await f();
    } finally {
      log(`gantry-action: ${label} took ${now() - t0} ms`);
    }
  };

  let body: string;
  try {
    const earlier = (env.GANTRY_FAILURE ?? "").trim();
    // An earlier step of action.yml (install, index, embed) already failed and said why.
    if (earlier !== "") throw new Error(earlier);
    body = await analyse();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `::warning title=Gantry::The analysis failed, the comment says so: ${reason.replace(/[\r\n]+/g, " ")}`,
    );
    body = buildFailureComment(reason);
  }

  async function analyse(): Promise<string> {
    const reviewRun = await timed("review", () =>
      exec(gantry, ["review", `${base}...${head}`, "--json"], cwd, plainEnv),
    );
    if (reviewRun.code !== 0) throw failure("gantry review", reviewRun);
    let review: ReviewJson;
    try {
      review = JSON.parse(reviewRun.stdout) as ReviewJson;
    } catch {
      throw new Error("gantry review did not print JSON");
    }

    let duplicates: DuplicatesJson | null = null;
    let duplicatesError: string | undefined;
    const dupRun = await timed("duplicates", () =>
      exec(gantry, ["duplicates", "--since", base, "--json"], cwd, plainEnv),
    );
    if (dupRun.code !== 0) {
      duplicatesError = failure("gantry duplicates", dupRun).message;
    } else {
      try {
        duplicates = JSON.parse(dupRun.stdout) as DuplicatesJson;
      } catch {
        duplicatesError = "gantry duplicates did not print JSON";
      }
    }
    if (duplicatesError !== undefined) {
      log(`::warning title=Gantry::${duplicatesError.replace(/[\r\n]+/g, " ")}`);
    }

    // Team boundaries: only with the three team values and never for a fork (it has no secrets, and its code is not
    // the team's). The team token goes to the child as GANTRY_TOKEN, the name `gantry` reads; the GitHub token is
    // never in that environment and the team token is never given to the comment client below.
    let teamBoundaries: CommentInput["teamBoundaries"];
    const teamServer = env.GANTRY_TEAM_SERVER ?? "";
    const teamOrg = env.GANTRY_TEAM_ORG ?? "";
    const teamToken = env.GANTRY_TEAM_TOKEN ?? "";
    if (teamServer !== "" && teamOrg !== "" && teamToken !== "" && !isForkPullRequest(pr)) {
      const childEnv: NodeJS.ProcessEnv = { ...plainEnv };
      childEnv.GANTRY_SERVER = teamServer;
      childEnv.GANTRY_ORG = teamOrg;
      childEnv.GANTRY_TOKEN = teamToken;
      try {
        const teamRun = await timed("team boundaries", () =>
          exec(gantry, ["team", "boundaries", "--base", base, "--head", head, "--json"], cwd, childEnv),
        );
        if (teamRun.code !== 0) throw failure("gantry team boundaries", teamRun);
        teamBoundaries = parseTeamBoundaries(teamRun.stdout);
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err))
          .split(teamToken)
          .join("***")
          .replace(/[\r\n]+/g, " ")
          .slice(0, 300);
        log(`::warning title=Gantry::team boundaries unavailable: ${reason}`);
      }
    }

    // The recipe of the head commit decides whether the radius is structural only (read from git, never from disk).
    const recipe = await exec("git", ["cat-file", "-e", `${head}:.gantry/recipe.json`], cwd, plainEnv);
    return buildComment({
      review,
      duplicates,
      duplicatesError,
      hasRecipe: recipe.code === 0,
      embed: /^(1|true|yes)$/i.test(env.GANTRY_EMBED ?? ""),
      version: env.GANTRY_VERSION,
      teamBoundaries,
    });
  }

  let result: CommentResult;
  if (prNumber === undefined || !PR_RE.test(String(prNumber))) {
    result = { action: "skipped", reason: "this run is not for a pull request" };
  } else if (isForkPullRequest(pr)) {
    result = { action: "skipped", reason: "pull request from a fork: its token cannot comment" };
  } else if (!env.GANTRY_TOKEN || !env.GITHUB_REPOSITORY) {
    result = { action: "skipped", reason: "no github-token or repository to comment with" };
  } else {
    const client = new GithubComments(
      {
        apiUrl: env.GITHUB_API_URL || "https://api.github.com",
        token: env.GANTRY_TOKEN,
        repo: env.GITHUB_REPOSITORY,
        pr: prNumber,
      },
      { fetch: deps.fetch, sleep: deps.sleep },
    );
    result = await timed("comment", () => client.upsert(body));
  }

  let out: RunResult;
  if (result.action === "skipped") {
    log(`::notice title=Gantry::No comment posted (${result.reason}). The review is in the job summary.`);
    append(env.GITHUB_STEP_SUMMARY, `${body}\n`);
    out = { comment: "summary", url: "", body, reason: result.reason };
  } else {
    log(`gantry-action: comment ${result.action} (${result.url})`);
    out = { comment: result.action, url: result.url, body };
  }
  append(env.GITHUB_OUTPUT, `comment=${out.comment}\ncomment-url=${out.url}\n`);
  return out;
}
