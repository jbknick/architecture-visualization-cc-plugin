import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIELD_SINCE, PROTOCOL_VERSION, supports } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GantryConfig } from "../config/index.js";
import { GantryError } from "../errors.js";
import type { GantryPaths } from "../paths/index.js";
import { resetTeamProtocolCache, teamClient } from "./client.js";
import { writeCredential } from "./credentials.js";

const USER_TOKEN = "tok-user-9f3a";
const paths = { repo: "acme/storefront" } as GantryPaths;
const configFor = (server: string, org = "acme"): GantryConfig =>
  ({ team: { server, org, upload: { descriptions: true, working: false } } }) as unknown as GantryConfig;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** The global fetch, remembering each request. */
function recorder(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });
      return fetch(input, init);
    },
  };
}

let fake: FakeServer;
let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  resetTeamProtocolCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-team-client-"));
  env = { GANTRY_CREDENTIALS_FILE: path.join(tmp, "credentials.json") };
  fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN] });
});
afterEach(async () => {
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function failureOf(p: Promise<unknown>): Promise<GantryError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(GantryError);
    return err as GantryError;
  }
  throw new Error("expected a GantryError");
}

describe("request headers", () => {
  it("sends the bearer token, the protocol version and X-Gantry-Org for a user token", async () => {
    const rec = recorder();
    const client = teamClient(paths, configFor(fake.url), { env, fetch: rec.fetch, token: USER_TOKEN });
    const who = await client.whoami({ repo: "acme/storefront" });
    expect(who).toMatchObject({ kind: "user", user: "octo-dev", org: "acme" });
    expect(rec.calls[0]?.headers).toMatchObject({
      Authorization: `Bearer ${USER_TOKEN}`,
      "X-Gantry-Protocol": "1",
      "X-Gantry-Org": "acme",
    });
  });

  it("sends no X-Gantry-Org for a gct_ token, or when org is null", async () => {
    const rec = recorder();
    const ci = teamClient(paths, configFor(fake.url), { env, fetch: rec.fetch, token: "gct_fake" });
    expect((await ci.whoami()).kind).toBe("ci");
    const bare = teamClient(paths, configFor(fake.url), {
      env,
      fetch: rec.fetch,
      token: USER_TOKEN,
      org: null,
    });
    expect(await bare.whoami()).toMatchObject({ kind: "user", user: "octo-dev", repo_connected: false });
    for (const c of rec.calls) expect(c.headers["X-Gantry-Org"]).toBeUndefined();
  });

  it("takes the token from GANTRY_TOKEN and then does not read the credentials file", async () => {
    writeCredential(fake.url, { token: "tok-from-file", user: "x", expires_at: "2030-01-01T00:00:00Z" }, env);
    const rec = recorder();
    const client = teamClient(paths, configFor(fake.url), {
      env: { ...env, GANTRY_TOKEN: USER_TOKEN },
      fetch: rec.fetch,
    });
    await client.whoami();
    expect(rec.calls[0]?.headers.Authorization).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("takes a signed-in user's token from the credentials file", async () => {
    writeCredential(
      fake.url,
      { token: USER_TOKEN, user: "octo-dev", expires_at: "2030-01-01T00:00:00Z" },
      env,
    );
    const client = teamClient(paths, configFor(fake.url), { env });
    expect(client.hasToken).toBe(true);
    expect((await client.whoami()).user).toBe("octo-dev");
  });

  it("has no token with no sign-in, and the server then answers 401", async () => {
    const client = teamClient(paths, configFor(fake.url), { env });
    expect(client.hasToken).toBe(false);
    expect((await failureOf(client.whoami())).code).toBe("team_unauthorized");
  });

  it("needs a server", () => {
    expect(() => teamClient(paths, {} as GantryConfig, { env })).toThrow(/No server/);
  });
});

describe("paths", () => {
  it("URL-encodes every path parameter", async () => {
    const rec = recorder();
    const client = teamClient(paths, configFor(fake.url), { env, fetch: rec.fetch, token: USER_TOKEN });
    await client.deleteGroup("acme/shop", "cs:pr:acme/shop#12");
    const last = rec.calls.at(-1);
    expect(last?.method).toBe("DELETE");
    expect(new URL(last?.url ?? "").pathname).toBe("/v1/repos/acme%2Fshop/groups/cs%3Apr%3Aacme%2Fshop%2312");
  });

  it("puts the query on the URL", async () => {
    const rec = recorder();
    const client = teamClient(paths, configFor(fake.url), { env, fetch: rec.fetch, token: USER_TOKEN });
    await client.whoami({ repo: "acme/storefront" });
    expect(new URL(rec.calls[0]?.url ?? "").search).toBe("?repo=acme%2Fstorefront");
  });
});

describe("failures", () => {
  it("maps 401 to team_unauthorized", async () => {
    const client = teamClient(paths, configFor(fake.url), { env, token: "nope" });
    expect((await failureOf(client.whoami())).code).toBe("team_unauthorized");
  });

  it("maps 403 to team_forbidden", async () => {
    const client = teamClient(paths, configFor(fake.url, "other-org"), { env, token: USER_TOKEN });
    expect((await failureOf(client.whoami())).code).toBe("team_forbidden");
  });

  it("maps any other error answer to team_rejected", async () => {
    const client = teamClient(paths, configFor(fake.url), { env, token: USER_TOKEN });
    const err = await failureOf(
      client.putGroup("acme/storefront", "g", {
        id: "other",
        name: "G",
        selectors: [{ type: "glob", glob: "a/**" }],
      }),
    );
    expect(err.code).toBe("team_rejected");
  });

  it("maps 400 protocol_version to team_protocol", async () => {
    const answer: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "protocol_version", message: "too new" }), { status: 400 });
    const client = teamClient(paths, configFor(fake.url), { env, token: USER_TOKEN, fetch: answer });
    expect((await failureOf(client.whoami())).code).toBe("team_protocol");
  });

  it("maps a refused connection to team_unreachable", async () => {
    await fake.close();
    const client = teamClient(paths, configFor(fake.url), { env, token: USER_TOKEN });
    expect((await failureOf(client.whoami())).code).toBe("team_unreachable");
    fake = await startFakeServer();
  });

  it("maps a timeout to team_unreachable", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const client = teamClient(paths, configFor(fake.url), {
      env,
      token: USER_TOKEN,
      fetch: hang,
      timeoutMs: 20,
    });
    expect((await failureOf(client.whoami())).code).toBe("team_unreachable");
  });

  it("maps an answer that does not match the schema to team_rejected", async () => {
    const odd: typeof fetch = async () => new Response(JSON.stringify({ hello: 1 }), { status: 200 });
    const client = teamClient(paths, configFor(fake.url), { env, token: USER_TOKEN, fetch: odd });
    expect((await failureOf(client.whoami())).code).toBe("team_rejected");
  });

  it("never puts the token in an error", async () => {
    const client = teamClient(paths, configFor(fake.url), { env, token: "tok-leak-check" });
    expect((await failureOf(client.whoami())).message).not.toContain("tok-leak-check");
  });
});

describe("tolerant responses", () => {
  it("ignores a response field it does not know", async () => {
    const newer: typeof fetch = async () =>
      new Response(
        JSON.stringify({ kind: "user", user: "maya", repo_connected: true, protocol: 1, future: [1] }),
        {
          status: 200,
        },
      );
    const client = teamClient(paths, configFor(fake.url), { env, token: USER_TOKEN, fetch: newer });
    const who = await client.whoami();
    expect(who).toEqual({ kind: "user", user: "maya", repo_connected: true, protocol: 1 });
  });
});

describe("protocol version", () => {
  it("knows nothing at first: serverProtocol() is 1", () => {
    expect(teamClient(paths, configFor(fake.url), { env, token: USER_TOKEN }).serverProtocol()).toBe(1);
  });

  it("makes exactly one whoami call on ready(), caches it for the process, and makes none on a second call", async () => {
    const newest = await startFakeServer({ tokens: [USER_TOKEN], protocolMax: PROTOCOL_VERSION });
    try {
      const rec = recorder();
      const client = teamClient(paths, configFor(newest.url), { env, fetch: rec.fetch, token: USER_TOKEN });
      await client.ready();
      expect(rec.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /v1/whoami"]);
      expect(client.serverProtocol()).toBe(PROTOCOL_VERSION);
      await client.ready();
      expect(rec.calls).toHaveLength(1);
      // The cache is shared by every client in the process.
      const other = teamClient(paths, configFor(newest.url), { env, fetch: rec.fetch, token: USER_TOKEN });
      await other.ready();
      expect(rec.calls).toHaveLength(1);
      expect(other.serverProtocol()).toBe(PROTOCOL_VERSION);
    } finally {
      await newest.close();
    }
  });

  it("makes one whoami call for ready() calls that overlap", async () => {
    const rec = recorder();
    const client = teamClient(paths, configFor(fake.url), { env, fetch: rec.fetch, token: USER_TOKEN });
    await Promise.all([client.ready(), client.ready(), client.ready()]);
    expect(rec.calls).toHaveLength(1);
  });

  it("makes every typed method wait for ready() first, but not whoami", async () => {
    const rec = recorder();
    const client = teamClient(paths, configFor(fake.url), { env, fetch: rec.fetch, token: USER_TOKEN });
    await client.uploadStatus("missing").catch(() => undefined);
    expect(rec.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/whoami", "/v1/uploads/missing"]);
    resetTeamProtocolCache();
    const rec2 = recorder();
    await teamClient(paths, configFor(fake.url), { env, fetch: rec2.fetch, token: USER_TOKEN }).whoami();
    expect(rec2.calls).toHaveLength(1);
  });

  it("lowers serverProtocol() when a later response names a lower maximum", async () => {
    let max = "3";
    const answer: typeof fetch = async () =>
      new Response(
        JSON.stringify({ kind: "user", user: "m", repo_connected: false, protocol: Number(max) }),
        {
          status: 200,
          headers: { "X-Gantry-Protocol-Max": max },
        },
      );
    const client = teamClient(paths, configFor(fake.url), { env, token: USER_TOKEN, fetch: answer });
    await client.ready();
    expect(client.serverProtocol()).toBe(3);
    max = "1";
    await client.whoami();
    expect(client.serverProtocol()).toBe(1);
  });

  it("sends the lower of its own version and the server's maximum", async () => {
    const rec = recorder();
    const client = teamClient(paths, configFor(fake.url), { env, fetch: rec.fetch, token: USER_TOKEN });
    await client.ready();
    await client.whoami();
    expect(rec.calls.map((c) => c.headers["X-Gantry-Protocol"])).toEqual([
      "1",
      String(Math.min(PROTOCOL_VERSION, 1)),
    ]);
  });

  it("sends no field a version 1 server does not know (supports gating)", async () => {
    const old = await startFakeServer({ tokens: [USER_TOKEN], protocolMax: 1 });
    FIELD_SINCE["future.field"] = 2;
    try {
      const client = teamClient(paths, configFor(old.url), { env, token: USER_TOKEN });
      await client.ready();
      expect(client.serverProtocol()).toBe(1);
      expect(supports(client.serverProtocol(), "future.field")).toBe(false);
      expect(supports(client.serverProtocol(), "descriptions")).toBe(true);
      expect(supports(2, "future.field")).toBe(true);
      expect(supports(undefined, "future.field")).toBe(false);
    } finally {
      delete FIELD_SINCE["future.field"];
      await old.close();
    }
  });
});

describe("device sign-in", () => {
  it("starts a sign-in and polls until it is approved", async () => {
    const client = teamClient(paths, configFor(fake.url), { env, org: null, token: null });
    const code = await client.deviceCode();
    expect(code.user_code).toMatch(/^[0-9A-F]{8}$/);
    expect(code.interval).toBe(5);
    expect(code.expires_in).toBe(900);
    expect(await client.deviceToken(code.device_code)).toEqual({ status: "pending" });
    expect(fake.state.approveDevice(code.user_code)).toBe(true);
    const done = await client.deviceToken(code.device_code);
    expect(done).toMatchObject({ status: "approved", accessToken: USER_TOKEN });
  });

  it("refuses an unknown device code", async () => {
    const client = teamClient(paths, configFor(fake.url), { env, org: null, token: null });
    expect((await failureOf(client.deviceToken("nope"))).code).toBe("team_rejected");
  });
});
