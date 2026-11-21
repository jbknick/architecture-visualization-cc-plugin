import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MARKER, MAX_BODY } from "./comment.js";
import { type Exec, isForkPullRequest, run } from "./run.js";
import { sampleDuplicates, sampleReview } from "./sample.js";
import { type FakeGithub, startFakeGithub } from "./testkit.js";

let dir: string;
let fake: FakeGithub | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gantry-action-test-"));
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const pr = (headRepo: string | null = "octo/repo") => ({
  number: 7,
  pull_request: {
    number: 7,
    base: { sha: "a".repeat(40), repo: { full_name: "octo/repo" } },
    head: { sha: "b".repeat(40), repo: headRepo === null ? null : { full_name: headRepo } },
  },
});

/** A stand-in for the installed CLI: canned JSON for review and duplicates, and `git cat-file` for the recipe. */
function stubExec(
  over: { dupFails?: boolean; reviewFails?: boolean; recipe?: boolean } = {},
): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const run: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "git") return { code: over.recipe === false ? 128 : 0, stdout: "", stderr: "" };
    if (args[0] === "review") {
      return over.reviewFails
        ? { code: 1, stdout: "", stderr: "gantry: unknown git ref\n" }
        : { code: 0, stdout: JSON.stringify(sampleReview()), stderr: "" };
    }
    return over.dupFails
      ? { code: 1, stdout: "", stderr: "gantry: unknown ref\n" }
      : { code: 0, stdout: JSON.stringify(sampleDuplicates()), stderr: "" };
  };
  return Object.assign(run, { calls });
}

function env(
  api: FakeGithub | undefined,
  event: unknown,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));
  return {
    GANTRY_BIN: "gantry",
    GANTRY_TOKEN: "test-token",
    GITHUB_API_URL: api?.url ?? "http://127.0.0.1:1",
    GITHUB_REPOSITORY: "octo/repo",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    GITHUB_OUTPUT: join(dir, "output.txt"),
    ...extra,
  };
}

const deps = (exec: Exec) => ({ exec, log: () => undefined, sleep: async () => undefined });

describe("run", () => {
  it("creates one comment on the first run and updates it on the second", async () => {
    fake = await startFakeGithub({ pageSize: 2 });
    const exec = stubExec();
    const first = await run(env(fake, pr()), deps(exec));
    const second = await run(env(fake, pr()), deps(exec));
    expect([first.comment, second.comment]).toEqual(["created", "updated"]);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.body.startsWith(MARKER)).toBe(true);
    expect(fake.comments[0]?.body.length).toBeLessThanOrEqual(MAX_BODY);
    // the CLI is asked for the review of the pull request's range and the duplicates since its base
    expect(exec.calls[0]).toEqual(["gantry", "review", `${"a".repeat(40)}...${"b".repeat(40)}`, "--json"]);
    expect(exec.calls[1]).toEqual(["gantry", "duplicates", "--since", "a".repeat(40), "--json"]);
    expect(readFileSync(join(dir, "output.txt"), "utf8")).toContain("comment=updated");
  });

  it("puts the review in the job summary and does not fail when the token cannot comment", async () => {
    fake = await startFakeGithub({ refuseWrites: 403 });
    const r = await run(env(fake, pr()), deps(stubExec()));
    expect(r.comment).toBe("summary");
    expect(r.reason).toContain("cannot comment");
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain(MARKER);
    expect(fake.comments).toHaveLength(0);
  });

  it("skips commenting for a pull request from a fork, with no API call", async () => {
    fake = await startFakeGithub();
    const r = await run(env(fake, pr("fork-owner/repo")), deps(stubExec()));
    expect(r.comment).toBe("summary");
    expect(r.reason).toContain("fork");
    expect(fake.calls).toHaveLength(0);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("what this pull request changes");
  });

  it("recognises a fork, and a pull request whose fork was deleted", () => {
    expect(isForkPullRequest(pr().pull_request)).toBe(false);
    expect(isForkPullRequest(pr("OCTO/Repo").pull_request)).toBe(false);
    expect(isForkPullRequest(pr("someone/repo").pull_request)).toBe(true);
    expect(isForkPullRequest(pr(null).pull_request)).toBe(true);
  });

  it("still comments when the duplicate check fails, and says so", async () => {
    fake = await startFakeGithub();
    const r = await run(env(fake, pr()), deps(stubExec({ dupFails: true })));
    expect(r.comment).toBe("created");
    expect(fake.comments[0]?.body).toContain("The duplicate check did not run");
  });

  it("says the radius is structural only when the head has no recipe", async () => {
    fake = await startFakeGithub();
    await run(env(fake, pr()), deps(stubExec({ recipe: false })));
    expect(fake.comments[0]?.body).toContain("Structural radius only");
  });

  it("fails when the review cannot be produced", async () => {
    fake = await startFakeGithub();
    await expect(run(env(fake, pr()), deps(stubExec({ reviewFails: true })))).rejects.toThrow(
      /gantry review failed \(exit 1\).*unknown git ref/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("needs a base and a head outside a pull request event, and uses the summary", async () => {
    await expect(run(env(undefined, {}), deps(stubExec()))).rejects.toThrow(/base and head/);
    const r = await run(
      env(undefined, {}, { GANTRY_BASE: "main", GANTRY_HEAD: "feature" }),
      deps(stubExec()),
    );
    expect(r.comment).toBe("summary");
    expect(r.reason).toContain("not for a pull request");
  });

  it("lets the base and head inputs override the event", async () => {
    fake = await startFakeGithub();
    const exec = stubExec();
    await run(env(fake, pr(), { GANTRY_BASE: "origin/main", GANTRY_HEAD: "HEAD" }), deps(exec));
    expect(exec.calls[0]).toEqual(["gantry", "review", "origin/main...HEAD", "--json"]);
  });
});
