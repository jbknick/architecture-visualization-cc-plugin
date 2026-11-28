import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type GantryPaths, resetTeamProtocolCache } from "@gantry/core";
import { type ChangeSet, PROTOCOL_VERSION } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatAge,
  registerTeam,
  type TeamContext,
  teamLink,
  teamLogin,
  teamLogout,
  teamStatus,
} from "./team.js";

const USER_TOKEN = "tok-user-9f3a";
const REPO = "acme/storefront";
const SHOWN = "https://gantry.example.com";

let tmp: string;
let paths: GantryPaths;
let env: NodeJS.ProcessEnv;
let fake: FakeServer;
let stdout: string[];
let stderr: string[];

const ctx = (extra: Partial<TeamContext> = {}): TeamContext => ({
  paths,
  env,
  out: (t) => stdout.push(t),
  err: (t) => stderr.push(t),
  ...extra,
});
/** What a command printed, with the fake server's address shown as the one in the UI guide. */
const printed = (lines: string[]): string => lines.join("").replaceAll(fake.url, SHOWN);

beforeEach(async () => {
  resetTeamProtocolCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-team-cmd-"));
  paths = {
    root: tmp,
    repo: REPO,
    dataDir: path.join(tmp, "data"),
    configPath: path.join(tmp, "data", "config.json"),
    globalConfigPath: path.join(tmp, "global.json"),
  } as GantryPaths;
  env = { GANTRY_CREDENTIALS_FILE: path.join(tmp, "credentials.json") };
  stdout = [];
  stderr = [];
  fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN], repo: REPO });
});
afterEach(async () => {
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const link = (org = "acme") => teamLink(ctx(), { server: fake.url, org });
const signIn = () => {
  env.GANTRY_TOKEN = USER_TOKEN;
};

describe("help", () => {
  it("lists the subcommands", () => {
    const program = new Command().name("gantry");
    registerTeam(program);
    const team = program.commands.find((c) => c.name() === "team");
    expect(team?.helpInformation()).toMatchInlineSnapshot(`
      "Usage: gantry team [options] [command]

      Connect this checkout to a team server (sign in, link, check the connection)

      Options:
        -h, --help                   display help for command

      Commands:
        login [options]              Sign in to a team server with a code
        link [options]               Say which server and organization this repo
                                     belongs to
        status [options]             Show the server, organization, user and repo,
                                     whether the server answers, and the team cache
        logout [options]             Remove the stored sign-in for a server
        boundaries [options]         List the edges of the changed functions and files
                                     that break a team group's mayUse (read from the
                                     team server)
        sync-descriptions [options]  Fill in the descriptions the team already has for
                                     functions this machine has none for
        publish                      Send a local view or group to the team
        unpublish                    Remove a view or group the team has published
        help [command]               display help for command
      "
    `);
    for (const name of ["login", "link", "status", "logout"]) {
      expect(team?.commands.find((c) => c.name() === name)?.helpInformation()).toMatchSnapshot(name);
    }
  });
});

describe("gantry team link", () => {
  it("links a connected repo", async () => {
    signIn();
    expect(await link()).toBe(0);
    expect(
      printed(stdout),
    ).toMatchInlineSnapshot(`"Linked acme/storefront to acme on https://gantry.example.com.
"`);
    expect(JSON.parse(fs.readFileSync(paths.configPath, "utf8"))).toEqual({
      team: { server: fake.url, org: "acme" },
    });
  });

  it("says when the server does not know the repo yet", async () => {
    await fake.close();
    fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN], repo: "someone/else" });
    signIn();
    expect(await link()).toBe(0);
    expect(printed(stdout)).toBe("Linked, but acme/storefront is not connected on the server yet.\n");
  });

  it("asks for a sign-in when there is no token", async () => {
    expect(await link()).toBe(0);
    expect(printed(stdout)).toBe(
      "Linked acme/storefront to acme on https://gantry.example.com. Run gantry team login.\n",
    );
    expect(fs.existsSync(env.GANTRY_CREDENTIALS_FILE ?? "")).toBe(false);
  });

  it("keeps the link and warns, exit 0, when the server cannot be reached", async () => {
    const url = fake.url;
    await fake.close();
    signIn();
    expect(await teamLink(ctx(), { server: url, org: "acme" })).toBe(0);
    expect(stdout.join("").replaceAll(url, SHOWN)).toBe(
      "Linked acme/storefront to acme on https://gantry.example.com.\n",
    );
    expect(stderr.join("").replaceAll(url, SHOWN)).toBe(
      "Could not check the link: Cannot reach https://gantry.example.com.\n",
    );
    expect(JSON.parse(fs.readFileSync(paths.configPath, "utf8"))).toEqual({
      team: { server: url, org: "acme" },
    });
    fake = await startFakeServer();
  });

  it("keeps the link and says to sign in, exit 0, when the token is rejected", async () => {
    env.GANTRY_TOKEN = "tok-rejected";
    expect(await link()).toBe(0);
    expect(printed(stdout)).toBe("Linked acme/storefront to acme on https://gantry.example.com.\n");
    expect(stderr.join("")).toBe(
      "team_unauthorized: The server did not accept the token. Run gantry team login.\n",
    );
    expect(JSON.parse(fs.readFileSync(paths.configPath, "utf8"))).toEqual({
      team: { server: fake.url, org: "acme" },
    });
  });

  it("refuses a server that is not https or localhost, and writes nothing", async () => {
    expect(await teamLink(ctx(), { server: "http://gantry.example.com", org: "acme" })).toBe(1);
    expect(stderr.join("")).toBe(
      "team_config: The server must be an https URL (http only for localhost and 127.0.0.1).\n",
    );
    expect(fs.existsSync(paths.configPath)).toBe(false);
  });
});

describe("gantry team login", () => {
  it("says there is no server when none is given or linked", async () => {
    expect(await teamLogin(ctx(), {})).toBe(1);
    expect(stderr.join("")).toBe("No server. Pass --server or run gantry team link first.\n");
    expect(stdout).toEqual([]);
  });

  it("prints the code, waits for approval, signs in and stores the user and token", async () => {
    const sleeps: number[] = [];
    let polls = 0;
    const exit = await teamLogin(
      ctx({
        sleep: async (ms) => {
          sleeps.push(ms);
          polls += 1;
          if (polls === 2)
            fake.state.approveDevice(
              /([0-9A-F]{4})-([0-9A-F]{4})/.exec(stdout.join(""))?.slice(1, 3).join("") ?? "",
            );
        },
      }),
      { server: fake.url },
    );
    expect(exit).toBe(0);
    expect(sleeps).toEqual([5000, 5000]);
    const shown = printed(stdout)
      .replace(/[0-9A-F]{4}-[0-9A-F]{4}/, "BCDF-GHJK")
      .replace(/user_code=[0-9A-F]{8}/, "user_code=BCDFGHJK")
      .replace("http://127.0.0.1/device", "https://gantry.example.com/device");
    expect(shown).toMatchInlineSnapshot(`
      "Open https://gantry.example.com/device?user_code=BCDFGHJK and check that the page shows this code:

          BCDF-GHJK

      Waiting for approval... (expires in 15 minutes)
      Signed in as octo-dev on https://gantry.example.com.
      "
    `);
    const stored = JSON.parse(fs.readFileSync(env.GANTRY_CREDENTIALS_FILE ?? "", "utf8")) as {
      servers: Record<string, { token: string; user: string; expires_at: string }>;
    };
    expect(stored.servers[fake.url]).toMatchObject({ token: USER_TOKEN, user: "octo-dev" });
    expect(stdout.join("") + stderr.join("")).not.toContain(USER_TOKEN);
  });

  it("prints the complete URL, with the code in it, and the code on its own line", async () => {
    const exit = await teamLogin(
      ctx({
        sleep: async () => {
          fake.state.approveDevice(
            /([0-9A-F]{4})-([0-9A-F]{4})/.exec(stdout.join(""))?.slice(1, 3).join("") ?? "",
          );
        },
      }),
      { server: fake.url },
    );
    expect(exit).toBe(0);
    const text = stdout.join("");
    const code = /^ {4}([0-9A-F]{4})-([0-9A-F]{4})$/m.exec(text);
    expect(code).not.toBeNull();
    expect(text).toContain(
      `Open http://127.0.0.1/device?user_code=${code?.[1]}${code?.[2]} and check that the page shows this code:\n`,
    );
  });

  it("falls back to the plain URL and the code when the server sends no complete URL", async () => {
    const plain = await startFakeServer({ omitVerificationUriComplete: true });
    try {
      const exit = await teamLogin(
        ctx({
          sleep: async () => {
            plain.state.approveDevice(
              /([0-9A-F]{4})-([0-9A-F]{4})/.exec(stdout.join(""))?.slice(1, 3).join("") ?? "",
            );
          },
        }),
        { server: plain.url },
      );
      expect(exit).toBe(0);
      const text = stdout.join("");
      expect(text).toContain("Open http://127.0.0.1/device and enter the code:\n\n    ");
      expect(text).not.toContain("user_code=");
      expect(text).toMatch(/^ {4}[0-9A-F]{4}-[0-9A-F]{4}$/m);
    } finally {
      await plain.close();
    }
  });

  it("uses the linked server when --server is not given", async () => {
    await link();
    stdout.length = 0;
    let first = true;
    const exit = await teamLogin(
      ctx({
        sleep: async () => {
          if (first)
            fake.state.approveDevice(
              /([0-9A-F]{4})-([0-9A-F]{4})/.exec(stdout.join(""))?.slice(1, 3).join("") ?? "",
            );
          first = false;
        },
      }),
      {},
    );
    expect(exit).toBe(0);
  });

  it("waits 5 s longer after slow_down", async () => {
    const answers = [{ error: "slow_down" }, { error: "authorization_pending" }];
    const real = fetch;
    const stub: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/api/auth/device/token") && answers.length > 0) {
        return new Response(JSON.stringify(answers.shift()), { status: 400 });
      }
      return real(input, init);
    };
    const sleeps: number[] = [];
    const exit = await teamLogin(
      ctx({
        fetch: stub,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 3)
            fake.state.approveDevice(
              /([0-9A-F]{4})-([0-9A-F]{4})/.exec(stdout.join(""))?.slice(1, 3).join("") ?? "",
            );
        },
      }),
      { server: fake.url },
    );
    expect(exit).toBe(0);
    expect(sleeps).toEqual([5000, 10_000, 10_000]);
  });

  it("stops at once with exit 1 when the sign-in is denied", async () => {
    const stub: typeof fetch = async (input, init) =>
      String(input).endsWith("/api/auth/device/token")
        ? new Response(JSON.stringify({ error: "access_denied" }), { status: 400 })
        : fetch(input, init);
    const sleeps: number[] = [];
    const exit = await teamLogin(ctx({ fetch: stub, sleep: async (ms) => void sleeps.push(ms) }), {
      server: fake.url,
    });
    expect(exit).toBe(1);
    expect(sleeps).toHaveLength(1);
    expect(stderr.join("")).toBe("team_rejected: The sign-in was denied.\n");
    expect(fs.existsSync(env.GANTRY_CREDENTIALS_FILE ?? "")).toBe(false);
  });

  it("stops when the code expires", async () => {
    let clock = 0;
    const exit = await teamLogin(
      ctx({
        now: () => clock,
        sleep: async (ms) => {
          clock += ms + 400_000;
        },
      }),
      { server: fake.url },
    );
    expect(exit).toBe(1);
    expect(stderr.join("")).toBe("team_rejected: The code expired.\n");
    expect(fs.existsSync(env.GANTRY_CREDENTIALS_FILE ?? "")).toBe(false);
  });
});

describe("gantry team status", () => {
  it("prints the connection", async () => {
    await link();
    signIn();
    stdout.length = 0;
    expect(await teamStatus(ctx(), {})).toBe(0);
    expect(printed(stdout)).toMatchInlineSnapshot(`
      "server:    https://gantry.example.com
      org:       acme
      user:      octo-dev
      repo:      acme/storefront
      reachable: yes
      cache:     empty
      "
    `);
  });

  it("prints one JSON line with --json", async () => {
    await link();
    signIn();
    stdout.length = 0;
    expect(await teamStatus(ctx(), { json: true })).toBe(0);
    expect(printed(stdout)).toBe(
      `{"server":"https://gantry.example.com","org":"acme","user":"octo-dev","repo":"acme/storefront","reachable":true,"protocol":${PROTOCOL_VERSION},"cache":{"change_sets":0,"pulled_at":null,"age_s":null,"last_error":null}}\n`,
    );
  });

  it("says not signed in, and exits 1", async () => {
    await link();
    stdout.length = 0;
    expect(await teamStatus(ctx(), {})).toBe(1);
    expect(printed(stdout)).toContain("user:      not signed in\n");
    expect(printed(stdout)).toContain("reachable: yes\n");
  });

  it("says reachable: no when the server does not answer, and exits 1", async () => {
    await link();
    signIn();
    await fake.close();
    stdout.length = 0;
    expect(await teamStatus(ctx(), {})).toBe(1);
    expect(printed(stdout)).toContain("reachable: no\n");
    fake = await startFakeServer();
  });

  it("names team_unauthorized for a rejected token", async () => {
    await link();
    env.GANTRY_TOKEN = "tok-rejected";
    expect(await teamStatus(ctx(), {})).toBe(1);
    expect(printed(stderr)).toBe(
      "team_unauthorized: The server did not accept the token. Run gantry team login.\n",
    );
    expect(stderr.join("")).not.toContain("tok-rejected");
  });

  it("names team_forbidden for an organization the user is not in", async () => {
    await link("other-org");
    signIn();
    expect(await teamStatus(ctx(), {})).toBe(1);
    expect(printed(stderr)).toBe(
      "team_forbidden: You are not a member of other-org on https://gantry.example.com.\n",
    );
  });

  it("says it is not linked when nothing names a server", async () => {
    expect(await teamStatus(ctx(), {})).toBe(1);
    expect(stderr.join("")).toBe("Not linked. Run gantry team link --server <url> --org <slug>.\n");
  });

  it("works from the environment alone and writes nothing", async () => {
    env.GANTRY_SERVER = fake.url;
    env.GANTRY_ORG = "acme";
    env.GANTRY_TOKEN = USER_TOKEN;
    expect(await teamStatus(ctx(), { json: true })).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      server: fake.url,
      org: "acme",
      user: "octo-dev",
      repo: REPO,
      reachable: true,
      protocol: PROTOCOL_VERSION,
      cache: { change_sets: 0, pulled_at: null, age_s: null, last_error: null },
    });
    expect(fs.existsSync(paths.dataDir)).toBe(false);
    expect(fs.existsSync(env.GANTRY_CREDENTIALS_FILE ?? "")).toBe(false);
  });
});

describe("gantry team status, the cache line", () => {
  const T0 = Date.parse("2026-11-25T14:00:00.000Z");
  const csFor = (n: number): ChangeSet => ({
    id: `cs:pr:${REPO}#${n}`,
    repo: REPO,
    source: "pr",
    state: "in_review",
    ref: `#${n}`,
    head_ref: `feat/${n}`,
    base_branch: "main",
    nodes: [`file:${REPO}:src/a${n}.ts`],
    radius: [],
    estimated: false,
    owner: "octo-dev",
    title: `Change ${n}`,
    pr: n,
    head_sha: "7e3d9a1c5b8f20466d1ae9c3b7f45082d6c1e9ab",
    created_at: "2026-11-20T09:15:00.000Z",
    updated_at: `2026-11-20T09:4${n}:12.000Z`,
    links: [],
  });
  const seed = (...ns: number[]) => {
    for (const n of ns) fake.state.changeSets.set(csFor(n).id, csFor(n));
  };

  it("does not pull without --pull, and says cache: empty", async () => {
    await link();
    signIn();
    seed(1, 2, 3);
    stdout.length = 0;
    expect(await teamStatus(ctx(), {})).toBe(0);
    expect(printed(stdout)).toContain("reachable: yes\ncache:     empty\n");
    expect(fs.existsSync(path.join(paths.dataDir, "team-cache.db"))).toBe(false);
  });

  it("--pull pulls first, then prints the count and the age (the snapshot)", async () => {
    await link();
    signIn();
    seed(1, 2, 3);
    stdout.length = 0;
    expect(await teamStatus(ctx({ now: () => T0 }), { pull: true })).toBe(0);
    expect(printed(stdout)).toContain("cache:     3 open changes, pulled 0 s ago\n");
    stdout.length = 0;
    expect(await teamStatus(ctx({ now: () => T0 + 126_000 }), {})).toBe(0);
    expect(printed(stdout)).toMatchInlineSnapshot(`
      "server:    https://gantry.example.com
      org:       acme
      user:      octo-dev
      repo:      acme/storefront
      reachable: yes
      cache:     3 open changes, pulled 2 min ago
      "
    `);
  });

  it("--json carries the cache block", async () => {
    await link();
    signIn();
    seed(1, 2);
    stdout.length = 0;
    expect(await teamStatus(ctx({ now: () => T0 }), { json: true, pull: true })).toBe(0);
    expect(JSON.parse(stdout.join("")).cache).toEqual({
      change_sets: 2,
      pulled_at: "2026-11-25T14:00:00.000Z",
      age_s: 0,
      last_error: null,
    });
  });

  it("a failed pull shows the old numbers and puts the error in last_error only", async () => {
    await link();
    signIn();
    seed(1, 2);
    await teamStatus(ctx({ now: () => T0 }), { pull: true });
    stdout.length = 0;
    stderr.length = 0;
    const down: typeof fetch = async (input, init) =>
      String(input).includes("/v1/pull") ? new Response("{}", { status: 500 }) : fetch(input, init);
    expect(await teamStatus(ctx({ now: () => T0 + 60_000, fetch: down }), { json: true, pull: true })).toBe(
      0,
    );
    const { cache } = JSON.parse(stdout.join(""));
    expect(cache).toMatchObject({ change_sets: 2, pulled_at: "2026-11-25T14:00:00.000Z", age_s: 60 });
    expect(cache.last_error).toMatch(/^team_rejected:/);
    expect(stderr.join("")).toBe("");
    stdout.length = 0;
    await teamStatus(ctx({ now: () => T0 + 60_000, fetch: down }), { pull: true });
    expect(printed(stdout)).toContain("cache:     2 open changes, pulled 1 min ago\n");
    expect(stdout.join("")).not.toContain("team_rejected");
  });

  it("formats ages in seconds, minutes, hours and days", () => {
    expect([5, 59, 60, 126, 3599, 3600, 7300, 86_399, 86_400, 200_000].map(formatAge)).toEqual([
      "5 s",
      "59 s",
      "1 min",
      "2 min",
      "59 min",
      "1 h",
      "2 h",
      "23 h",
      "1 d",
      "2 d",
    ]);
  });
});

describe("gantry team logout", () => {
  it("removes the sign-in and then says there is none", async () => {
    await link();
    let first = true;
    await teamLogin(
      ctx({
        sleep: async () => {
          if (first)
            fake.state.approveDevice(
              /([0-9A-F]{4})-([0-9A-F]{4})/.exec(stdout.join(""))?.slice(1, 3).join("") ?? "",
            );
          first = false;
        },
      }),
      {},
    );
    stdout.length = 0;
    expect(await teamLogout(ctx(), {})).toBe(0);
    expect(printed(stdout)).toBe("Signed out of https://gantry.example.com.\n");
    expect(fs.readFileSync(env.GANTRY_CREDENTIALS_FILE ?? "", "utf8")).not.toContain(USER_TOKEN);
    stdout.length = 0;
    expect(await teamLogout(ctx(), {})).toBe(0);
    expect(printed(stdout)).toBe("Not signed in on https://gantry.example.com.\n");
  });
});
