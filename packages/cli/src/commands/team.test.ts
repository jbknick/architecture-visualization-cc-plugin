import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type GantryPaths, resetTeamProtocolCache } from "@gantry/core";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTeam, type TeamContext, teamLink, teamLogin, teamLogout, teamStatus } from "./team.js";

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
  it("lists the four subcommands", () => {
    const program = new Command().name("gantry");
    registerTeam(program);
    const team = program.commands.find((c) => c.name() === "team");
    expect(team?.helpInformation()).toMatchInlineSnapshot(`
      "Usage: gantry team [options] [command]

      Connect this checkout to a team server (sign in, link, check the connection)

      Options:
        -h, --help        display help for command

      Commands:
        login [options]   Sign in to a team server with a code
        link [options]    Say which server and organisation this repo belongs to
        status [options]  Show the server, organisation, user and repo, and whether
                          the server answers
        logout [options]  Remove the stored sign-in for a server
        help [command]    display help for command
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
      .replace("http://127.0.0.1/device", "https://gantry.example.com/device");
    expect(shown).toMatchInlineSnapshot(`
      "Open https://gantry.example.com/device and enter the code:

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
      "
    `);
  });

  it("prints one JSON line with --json", async () => {
    await link();
    signIn();
    stdout.length = 0;
    expect(await teamStatus(ctx(), { json: true })).toBe(0);
    expect(printed(stdout)).toBe(
      '{"server":"https://gantry.example.com","org":"acme","user":"octo-dev","repo":"acme/storefront","reachable":true,"protocol":1}\n',
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

  it("names team_forbidden for an organisation the user is not in", async () => {
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
      protocol: 1,
    });
    expect(fs.existsSync(paths.dataDir)).toBe(false);
    expect(fs.existsSync(env.GANTRY_CREDENTIALS_FILE ?? "")).toBe(false);
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
