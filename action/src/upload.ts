// The upload step of the Action. It runs after the index and the comment steps of action.yml and sends what a team
// server needs: the graph of the default branch after a push, a pull request's change set on its events, a close call
// when the pull request closes. It decides from the event values in the environment, runs the installed CLI
// (`gantry upload`) and nothing else. A pull request from a fork uploads nothing. It fails open: an upload that does not
// work is one warning line, never a failed job. The team token is only ever passed to the CLI through the child's
// environment; it is never part of an argument or of a log line.
import { spawn } from "node:child_process";
import type { ExecResult } from "./run.js";

/** Like `Exec` in run.ts, with the environment of the child: the CLI reads the team settings from it. */
export type UploadExec = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Promise<ExecResult>;

export interface UploadDeps {
  exec?: UploadExec;
  log?: (line: string) => void;
  cwd?: string;
}

/** Runs a program with this environment; a program that cannot start is a result with code 127, not a throw. */
export const defaultUploadExec: UploadExec = (file, args, cwd, env) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

const PR_RE = /^[1-9]\d{0,8}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface UploadResult {
  /** What happened: the CLI ran and exited 0, nothing was sent on purpose, or the upload failed (one warning). */
  outcome: "uploaded" | "skipped" | "failed";
}

/** The environment names the CLI reads its settings from; the child gets them on top of the step's environment. */
const CHILD_NAMES = [
  "GANTRY_SERVER",
  "GANTRY_ORG",
  "GANTRY_TOKEN",
  "GANTRY_PR_OWNER",
  "GANTRY_PR_TITLE",
  "GANTRY_PR_HEAD_REF",
  "GANTRY_PR_BASE_BRANCH",
  "GANTRY_PR_CREATED_AT",
] as const;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export async function runUpload(env: NodeJS.ProcessEnv, deps: UploadDeps = {}): Promise<UploadResult> {
  const exec = deps.exec ?? defaultUploadExec;
  const log = deps.log ?? ((line: string) => console.log(line));
  const cwd = deps.cwd ?? process.cwd();
  const token = env.GANTRY_TOKEN ?? "";
  const scrub = (text: string): string => (token === "" ? text : text.split(token).join("***"));
  const say = (line: string): void => log(scrub(line));
  const val = (name: string): string => (env[name] ?? "").trim();
  const warn = (reason: string): UploadResult => {
    say(`::warning title=Gantry::upload failed: ${oneLine(reason)}`);
    return { outcome: "failed" };
  };

  try {
    const event = val("GANTRY_EVENT");
    const action = val("GANTRY_EVENT_ACTION");
    const skip = (line: string): UploadResult => {
      say(line);
      return { outcome: "skipped" };
    };

    let args: string[];
    if (event === "pull_request") {
      // 1. A pull request from another repository (or from a deleted one) never uploads.
      const headRepo = val("GANTRY_HEAD_REPO").toLowerCase();
      if (headRepo === "" || headRepo !== val("GITHUB_REPOSITORY").toLowerCase()) {
        return skip("fork: upload skipped");
      }
      const number = val("GANTRY_PR");
      const head = val("GANTRY_PR_HEAD_SHA");
      if (action === "closed") {
        // 4. A close needs no index, so the failed index does not stop it.
        if (!PR_RE.test(number) || !SHA_RE.test(head)) {
          return warn("the event has no pull request number and head commit");
        }
        args = ["upload", "--pr", number, "--head", head, "--close"];
        if (val("GANTRY_PR_MERGED") === "true") args.push("--merged");
      } else if (action === "opened" || action === "synchronize" || action === "reopened") {
        // 3.
        if (val("GANTRY_INDEX_FAILED") !== "") return skip("upload skipped: the index failed");
        const base = val("GANTRY_PR_BASE_SHA");
        if (!PR_RE.test(number) || !SHA_RE.test(base) || !SHA_RE.test(head)) {
          return warn("the event has no pull request number, base commit and head commit");
        }
        args = ["upload", "--pr", number, "--base", base, "--head", head];
      } else {
        return skip(`upload skipped: pull request action ${action} does not upload`);
      }
    } else if (event === "push") {
      // 2. Only the default branch; origin/HEAD is usually unset in CI, so the Action checks from the event.
      const branch = val("GANTRY_REF_NAME");
      const def = val("GANTRY_DEFAULT_BRANCH");
      if (branch === "" || branch !== def || !val("GITHUB_REF").startsWith("refs/heads/")) {
        return skip(`upload skipped: push to ${branch} is not the default branch (${def})`);
      }
      if (val("GANTRY_INDEX_FAILED") !== "") return skip("upload skipped: the index failed");
      args = ["upload", "--force-main"];
    } else {
      // 5.
      return skip(`upload skipped: event ${event} does not upload`);
    }

    const home = val("GANTRY_HOME");
    if (home === "") return warn("GANTRY_HOME is not set");
    const childEnv: NodeJS.ProcessEnv = { ...env };
    for (const name of CHILD_NAMES) if (env[name] !== undefined) childEnv[name] = env[name];
    const r = await exec(`${home}/bin/gantry`, args, cwd, childEnv);
    for (const line of r.stdout.split("\n")) if (line.trim() !== "") say(`gantry-upload: ${line.trim()}`);
    if (r.code === 0) return { outcome: "uploaded" };
    const lines = r.stderr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    return warn(scrub(lines[lines.length - 1] ?? `gantry upload exited with code ${r.code}`));
  } catch (err) {
    return warn(scrub(err instanceof Error ? err.message : String(err)));
  }
}
