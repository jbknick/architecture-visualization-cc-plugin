// runUpload decides what the upload step sends, from the event values in the environment. A fake `exec` records what
// would run (arguments and environment), so every branch of the decision list is checked with no process and no network.
import { describe, expect, it } from "vitest";
import { runUpload, type UploadExec } from "./upload.js";

const TOKEN = "gct_secret-9f3a1c";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function harness(result: { code?: number; stdout?: string; stderr?: string } | "throw" = {}) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const exec: UploadExec = async (file, args, _cwd, env) => {
    calls.push({ file, args, env });
    if (result === "throw") throw new Error(`cannot start ${file} with ${env.GANTRY_TOKEN}`);
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { calls, lines, deps: { exec, log: (l: string) => lines.push(l), cwd: "/work" } };
}

const base: NodeJS.ProcessEnv = {
  GANTRY_HOME: "/gantry",
  GANTRY_SERVER: "https://team.example.test",
  GANTRY_ORG: "acme",
  GANTRY_TOKEN: TOKEN,
  GITHUB_REPOSITORY: "acme/repo",
};

const push = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...base,
  GANTRY_EVENT: "push",
  GANTRY_EVENT_ACTION: "",
  GANTRY_REF_NAME: "main",
  GANTRY_DEFAULT_BRANCH: "main",
  GITHUB_REF: "refs/heads/main",
  ...over,
});

const pr = (action: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...base,
  GANTRY_EVENT: "pull_request",
  GANTRY_EVENT_ACTION: action,
  GANTRY_PR: "7",
  GANTRY_PR_BASE_SHA: BASE,
  GANTRY_PR_HEAD_SHA: HEAD,
  GANTRY_PR_OWNER: "octocat",
  GANTRY_PR_TITLE: "Fix the slug",
  GANTRY_PR_HEAD_REF: "feat/slug",
  GANTRY_PR_BASE_BRANCH: "main",
  GANTRY_PR_CREATED_AT: "2026-01-01T00:00:00Z",
  GANTRY_HEAD_REPO: "acme/repo",
  ...over,
});

describe("runUpload", () => {
  it("skips a fork: nothing runs", async () => {
    const h = harness();
    const r = await runUpload(pr("opened", { GANTRY_HEAD_REPO: "other/repo" }), h.deps);
    expect(r.outcome).toBe("skipped");
    expect(h.calls).toEqual([]);
    expect(h.lines).toEqual(["fork: upload skipped"]);
  });

  it("treats a pull request with no head repository (a deleted fork) as a fork, and compares case-insensitively", async () => {
    const a = harness();
    await runUpload(pr("closed", { GANTRY_HEAD_REPO: "" }), a.deps);
    expect(a.calls).toEqual([]);
    expect(a.lines).toEqual(["fork: upload skipped"]);
    const b = harness();
    await runUpload(pr("opened", { GANTRY_HEAD_REPO: "ACME/Repo" }), b.deps);
    expect(b.calls).toHaveLength(1);
  });

  it("skips a fork even when it is closed", async () => {
    const h = harness();
    await runUpload(pr("closed", { GANTRY_HEAD_REPO: "other/repo", GANTRY_PR_MERGED: "true" }), h.deps);
    expect(h.calls).toEqual([]);
  });

  it("uploads the main graph on a push to the default branch with --force-main", async () => {
    const h = harness();
    const r = await runUpload(push(), h.deps);
    expect(r.outcome).toBe("uploaded");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.file).toBe("/gantry/bin/gantry");
    expect(h.calls[0]?.args).toEqual(["upload", "--force-main"]);
  });

  it("logs and runs nothing on a push to another branch", async () => {
    const h = harness();
    const r = await runUpload(push({ GANTRY_REF_NAME: "feature", GITHUB_REF: "refs/heads/feature" }), h.deps);
    expect(r.outcome).toBe("skipped");
    expect(h.calls).toEqual([]);
    expect(h.lines).toEqual(["upload skipped: push to feature is not the default branch (main)"]);
  });

  it("does not upload a tag named like the default branch", async () => {
    const h = harness();
    await runUpload(push({ GITHUB_REF: "refs/tags/main" }), h.deps);
    expect(h.calls).toEqual([]);
  });

  it.each(["opened", "synchronize", "reopened"])("uploads the change set on %s", async (action) => {
    const h = harness();
    await runUpload(pr(action), h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.args).toEqual(["upload", "--pr", "7", "--base", BASE, "--head", HEAD]);
  });

  it("passes the team settings and the pull request details to the CLI in its environment, not in its arguments", async () => {
    const h = harness();
    await runUpload(pr("opened"), h.deps);
    const call = h.calls[0];
    expect(call?.env).toMatchObject({
      GANTRY_SERVER: "https://team.example.test",
      GANTRY_ORG: "acme",
      GANTRY_TOKEN: TOKEN,
      GANTRY_PR_OWNER: "octocat",
      GANTRY_PR_TITLE: "Fix the slug",
      GANTRY_PR_HEAD_REF: "feat/slug",
      GANTRY_PR_BASE_BRANCH: "main",
      GANTRY_PR_CREATED_AT: "2026-01-01T00:00:00Z",
    });
    expect(call?.args.join(" ")).not.toContain(TOKEN);
    expect(call?.args.join(" ")).not.toContain("Fix the slug");
  });

  it("closes a merged pull request with --close --merged", async () => {
    const h = harness();
    await runUpload(pr("closed", { GANTRY_PR_MERGED: "true" }), h.deps);
    expect(h.calls[0]?.args).toEqual(["upload", "--pr", "7", "--head", HEAD, "--close", "--merged"]);
  });

  it("closes an unmerged pull request with --close only", async () => {
    const h = harness();
    await runUpload(pr("closed", { GANTRY_PR_MERGED: "false" }), h.deps);
    expect(h.calls[0]?.args).toEqual(["upload", "--pr", "7", "--head", HEAD, "--close"]);
  });

  it("closes even when the index failed", async () => {
    const h = harness();
    const r = await runUpload(pr("closed", { GANTRY_INDEX_FAILED: "gantry init failed (exit 1)" }), h.deps);
    expect(r.outcome).toBe("uploaded");
    expect(h.calls).toHaveLength(1);
  });

  it("skips a push and a pull request upload when the index failed", async () => {
    for (const env of [push({ GANTRY_INDEX_FAILED: "x" }), pr("synchronize", { GANTRY_INDEX_FAILED: "x" })]) {
      const h = harness();
      const r = await runUpload(env, h.deps);
      expect(r.outcome).toBe("skipped");
      expect(h.calls).toEqual([]);
      expect(h.lines).toEqual(["upload skipped: the index failed"]);
    }
  });

  it("logs the does-not-upload line for another pull request action or event", async () => {
    const a = harness();
    await runUpload(pr("labeled"), a.deps);
    expect(a.calls).toEqual([]);
    expect(a.lines).toEqual(["upload skipped: pull request action labeled does not upload"]);
    const b = harness();
    await runUpload({ ...base, GANTRY_EVENT: "pull_request_target", GANTRY_EVENT_ACTION: "opened" }, b.deps);
    expect(b.calls).toEqual([]);
    expect(b.lines).toEqual(["upload skipped: event pull_request_target does not upload"]);
    const c = harness();
    await runUpload({ ...base, GANTRY_EVENT: "schedule" }, c.deps);
    expect(c.calls).toEqual([]);
    expect(c.lines).toEqual(["upload skipped: event schedule does not upload"]);
  });

  it("warns once and does not throw when the CLI exits non-zero, with the last stderr line and no token", async () => {
    const h = harness({
      code: 1,
      stderr: `first\nteam_unreachable: could not reach ${TOKEN} at the server\n`,
    });
    const r = await runUpload(push(), h.deps);
    expect(r.outcome).toBe("failed");
    const warnings = h.lines.filter((l) => l.startsWith("::warning"));
    expect(warnings).toEqual([
      "::warning title=Gantry::upload failed: team_unreachable: could not reach *** at the server",
    ]);
  });

  it("warns once when the CLI cannot start or throws, and the token is absent from every line", async () => {
    const h = harness("throw");
    const r = await runUpload(push(), h.deps);
    expect(r.outcome).toBe("failed");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/^::warning title=Gantry::upload failed: cannot start/);
    expect(h.lines.join("\n")).not.toContain(TOKEN);
  });

  it("names the exit code when the CLI printed nothing", async () => {
    const h = harness({ code: 127 });
    await runUpload(push(), h.deps);
    expect(h.lines).toEqual(["::warning title=Gantry::upload failed: gantry upload exited with code 127"]);
  });

  it("keeps the warning to one line when the reason has line breaks", async () => {
    const h = harness({ code: 1, stderr: "a\r\nb\tc\n" });
    await runUpload(push(), h.deps);
    expect(h.lines).toEqual(["::warning title=Gantry::upload failed: b c"]);
  });

  it("warns, runs nothing, when a pull request event lacks its numbers", async () => {
    const h = harness();
    await runUpload(pr("opened", { GANTRY_PR: "", GANTRY_PR_BASE_SHA: "" }), h.deps);
    expect(h.calls).toEqual([]);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/^::warning title=Gantry::upload failed: /);
  });

  it("never logs the token, on any path", async () => {
    for (const env of [push(), pr("opened"), pr("closed"), pr("opened", { GANTRY_HEAD_REPO: "o/r" })]) {
      const h = harness({ code: 1, stdout: `sent with ${TOKEN}\n`, stderr: `bad ${TOKEN}\n` });
      await runUpload(env, h.deps);
      expect(h.lines.join("\n")).not.toContain(TOKEN);
    }
  });
});
