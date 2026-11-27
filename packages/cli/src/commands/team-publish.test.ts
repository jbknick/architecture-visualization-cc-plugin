import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type GantryPaths,
  type Group,
  GroupSchema,
  openStore,
  openTeamCache,
  readTeamGroups,
  readTeamViews,
  resetTeamProtocolCache,
  type SavedView,
  SavedViewSchema,
  saveGroup,
  saveView,
} from "@gantry/core";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTeam, type TeamContext } from "./team.js";
import { teamPublish } from "./team-publish.js";

const USER_TOKEN = "tok-user-9f3a";
const REPO = "acme/storefront";

const PAYMENTS: Group = {
  id: "payments",
  name: "Payments",
  selectors: [{ type: "glob", glob: "src/payments/**" }],
  mayUse: ["orders"],
};
const RISK: SavedView = {
  id: "release-risk",
  name: "Release risk",
  spec: { view: "project", level: "files", hidden: [], groups: ["payments"], filters: {} },
};

let tmp: string;
let paths: GantryPaths;
let env: NodeJS.ProcessEnv;
let fake: FakeServer;
let stdout: string[];
let stderr: string[];
let bodies: { method: string; url: string; body: unknown }[];

const makePaths = (): GantryPaths =>
  ({
    root: tmp,
    repo: REPO,
    dataDir: path.join(tmp, "data"),
    dbPath: path.join(tmp, "data", "gantry.db"),
    overlayPath: path.join(tmp, "data", "overlay.db"),
    configPath: path.join(tmp, "data", "config.json"),
    globalConfigPath: path.join(tmp, "global.json"),
  }) as GantryPaths;

/** The context of a command, with a `fetch` that remembers every request body. */
const ctx = (): TeamContext => ({
  paths,
  env,
  out: (t) => stdout.push(t),
  err: (t) => stderr.push(t),
  fetch: async (input, init) => {
    if (init?.method === "PUT" || init?.method === "DELETE")
      bodies.push({
        method: init.method,
        url: String(input),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
    return fetch(input, init);
  },
});

const linkedEnv = (): NodeJS.ProcessEnv => ({
  GANTRY_CREDENTIALS_FILE: path.join(tmp, "credentials.json"),
  GANTRY_SERVER: fake.url,
  GANTRY_ORG: "acme",
  GANTRY_TOKEN: USER_TOKEN,
});

function saveLocal(): void {
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: REPO });
  saveGroup(store, PAYMENTS);
  saveView(store, RISK);
  store.close();
}

function teamState(): { groups: string[]; views: string[] } {
  const cache = openTeamCache(paths, { readonly: true });
  try {
    return { groups: readTeamGroups(cache).map((g) => g.id), views: readTeamViews(cache).map((v) => v.id) };
  } finally {
    cache?.close();
  }
}

const publish = (kind: "view" | "group", id: string, json = false) =>
  teamPublish(ctx(), { action: "publish", kind, id, ...(json ? { json } : {}) });
const unpublish = (kind: "view" | "group", id: string, json = false) =>
  teamPublish(ctx(), { action: "unpublish", kind, id, ...(json ? { json } : {}) });

async function startServer(role: "owner" | "admin" | "member" = "owner"): Promise<void> {
  fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN], repo: REPO, role });
  env = linkedEnv();
}

beforeEach(async () => {
  resetTeamProtocolCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-team-publish-"));
  paths = makePaths();
  fs.mkdirSync(paths.dataDir, { recursive: true });
  stdout = [];
  stderr = [];
  bodies = [];
  await startServer();
  saveLocal();
});
afterEach(async () => {
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gantry team publish", () => {
  it("publishes a group: the line of the UI guide, a PUT body that parses, and the cache holds it", async () => {
    expect(await publish("group", "payments")).toBe(0);
    expect(stdout.join("")).toBe("Published group payments to acme/storefront.\n");
    expect(stderr).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.method).toBe("PUT");
    expect(bodies[0]?.url).toContain("/v1/repos/acme%2Fstorefront/groups/payments");
    expect(GroupSchema.parse(bodies[0]?.body)).toEqual(PAYMENTS);
    expect(teamState()).toEqual({ groups: ["payments"], views: [] });
  });

  it("publishes a view", async () => {
    expect(await publish("view", "release-risk")).toBe(0);
    expect(stdout.join("")).toBe("Published view release-risk to acme/storefront.\n");
    expect(bodies[0]?.url).toContain("/v1/repos/acme%2Fstorefront/views/release-risk");
    expect(SavedViewSchema.parse(bodies[0]?.body)).toEqual(RISK);
    expect(teamState()).toEqual({ groups: [], views: ["release-risk"] });
  });

  it("prints one JSON object with --json", async () => {
    expect(await publish("group", "payments", true)).toBe(0);
    expect(stdout.join("")).toBe('{"kind":"group","id":"payments","published":true}\n');
  });

  it("leaves the local group in place", async () => {
    await publish("group", "payments");
    const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: REPO });
    try {
      expect(store.db.prepare("SELECT id FROM overlay.groups").all()).toEqual([{ id: "payments" }]);
    } finally {
      store.close();
    }
  });
});

describe("gantry team unpublish", () => {
  it("removes a group and a view, and the cache no longer holds them", async () => {
    await publish("group", "payments");
    await publish("view", "release-risk");
    stdout.length = 0;
    expect(await unpublish("view", "release-risk")).toBe(0);
    expect(stdout.join("")).toBe("Removed view release-risk from acme/storefront.\n");
    expect(teamState()).toEqual({ groups: ["payments"], views: [] });
    stdout.length = 0;
    expect(await unpublish("group", "payments", true)).toBe(0);
    expect(stdout.join("")).toBe('{"kind":"group","id":"payments","published":false}\n');
    expect(teamState()).toEqual({ groups: [], views: [] });
    expect(bodies.filter((b) => b.method === "DELETE").map((b) => b.body)).toEqual([undefined, undefined]);
  });

  it("says so, exit 1, when the team has no such group", async () => {
    expect(await unpublish("group", "payments")).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toBe("Not removed: the team has no group payments.\n");
  });
});

describe("refusals and errors", () => {
  it("prints the server's message and exits 1 when a member removes a team group", async () => {
    await fake.close();
    await startServer("member");
    await publish("group", "payments");
    stdout.length = 0;
    stderr.length = 0;
    expect(await unpublish("group", "payments")).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toBe("Not removed: only an owner or admin may delete a group\n");
    expect(teamState().groups).toEqual(["payments"]);
  });

  it("prints the server's message for a refused publish", async () => {
    await fake.close();
    fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN], repo: REPO });
    env = { ...linkedEnv(), GANTRY_TOKEN: "gct_fake" }; // a CI token cannot use a user route
    expect(await publish("group", "payments")).toBe(1);
    expect(stderr.join("")).toBe("Not published: this token cannot use this route\n");
  });

  it("exits 1 with `not linked to a team` when there is no team config", async () => {
    env = { GANTRY_CREDENTIALS_FILE: path.join(tmp, "credentials.json") };
    expect(await publish("group", "payments")).toBe(1);
    expect(stderr.join("")).toBe("not linked to a team\n");
    expect(stdout).toEqual([]);
    expect(bodies).toEqual([]);
  });

  it("exits 1 with `not linked to a team` when there are no credentials", async () => {
    env = {
      GANTRY_CREDENTIALS_FILE: path.join(tmp, "credentials.json"),
      GANTRY_SERVER: fake.url,
      GANTRY_ORG: "acme",
    };
    expect(await unpublish("view", "release-risk")).toBe(1);
    expect(stderr.join("")).toBe("not linked to a team\n");
  });

  it("exits 1 with `not linked to a team` when no organisation is named", async () => {
    env = { ...linkedEnv(), GANTRY_ORG: "" };
    expect(await publish("group", "payments")).toBe(1);
    expect(stderr.join("")).toBe("not linked to a team\n");
  });

  it("exits 2 when the id is not a local view or group, and sends nothing", async () => {
    expect(await publish("group", "nope")).toBe(2);
    expect(await publish("view", "payments")).toBe(2); // a group's id is not a view's
    expect(await unpublish("group", "release-risk")).toBe(2);
    expect(stderr.join("")).toBe(
      "gantry: no local group with the id nope\ngantry: no local view with the id payments\ngantry: no local group with the id release-risk\n",
    );
    expect(bodies).toEqual([]);
  });

  it("exits 2, and creates nothing, when the repo has no index", async () => {
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
    expect(await publish("group", "payments")).toBe(2);
    expect(fs.existsSync(paths.dataDir)).toBe(false);
  });

  it("does not look at the team's groups: a team-only id is not a local one", async () => {
    fake.state.groups.set(REPO, new Map([["shipping", { ...PAYMENTS, id: "shipping" }]]));
    expect(await unpublish("group", "shipping")).toBe(2);
  });

  it("exits 1 and names the problem when the server cannot be reached", async () => {
    const url = fake.url;
    await fake.close();
    env = { ...linkedEnv(), GANTRY_SERVER: url };
    expect(await publish("group", "payments")).toBe(1);
    expect(stderr.join("").startsWith("Not published: Cannot reach ")).toBe(true);
    fake = await startFakeServer();
  });
});

describe("registration", () => {
  it("adds publish and unpublish, each with view and group, each with --json", () => {
    const program = new Command().name("gantry");
    registerTeam(program);
    const team = program.commands.find((c) => c.name() === "team");
    for (const action of ["publish", "unpublish"]) {
      const sub = team?.commands.find((c) => c.name() === action);
      expect(sub?.commands.map((c) => c.name())).toEqual(["view", "group"]);
      for (const kind of sub?.commands ?? []) expect(kind.options.map((o) => o.long)).toEqual(["--json"]);
    }
  });
});
