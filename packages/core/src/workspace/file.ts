import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { repoName } from "../paths/repo-name.js";

/** The name of the file that lists the repos of one Gantry project (spec section 4). */
export const WORKSPACE_FILE = "gantry-workspace.json";

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^[^/]+@[^:]+:/;

/** True for a value that names a remote repository (`https://...`, `git@host:owner/name`), not a local path. */
export function looksLikeUrl(value: string): boolean {
  return URL_SCHEME.test(value) || SCP_LIKE.test(value);
}

export const WorkspaceFileSchema = z
  .object({
    repos: z
      .array(
        z
          .object({
            path: z.string().min(1),
            repo: z
              .string()
              .min(1)
              .refine((s) => !s.includes(":"), { message: "must not contain ':'" })
              .optional(),
          })
          .strict(),
      )
      .min(1, { message: "must list at least one repo" }),
  })
  .strict();

export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/** A problem with a workspace file: unreadable, invalid, or naming something that is not a local git work tree root. */
export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export interface WorkspaceRepo {
  name: string;
  /** Real path of the repo's work tree root. */
  root: string;
}

export interface LoadedWorkspace {
  /** The workspace file as given (absolute). */
  file: string;
  /** Real path of the directory that holds the file; the data dir is keyed by it. */
  dir: string;
  /** Sorted by name. */
  repos: WorkspaceRepo[];
}

function gitTopLevel(dir: string): string | undefined {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.error || res.status !== 0) return undefined;
  const top = res.stdout.trim();
  return top === "" ? undefined : top;
}

const realOrUndefined = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * Reads and checks a workspace file (spec section 4). Every path is relative to the file's directory or absolute;
 * a URL is rejected, each path must be the root of a git work tree, and repo names (the `repo` override, else the
 * name `repoName` derives) must be unique, as must the repos themselves. Throws `WorkspaceFileError` with a message
 * that starts `workspace file <file>:`.
 */
export function loadWorkspaceFile(file: string): LoadedWorkspace {
  const abs = path.resolve(file);
  const fail = (msg: string): never => {
    throw new WorkspaceFileError(`workspace file ${abs}: ${msg}`);
  };
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    return fail(`cannot read it: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return fail(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  // URLs get their own message before the schema runs, so the text does not depend on the zod version.
  const rawRepos = (json as { repos?: unknown } | null)?.repos;
  if (Array.isArray(rawRepos)) {
    rawRepos.forEach((r, i) => {
      const p = (r as { path?: unknown } | null)?.path;
      if (typeof p === "string" && looksLikeUrl(p)) {
        fail(`repos[${i}].path must be a local path, not a URL`);
      }
    });
  }
  const parsed = WorkspaceFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.map((s) => (typeof s === "number" ? `[${s}]` : `.${String(s)}`)).join("") ?? "";
    return fail(`${where.replace(/^\./, "") || "file"} ${issue?.message ?? "is invalid"}`);
  }

  const dir = realOrUndefined(path.dirname(abs)) ?? path.dirname(abs);
  const repos: WorkspaceRepo[] = [];
  const byRoot = new Map<string, number>();
  const byName = new Map<string, number>();
  parsed.data.repos.forEach((entry, i) => {
    const given = path.resolve(path.dirname(abs), entry.path);
    const real = realOrUndefined(given);
    const top = real === undefined ? undefined : gitTopLevel(real);
    const topReal = top === undefined ? undefined : realOrUndefined(top);
    if (real === undefined || topReal === undefined || topReal !== real) {
      fail(`repos[${i}].path ${entry.path} is not the root of a git repository`);
    }
    const root = real as string;
    const sameRoot = byRoot.get(root);
    if (sameRoot !== undefined) fail(`repos[${i}].path lists the same repository as repos[${sameRoot}]`);
    const name = entry.repo ?? repoName(root);
    const sameName = byName.get(name);
    if (sameName !== undefined) {
      fail(`repos[${i}] and repos[${sameName}] have the same repo name ${name}; set "repo" on one of them`);
    }
    byRoot.set(root, i);
    byName.set(name, i);
    repos.push({ name, root });
  });
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { file: abs, dir, repos };
}

/**
 * The workspace file that lists `repoRoot` (spec section 4). Walks up from the parent of `startAbove` (default
 * `repoRoot`) to the filesystem root, but not above the user's home directory when the walk passes through it, and
 * takes the `gantry-workspace.json` that lists the repo (each `path` compared by real path). A file that does not list
 * the repo is passed over; with no file that lists it the answer is `undefined`, a workspace of one. A file that is
 * invalid is an error, and so is a repo that two files list (there would be two indexes of it): the message names both
 * files. `startAbove` is the path the user is in, which may reach the repo through a symlink.
 */
export function findWorkspaceFile(
  repoRoot: string,
  opts: { startAbove?: string; home?: string } = {},
): LoadedWorkspace | undefined {
  const real = realOrUndefined(repoRoot) ?? repoRoot;
  const home = realOrUndefined(opts.home ?? os.homedir()) ?? opts.home ?? os.homedir();
  const seen = new Set<string>();
  const found: LoadedWorkspace[] = [];
  const starts = [path.resolve(opts.startAbove ?? repoRoot), real];
  for (const start of starts) {
    let dir = path.dirname(start);
    for (;;) {
      const key = realOrUndefined(dir) ?? dir;
      if (!seen.has(key)) {
        seen.add(key);
        const candidate = path.join(dir, WORKSPACE_FILE);
        if (fs.existsSync(candidate)) {
          const ws = loadWorkspaceFile(candidate);
          if (ws.repos.some((r) => r.root === real)) found.push(ws);
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir || key === home) break;
      dir = parent;
    }
  }
  const first = found[0];
  const second = found[1];
  if (first && second) {
    throw new WorkspaceFileError(
      `workspace file ${first.file}: ${real} is also listed by ${second.file}; keep it in one file, or pass --workspace <file>`,
    );
  }
  return first;
}
