// End to end for the team boundaries section: the script (action/src/main.ts, bundled here) runs the real CLI
// (plugin/bin/gantry) on a copy of fixtures/overlay-groups indexed at a head commit whose function in src/orders/ now
// calls one in src/catalog/, against the fake protocol server (holding the fixture's two groups) and the fake GitHub
// API. Bundled from source in beforeAll. No network beyond 127.0.0.1.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Group } from "../../packages/core/src/index.js";
import { type FakeServer, startFakeServer } from "../../packages/protocol/src/testing/index.js";
import { type FakeGithub, startFakeGithub } from "./testkit.js";

interface TestBundle {
  home: string;
  cleanup(): void;
}
// The shared helper (scripts/testBundle.ts) is outside this project's file list, so it is loaded by a computed path.
const helperPath = "../../scripts/testBundle.js";
const { bundlePlugin } = (await import(/* @vite-ignore */ helperPath)) as {
  bundlePlugin: (names: string[]) => Promise<TestBundle>;
};

const root = join(import.meta.dirname, "../..");
let home: string;
let bundle: TestBundle | undefined;
const REPO = "acme/overlay-groups";
const GITHUB_TOKEN = "ghs_e2e-github-3f6a";
const TEAM_TOKEN = "gct_e2e-team-8c41";
const GROUPS = JSON.parse(readFileSync(join(root, "fixtures/overlay-groups/groups.json"), "utf8")) as Group[];

let work: string;
let dir: string;
let base: string;
let head: string;
let data: string;
let fake: FakeServer | undefined;
let github: FakeGithub;

const git = (cwd: string, ...args: string[]): string =>
  spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "E2E",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "E2E",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    },
  }).stdout.trim();

function childEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(work, "home"),
    CLAUDE_PLUGIN_DATA: data,
    GANTRY_CREDENTIALS_FILE: join(work, "no-credentials.json"),
    ...extra,
  };
}

function runAction(extra: Record<string, string>): Promise<{ code: number; out: string }> {
  const eventPath = join(work, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      number: 1,
      pull_request: {
        number: 1,
        base: { sha: base, repo: { full_name: REPO } },
        head: { sha: head, repo: { full_name: REPO } },
      },
    }),
  );
  return new Promise((resolve) => {
    const child = spawn("node", [join(home, "dist/action.js")], {
      cwd: dir,
      env: childEnv({
        GANTRY_BIN: join(home, "bin/gantry"),
        GANTRY_HOME: home,
        GANTRY_TOKEN: GITHUB_TOKEN,
        GITHUB_API_URL: github.url,
        GITHUB_REPOSITORY: REPO,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: join(work, "output.txt"),
        GITHUB_STEP_SUMMARY: join(work, "summary.md"),
        ...extra,
      }),
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const warnings = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("::warning"));
const teamEnv = (): Record<string, string> => ({
  GANTRY_TEAM_SERVER: fake?.url ?? "http://127.0.0.1:1",
  GANTRY_TEAM_ORG: "acme",
  GANTRY_TEAM_TOKEN: TEAM_TOKEN,
});

beforeAll(async () => {
  bundle = await bundlePlugin(["cli", "action"]);
  home = bundle.home;
  work = mkdtempSync(join(tmpdir(), "gantry-team-boundaries-e2e-"));
  mkdirSync(join(work, "home"));
  dir = join(work, "overlay-groups");
  if (spawnSync("cp", ["-R", join(root, "fixtures/overlay-groups"), dir]).status !== 0) {
    throw new Error("cannot copy the fixture");
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", `https://github.com/${REPO}.git`);
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-q", "-m", "base");
  base = git(dir, "rev-parse", "HEAD");
  // The head: totalDue in src/orders/ now calls formatPrice in src/catalog/, which Orders does not list.
  writeFileSync(
    join(dir, "src/orders/invoice.ts"),
    readFileSync(join(root, "fixtures/overlay-groups/invoice.edited.txt")),
  );
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-q", "-m", "head");
  head = git(dir, "rev-parse", "HEAD");
}, 60_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  bundle?.cleanup();
});

beforeEach(async () => {
  data = mkdtempSync(join(work, "data-"));
  github = await startFakeGithub({ token: GITHUB_TOKEN });
  fake = await startFakeServer({ tokens: [TEAM_TOKEN], repo: REPO, org: "acme" });
  fake.state.groups.set(REPO, new Map(GROUPS.map((g) => [g.id, g])));
  // The index of the head checkout, as the Action's index step leaves it.
  const init = spawnSync(join(home, "bin/gantry"), ["init"], {
    cwd: dir,
    encoding: "utf8",
    env: childEnv({}),
  });
  if (init.status !== 0) throw new Error(`gantry init failed: ${init.stderr}`);
}, 120_000);
afterEach(async () => {
  await fake?.close().catch(() => undefined);
  await github.close();
});

describe("team boundaries in the comment, end to end", () => {
  it("the posted comment holds a Team boundaries section naming Orders and Catalog", async () => {
    const r = await runAction(teamEnv());
    expect(r.code).toBe(0);
    expect(warnings(r.out)).toEqual([]);
    const body = github.comments[0]?.body ?? "";
    expect(body).toContain("### Team boundaries (1)");
    expect(body).toContain("- `Orders` → `Catalog`: `totalDue` uses `formatPrice` (1 edge in total)");
    expect(r.out).not.toContain(TEAM_TOKEN);
    expect(body).not.toContain(TEAM_TOKEN);
  }, 120_000);

  it("with the server stopped there is no such section and one warning line", async () => {
    const env = teamEnv();
    await fake?.close();
    const r = await runAction(env);
    expect(r.code).toBe(0);
    const body = github.comments[0]?.body ?? "";
    expect(body).toContain("## Gantry: what this pull request changes");
    expect(body).not.toContain("Team boundaries");
    expect(warnings(r.out)).toHaveLength(1);
    expect(warnings(r.out)[0]).toMatch(
      /^::warning title=Gantry::team boundaries unavailable: .*team_unreachable/,
    );
    expect(r.out).not.toContain(TEAM_TOKEN);
  }, 120_000);

  it("without the team values the comment has no section and no warning", async () => {
    const r = await runAction({});
    expect(r.code).toBe(0);
    expect(github.comments[0]?.body).not.toContain("Team boundaries");
    expect(warnings(r.out)).toEqual([]);
  }, 120_000);
});
