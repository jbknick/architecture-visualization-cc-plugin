// action/post-failure.sh posts the failure notice when the install failed and dist/action.js is not there (issue #282).
// It runs here against the fake GitHub API on node:http; no real network call.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFailureComment, MARKER } from "./comment.js";
import { type FakeGithub, startFakeGithub } from "./testkit.js";

const script = join(import.meta.dirname, "../post-failure.sh");
let dir: string;
let fake: FakeGithub | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gantry-failure-test-"));
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function runScript(extra: Record<string, string>): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [script], {
      env: {
        PATH: process.env.PATH ?? "",
        GANTRY_TOKEN: "test-token",
        GITHUB_REPOSITORY: "octo/repo",
        GANTRY_PR: "7",
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        GITHUB_OUTPUT: join(dir, "output.txt"),
        ...extra,
      },
    });
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.on("close", (status) => resolve({ status: status ?? 1, stdout }));
  });
}

const reason = "checksum mismatch for gantry-0.1.0.tgz: the download was not used";
const read = (name: string): string => readFileSync(join(dir, name), "utf8");

describe("post-failure.sh", () => {
  it("creates the notice, then updates that same comment in place, with the text of buildFailureComment", async () => {
    fake = await startFakeGithub({ pageSize: 2 });
    const a = await runScript({ GANTRY_FAILURE: reason, GITHUB_API_URL: fake.url });
    expect(a.status).toBe(0);
    expect(read("output.txt")).toContain("comment=created");
    const b = await runScript({ GANTRY_FAILURE: "download failed", GITHUB_API_URL: fake.url });
    expect(b.status).toBe(0);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.body).toBe(buildFailureComment("download failed"));
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("writes the same bytes as buildFailureComment", async () => {
    fake = await startFakeGithub();
    await runScript({ GANTRY_FAILURE: reason, GITHUB_API_URL: fake.url });
    expect(fake.comments[0]?.body).toBe(buildFailureComment(reason));
  });

  it("finds its earlier comment on a later page", async () => {
    fake = await startFakeGithub({
      pageSize: 2,
      comments: [{ body: "one" }, { body: "two" }, { body: "three" }, { body: `${MARKER}\nold` }],
    });
    await runScript({ GANTRY_FAILURE: reason, GITHUB_API_URL: fake.url });
    expect(fake.comments).toHaveLength(4);
    expect(fake.comments[3]?.body).toBe(buildFailureComment(reason));
  });

  it("keeps the reason to one bounded line of plain characters", async () => {
    fake = await startFakeGithub();
    await runScript({
      GANTRY_FAILURE: `bad\n\`\`\` "quoted" \\ [x](http://evil) ${"y".repeat(1000)}`,
      GITHUB_API_URL: fake.url,
    });
    const body = fake.comments[0]?.body ?? "";
    expect(body.split("\n").filter((l) => l.startsWith("Gantry could not analyze"))).toHaveLength(1);
    expect(body).not.toContain("```");
    expect(body.length).toBeLessThan(500);
  });

  it("goes to the job summary for a fork, with no API call", async () => {
    fake = await startFakeGithub();
    const r = await runScript({ GANTRY_FAILURE: reason, GITHUB_API_URL: fake.url, GANTRY_FORK: "true" });
    expect(r.status).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(read("summary.md")).toContain("the analysis failed");
    expect(read("output.txt")).toContain("comment=summary");
  });

  it("goes to the job summary, exit 0, when the token is refused or the API is unreachable", async () => {
    fake = await startFakeGithub({ refuseWrites: 403 });
    const refused = await runScript({ GANTRY_FAILURE: reason, GITHUB_API_URL: fake.url });
    expect(refused.status).toBe(0);
    expect(read("summary.md")).toContain(MARKER);
    const down = await runScript({ GANTRY_FAILURE: reason, GITHUB_API_URL: "http://127.0.0.1:1" });
    expect(down.status).toBe(0);
    expect(down.stdout).toContain("gantry-action: summary");
  });

  it("goes to the job summary when the run is not for a pull request", async () => {
    const r = await runScript({ GANTRY_FAILURE: reason, GANTRY_PR: "" });
    expect(r.status).toBe(0);
    expect(read("summary.md")).toContain("the analysis failed");
  });
});
