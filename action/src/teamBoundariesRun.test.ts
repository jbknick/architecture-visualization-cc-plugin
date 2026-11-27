// The team boundaries wiring of run.ts and action.yml: when the section is asked for, what the child process is
// given, and that the GitHub token and the team token never meet. The CLI is a stand-in here; the real one is in
// teamBoundaries.e2e.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CrossingFinding } from "./comment.js";
import { type Exec, run } from "./run.js";
import { sampleDuplicates, sampleReview } from "./sample.js";
import { type FakeGithub, startFakeGithub } from "./testkit.js";

const GITHUB_TOKEN = "ghs_github-token-41b7";
const TEAM_TOKEN = "gct_team-token-9d2e";
const TEAM = {
  GANTRY_TEAM_SERVER: "https://team.example.test",
  GANTRY_TEAM_ORG: "acme",
  GANTRY_TEAM_TOKEN: TEAM_TOKEN,
};

let dir: string;
let fake: FakeGithub | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gantry-team-run-"));
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const finding = (over: Partial<CrossingFinding> = {}): CrossingFinding => ({
  kind: "crossing",
  srcName: "totalDue",
  srcPath: "src/orders/invoice.ts",
  srcLine: 3,
  srcGroup: "Orders",
  dstName: "formatPrice",
  dstPath: "src/catalog/price.ts",
  dstLine: 1,
  dstGroup: "Catalog",
  team: true,
  ...over,
});

const event = (headRepo = "octo/repo") => ({
  number: 7,
  pull_request: {
    number: 7,
    base: { sha: "a".repeat(40), repo: { full_name: "octo/repo" } },
    head: { sha: "b".repeat(40), repo: { full_name: headRepo } },
  },
});

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}
/** A stand-in CLI: review and duplicates as canned JSON, and `team boundaries` as given. */
function stubExec(team: { code: number; stdout: string; stderr: string }): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, _cwd, env) => {
    calls.push({ file, args, env });
    if (file === "git") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "review") return { code: 0, stdout: JSON.stringify(sampleReview()), stderr: "" };
    if (args[0] === "team") return team;
    return { code: 0, stdout: JSON.stringify(sampleDuplicates()), stderr: "" };
  };
  return Object.assign(exec, { calls });
}
const ok = (crossings: CrossingFinding[]) => ({
  code: 0,
  stdout: JSON.stringify({ crossings, total: crossings.length }),
  stderr: "",
});

function env(extra: Record<string, string>, ev: unknown = event()): NodeJS.ProcessEnv {
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(ev));
  return {
    GANTRY_BIN: "gantry",
    GANTRY_TOKEN: GITHUB_TOKEN,
    GITHUB_API_URL: fake?.url ?? "http://127.0.0.1:1",
    GITHUB_REPOSITORY: "octo/repo",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    GITHUB_OUTPUT: join(dir, "output.txt"),
    ...extra,
  };
}

const teamCalls = (exec: { calls: Call[] }): Call[] => exec.calls.filter((c) => c.args[0] === "team");
const base = (logs: string[]) => ({ log: (l: string) => logs.push(l), sleep: async () => undefined });

describe("team boundaries in the pull request comment run", () => {
  it("asks the CLI for the crossings of the range and puts them in the comment", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    const exec = stubExec(ok([finding()]));
    const r = await run(env(TEAM), { ...base([]), exec });
    expect(r.comment).toBe("created");
    expect(teamCalls(exec).map((c) => c.args)).toEqual([
      ["team", "boundaries", "--base", "a".repeat(40), "--head", "b".repeat(40), "--json"],
    ]);
    expect(fake.comments[0]?.body).toContain("### Team boundaries (1)");
    expect(fake.comments[0]?.body).toContain(
      "- `Orders` → `Catalog`: `totalDue` uses `formatPrice` (1 edge in total)",
    );
  });

  it("gives the child the team values as GANTRY_SERVER, GANTRY_ORG and GANTRY_TOKEN, and never the GitHub token", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    const exec = stubExec(ok([]));
    await run(env(TEAM), { ...base([]), exec });
    const child = teamCalls(exec)[0]?.env;
    expect(child?.GANTRY_SERVER).toBe(TEAM.GANTRY_TEAM_SERVER);
    expect(child?.GANTRY_ORG).toBe("acme");
    expect(child?.GANTRY_TOKEN).toBe(TEAM_TOKEN);
    expect(JSON.stringify(child)).not.toContain(GITHUB_TOKEN);
    // The other children (review, duplicates, git) get the step's environment without any team value.
    const others = exec.calls.filter((x) => x.args[0] !== "team");
    expect(others.map((c) => c.args[0])).toEqual(["review", "duplicates", "cat-file"]);
    for (const c of others) {
      expect(Object.keys(c.env ?? {}).filter((k) => k.startsWith("GANTRY_TEAM_"))).toEqual([]);
      expect(JSON.stringify(c.env)).not.toContain(TEAM_TOKEN);
      expect(c.env?.GANTRY_TOKEN).toBe(GITHUB_TOKEN);
    }
    expect(Object.keys(child ?? {}).filter((k) => k.startsWith("GANTRY_TEAM_"))).toEqual([]);
  });

  it("posts the comment with the GitHub token only: the fake API accepts nothing else", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    const r = await run(env(TEAM), { ...base([]), exec: stubExec(ok([finding()])) });
    expect(r.comment).toBe("created");
    expect(JSON.stringify(fake.comments)).not.toContain(TEAM_TOKEN);
    expect(JSON.stringify(fake.calls)).not.toContain(TEAM_TOKEN);
    // And the token that reached the comment client was not the team's: a run whose only token is the team's fails.
    const refused = await run(env({ ...TEAM, GANTRY_TOKEN: TEAM_TOKEN }), {
      ...base([]),
      exec: stubExec(ok([])),
    });
    expect(refused.comment).toBe("summary");
  });

  it("makes no team request for a pull request from a fork", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    const exec = stubExec(ok([finding()]));
    const r = await run(env(TEAM, event("mallory/repo")), { ...base([]), exec });
    expect(teamCalls(exec)).toEqual([]);
    expect(r.body).not.toContain("Team boundaries");
  });

  it("makes no team request unless the server, the organisation and the token are all set", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    for (const missing of Object.keys(TEAM)) {
      const exec = stubExec(ok([finding()]));
      const some = { ...TEAM, [missing]: "" };
      const r = await run(env(some), { ...base([]), exec });
      expect(teamCalls(exec), missing).toEqual([]);
      expect(r.body).not.toContain("Team boundaries");
    }
  });

  it("without team values the comment is the one it was, and no team command is run", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    const exec = stubExec(ok([finding()]));
    const plain = await run(env({}), { ...base([]), exec });
    expect(teamCalls(exec)).toEqual([]);
    const withEmpty = await run(env({ GANTRY_TEAM_SERVER: "", GANTRY_TEAM_ORG: "", GANTRY_TEAM_TOKEN: "" }), {
      ...base([]),
      exec,
    });
    expect(withEmpty.body).toBe(plain.body);
  });

  it("a failing team call leaves the normal comment and one warning line, without the token", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    const logs: string[] = [];
    const exec = stubExec({
      code: 1,
      stdout: "",
      stderr: `team_unreachable: Cannot reach https://team.example.test (${TEAM_TOKEN}).\n`,
    });
    const r = await run(env(TEAM), { ...base(logs), exec });
    expect(r.comment).toBe("created");
    expect(fake.comments[0]?.body).toContain("### Duplicates");
    expect(fake.comments[0]?.body).not.toContain("Team boundaries");
    expect(fake.comments[0]?.body).not.toContain("the analysis failed");
    const warnings = logs.filter((l) => l.startsWith("::warning"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^::warning title=Gantry::team boundaries unavailable: \S/);
    expect(warnings[0]).not.toContain(TEAM_TOKEN);
  });

  it("an answer that is not JSON is one warning line and no section", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    const logs: string[] = [];
    const r = await run(env(TEAM), {
      ...base(logs),
      exec: stubExec({ code: 0, stdout: "oops", stderr: "" }),
    });
    expect(r.comment).toBe("created");
    expect(r.body).not.toContain("Team boundaries");
    expect(logs.filter((l) => l.startsWith("::warning"))).toHaveLength(1);
  });

  it("drops entries of the answer that do not have the shape, so the comment never reads a missing field", async () => {
    fake = await startFakeGithub({ token: GITHUB_TOKEN });
    const bad = { kind: "crossing", srcGroup: 5 } as unknown as CrossingFinding;
    const r = await run(env(TEAM), { ...base([]), exec: stubExec(ok([bad, finding()])) });
    expect(r.body).toContain("### Team boundaries (1)");
  });
});

describe("action.yml hands the comment step the team values", () => {
  const yml = readFileSync(join(import.meta.dirname, "../action.yml"), "utf8");
  const expr = (inner: string): string => `\${{ ${inner} }}`;
  const commentStep = yml.slice(yml.indexOf("id: comment"), yml.indexOf("id: upload"));

  it("under names of their own, next to the GitHub token", () => {
    expect(commentStep).toContain(`GANTRY_TEAM_SERVER: ${expr("inputs.team-server")}`);
    expect(commentStep).toContain(`GANTRY_TEAM_ORG: ${expr("inputs.team-org")}`);
    expect(commentStep).toContain(`GANTRY_TEAM_TOKEN: ${expr("inputs.team-token")}`);
    expect(commentStep).toContain(`GANTRY_TOKEN: ${expr("inputs.github-token")}`);
    expect(commentStep).not.toMatch(/GANTRY_TOKEN: .*team-token/);
  });

  it("only in the comment step's environment, as three lines in the file", () => {
    expect(yml.match(/GANTRY_TEAM_(SERVER|ORG|TOKEN)/g)).toHaveLength(3);
  });
});
