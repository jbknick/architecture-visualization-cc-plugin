import { spawnSync } from "node:child_process";
import {
  buildChangeSet,
  buildMainSnapshotChecked,
  ensureDataDir,
  GantryError,
  type GantryPaths,
  loadConfig,
  openStore,
  rebuildIndex,
  resetStaleStore,
  resolveTeamTarget,
  snapshotRecords,
  changeSetRecords as teamChangeSetRecords,
  teamClient,
} from "@gantry/core";
import {
  CloseRequestSchema,
  changeSetIdForPr,
  DescriptionsRequestSchema,
  type PartLimits,
  type PartRecord,
  splitIntoParts,
  type UploadStart,
  UploadStartSchema,
} from "@gantry/protocol";
import type { Command } from "commander";
import { EXIT_ERROR, EXIT_OK, fail, resolveCliPaths, writeStdout } from "./shared.js";

// `gantry upload` is the only command that sends an index to a team server. It sends what the payload builders
// return (`core/src/team/upload.ts`), cut into parts and serialised by the two functions below, and nothing else.
// No hook imports this file (a test checks), so no hook ever waits on the network.

const EXIT_USAGE = 2;
const POLL_MS = 2000;
const MAX_IN_FLIGHT = 4;
const MAX_RETRIES = 3;
/** One part is at most about a megabyte; a slow link gets longer than the 5 s of a small request. */
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_S = 600;
const SHA_RE = /^[0-9a-f]{40}$/;

export type BodyKind = "main" | "change_set" | "close" | "descriptions";

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
};

/**
 * The one place a JSON request body is written: the payload is checked with the request schema of its route, then
 * serialised compactly with the keys sorted alphabetically at every depth. The begin request (`main`, `change_set`),
 * the close request and the description upload all go through it, so the bytes a dry run shows are the bytes sent.
 */
export function serialiseBody(kind: BodyKind, payload: unknown): string {
  if (kind === "close") return JSON.stringify(sortKeys(CloseRequestSchema.parse(payload)));
  if (kind === "descriptions") return JSON.stringify(sortKeys(DescriptionsRequestSchema.parse(payload)));
  const start = UploadStartSchema.parse(payload);
  if (start.kind !== kind) throw new Error(`serialiseBody: a ${start.kind} request is not a ${kind} body`);
  return JSON.stringify(sortKeys(start));
}

/** The begin request for a list of records: the counts per kind, and the commit for a main snapshot. */
export function uploadStart(records: readonly PartRecord[], sha?: string): UploadStart {
  if (records[0]?.t === "c") {
    return {
      kind: "change_set",
      counts: {
        nodes: records.filter((r) => r.t === "n").length,
        radius: records.filter((r) => r.t === "r").length,
      },
    };
  }
  if (sha === undefined) throw new Error("a main snapshot needs the sha of the commit it was built from");
  const count = (tag: PartRecord["t"]): number => records.filter((r) => r.t === tag).length;
  return {
    kind: "main",
    sha,
    counts: {
      workspaces: count("w"),
      files: count("f"),
      symbols: count("s"),
      edges: count("e"),
      adapter_nodes: count("a"),
    },
  };
}

/**
 * The begin request and the gzipped parts of an upload, cut to the limits the server's begin response gave (by
 * records and by bytes, each part its own gzip). The sender, the dry run and the guard call this one function.
 */
export function buildUploadParts(
  records: readonly PartRecord[],
  limits: PartLimits,
  sha?: string,
): { start: UploadStart; parts: Uint8Array[] } {
  return { start: uploadStart(records, sha), parts: splitIntoParts(records, limits) };
}

/** Everything the command needs from outside, so a test runs it against the fake server with no process. */
export interface UploadContext {
  paths: GantryPaths;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface UploadOptions {
  pr?: string;
  base?: string;
  head?: string;
  owner?: string;
  headRef?: string;
  baseBranch?: string;
  title?: string;
  createdAt?: string;
  close?: boolean;
  merged?: boolean;
  forceMain?: boolean;
  timeout?: string;
  json?: boolean;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A non-empty option, or the environment variable of the same meaning, or undefined. */
function pick(value: string | undefined, env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (value !== undefined && value !== "") return value;
  const fromEnv = env[name];
  return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
}

function git(root: string, args: string[]): string | undefined {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const text = r.status === 0 ? r.stdout.trim() : "";
  return text === "" ? undefined : text;
}

/** Whether the checkout is on the repo's default branch (the one `origin/HEAD` names), or why that is not known. */
function branchState(root: string): "default" | "other" | "unknown" {
  const remoteHead = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const current = git(root, ["symbolic-ref", "--short", "HEAD"]);
  if (remoteHead === undefined || current === undefined) return "unknown";
  const defaultBranch = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
  return current === defaultBranch ? "default" : "other";
}

const seconds = (ms: number): number => Math.round(ms / 100) / 10;

/** The line a failed request prints; it names the `GantryError` code and never holds the token. */
function describeFailure(err: GantryError): string {
  if (err.answer?.error === "budget") return "Daily upload budget used; try again later.";
  if (err.code === "team_unauthorized") {
    return "team_unauthorized: The server did not accept the token. Run gantry team login.";
  }
  return `${err.code}: ${err.message}`;
}

/** A part answered 5xx, or not at all, is sent again; everything else the server said is final. */
function retriable(err: unknown): boolean {
  if (!(err instanceof GantryError)) return false;
  return (
    err.code === "team_unreachable" || (err.code === "team_rejected" && (err.answer?.status ?? 0) >= 500)
  );
}

export async function runUpload(ctx: UploadContext, opts: UploadOptions): Promise<number> {
  const usage = (message: string): number => {
    ctx.err(`${message}\n`);
    return EXIT_USAGE;
  };

  // 1. Usage: nothing below runs on a bad command line.
  let pr: number | undefined;
  if (opts.pr !== undefined) {
    if (!/^[1-9]\d{0,8}$/.test(opts.pr)) return usage("--pr must be a pull request number");
    pr = Number(opts.pr);
  }
  const timeoutS = opts.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(opts.timeout);
  if (!(timeoutS > 0) || !Number.isFinite(timeoutS))
    return usage("--timeout must be a number of seconds above 0");
  if (opts.merged === true && opts.close !== true) return usage("--merged only applies to --close");
  if (opts.close === true && (pr === undefined || (opts.head ?? "") === "")) {
    return usage("--close needs --pr and --head");
  }
  const owner = pick(opts.owner, ctx.env, "GANTRY_PR_OWNER");
  const headRef = pick(opts.headRef, ctx.env, "GANTRY_PR_HEAD_REF");
  const baseBranch = pick(opts.baseBranch, ctx.env, "GANTRY_PR_BASE_BRANCH");
  const base = opts.base === "" ? undefined : opts.base;
  const head = opts.head === "" ? undefined : opts.head;
  if (opts.close !== true && pr !== undefined) {
    if (
      base === undefined ||
      head === undefined ||
      owner === undefined ||
      headRef === undefined ||
      baseBranch === undefined
    ) {
      return usage("--pr needs --base, --head, --owner, --head-ref and --base-branch");
    }
  }

  // 2. Who we talk to. With no server and organisation nothing is sent and nothing is read from the repo.
  const config = loadConfig(ctx.paths);
  const target = resolveTeamTarget(ctx.paths, config, ctx.env);
  if (target === null) {
    ctx.out("No team configured; nothing uploaded.\n");
    return EXIT_OK;
  }
  const token = target.token;
  if (token === null) {
    ctx.err("No token. Set GANTRY_TOKEN, or run gantry team login.\n");
    return EXIT_ERROR;
  }
  const scrub = (text: string): string => text.split(token).join("***");

  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? sleepFor;
  const progress = (text: string): void => {
    if (opts.json !== true) ctx.out(`${text}\n`);
  };
  const repo = ctx.paths.repo;
  // The clock for "done in" and --timeout: it restarts just before the begin request, so local work is not counted.
  let started = now();
  const kind: "main" | "change_set" | "close" =
    opts.close === true ? "close" : pr === undefined ? "main" : "change_set";
  let emitted = false;
  const result = (status: string, uploadId?: string, error?: string): void => {
    if (opts.json !== true || emitted) return;
    emitted = true;
    const body = {
      kind,
      status,
      ...(uploadId === undefined ? {} : { upload_id: uploadId }),
      ...(error === undefined ? {} : { error }),
      seconds: seconds(now() - started),
    };
    ctx.out(`${JSON.stringify(body)}\n`);
  };

  try {
    const client = teamClient(ctx.paths, target.config, {
      env: ctx.env,
      server: target.server,
      org: target.org,
      token,
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
    });

    // 3. A close sends no graph.
    if (opts.close === true) {
      const n = pr as number;
      const sha = resolveSha(ctx.paths.root, head as string);
      if (sha === undefined)
        return usage(`--head ${head} is not a commit here; pass its full 40-character sha`);
      const answer = await client.closeChangeSet(
        repo,
        changeSetIdForPr(repo, n),
        serialiseBody("close", { head_sha: sha, merged: opts.merged === true }),
      );
      if (answer.closed) {
        result("closed");
        progress(`Closed ${repo}#${n} (${opts.merged === true ? "merged" : "not merged"}).`);
      } else {
        result("done");
        progress(`Nothing to close for ${repo}#${n}.`);
      }
      return EXIT_OK;
    }

    // 4. A main snapshot only from the default branch.
    if (pr === undefined && opts.forceMain !== true) {
      const state = branchState(ctx.paths.root);
      if (state === "unknown") {
        ctx.err(
          "Cannot tell whether this is the default branch. Pass --force-main to upload this checkout as main.\n",
        );
        return EXIT_ERROR;
      }
      if (state === "other") {
        ctx.err("Not on the default branch. Pass --force-main to upload this checkout as main.\n");
        return EXIT_ERROR;
      }
    }

    // 5. The payload: from the index, by the builders, nothing else.
    resetStaleStore(ctx.paths);
    ensureDataDir(ctx.paths);
    await rebuildIndex(ctx.paths);
    const store = openStore(ctx.paths.dbPath, { overlayPath: ctx.paths.overlayPath, repo });
    let records: PartRecord[];
    let warnings: string[];
    let sha: string | undefined;
    let targetId: string;
    let announce: string;
    try {
      if (pr === undefined) {
        const built = buildMainSnapshotChecked(store, ctx.paths);
        records = snapshotRecords(built.snapshot);
        warnings = built.warnings;
        sha = built.snapshot.sha;
        targetId = "main";
        announce = `Uploading main snapshot for ${repo} (${sha.slice(0, 7)})...`;
      } else {
        const title = pick(opts.title, ctx.env, "GANTRY_PR_TITLE");
        const createdAt = pick(opts.createdAt, ctx.env, "GANTRY_PR_CREATED_AT");
        const built = await buildChangeSet(store, ctx.paths, {
          base: base as string,
          head: head as string,
          pr,
          owner: owner as string,
          head_ref: headRef as string,
          base_branch: baseBranch as string,
          ...(title === undefined ? {} : { title }),
          ...(createdAt === undefined ? {} : { created_at: createdAt }),
        });
        records = teamChangeSetRecords(built.changeSet);
        warnings = built.warnings;
        targetId = built.changeSet.id;
        announce = `Uploading change set for ${repo}#${pr}...`;
      }
    } finally {
      store.close();
    }
    for (const w of new Set(warnings)) ctx.err(`${w}\n`);

    // 6. Begin, send the parts, poll.
    progress(announce);
    started = now();
    const begun = await client.beginUpload(repo, serialiseBody(kind, uploadStart(records, sha)), targetId);
    const { parts } = buildUploadParts(records, begun, sha);
    if (parts.length === 0) {
      ctx.err("Nothing to upload.\n");
      return EXIT_ERROR;
    }
    if (parts.length > begun.max_parts) {
      ctx.err(`The upload needs ${parts.length} parts; the server takes at most ${begun.max_parts}.\n`);
      return EXIT_ERROR;
    }
    await sendParts(client, begun.upload_id, parts, sleep);

    let last = "";
    for (;;) {
      const status = await client.uploadStatus(begun.upload_id);
      if (status.status === "done" || status.status === "superseded") {
        result(status.status, begun.upload_id);
        const took = seconds(now() - started);
        progress(
          status.status === "done"
            ? `done in ${took.toFixed(1)} s`
            : `superseded by a newer upload after ${took.toFixed(1)} s`,
        );
        return EXIT_OK;
      }
      if (status.status === "failed") {
        result("failed", begun.upload_id, scrub(status.error ?? "the server gave no reason"));
        ctx.err(`gantry: upload failed: ${scrub(status.error ?? "the server gave no reason")}\n`);
        return EXIT_ERROR;
      }
      if (status.status !== last) {
        last = status.status;
        progress(status.status);
      }
      if (now() - started >= timeoutS * 1000) {
        result("failed", begun.upload_id);
        ctx.err(`gantry: timed out after ${timeoutS} s; the server had not finished the upload.\n`);
        return EXIT_ERROR;
      }
      await sleep(POLL_MS);
    }
  } catch (err) {
    const line =
      err instanceof GantryError
        ? scrub(describeFailure(err))
        : `gantry: ${scrub(err instanceof Error ? err.message : String(err))}`;
    result("failed", undefined, line.replace(/^gantry: /, ""));
    ctx.err(`${line}\n`);
    return EXIT_ERROR;
  }
}

/** A 40-character sha as given, or the commit a ref names here. */
function resolveSha(root: string, ref: string): string | undefined {
  if (SHA_RE.test(ref)) return ref;
  const sha = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return sha !== undefined && SHA_RE.test(sha) ? sha : undefined;
}

/** Sends every part, at most 4 at a time; a part answered 5xx or not at all is sent again up to 3 times. */
async function sendParts(
  client: ReturnType<typeof teamClient>,
  uploadId: string,
  parts: readonly Uint8Array[],
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown;
  const sendOne = async (index: number): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await client.putPart(uploadId, index + 1, parts[index] as Uint8Array, parts.length);
        return;
      } catch (err) {
        if (!retriable(err) || attempt >= MAX_RETRIES) throw err;
        await sleep(250 * (attempt + 1));
      }
    }
  };
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = next;
      next += 1;
      if (index >= parts.length) return;
      try {
        await sendOne(index);
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, parts.length) }, worker));
  if (failure !== undefined) throw failure;
}

export function registerUpload(program: Command): void {
  program
    .command("upload")
    .description(
      "Send the graph of main, or a pull request's change set, to the team server; --close tells it the pull request is closed",
    )
    .option("--pr <n>", "upload the change set of this pull request")
    .option("--base <sha>", "the pull request's base commit")
    .option("--head <sha>", "the pull request's head commit")
    .option("--owner <login>", "the pull request's author (env GANTRY_PR_OWNER)")
    .option("--head-ref <name>", "the pull request's head branch (env GANTRY_PR_HEAD_REF)")
    .option("--base-branch <name>", "the branch it targets (env GANTRY_PR_BASE_BRANCH)")
    .option("--title <text>", "the pull request's title (env GANTRY_PR_TITLE)")
    .option("--created-at <iso>", "when the pull request was opened (env GANTRY_PR_CREATED_AT)")
    .option("--close", "tell the server the pull request is closed (needs --pr and --head)")
    .option("--merged", "with --close: the pull request was merged")
    .option("--force-main", "upload this checkout as main even when it is not on the default branch")
    .option("--timeout <s>", `seconds to wait for the server to finish (default ${DEFAULT_TIMEOUT_S})`)
    .option("--json", "print one JSON object instead of lines")
    .exitOverride((err) => process.exit(err.exitCode === 0 ? 0 : EXIT_USAGE))
    .action(async (opts: UploadOptions) => {
      try {
        process.exitCode = await runUpload(
          {
            paths: resolveCliPaths({}),
            env: process.env,
            out: writeStdout,
            err: (text) => process.stderr.write(text),
          },
          opts,
        );
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
