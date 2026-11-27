import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GantryConfig } from "../config/index.js";
import type { GantryPaths } from "../paths/index.js";
import { writeCredential } from "./credentials.js";
import { resolveTeamTarget } from "./resolve.js";

const paths = { repo: "acme/storefront" } as GantryPaths;
const block = { server: "https://block.example.com", org: "block-org" };
const configWith = (team?: Partial<typeof block>): GantryConfig =>
  (team === undefined
    ? {}
    : { team: { ...team, upload: { descriptions: true, working: false } } }) as unknown as GantryConfig;

let tmp: string;
let credentials: string;
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  GANTRY_CREDENTIALS_FILE: credentials,
  ...extra,
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-resolve-"));
  credentials = path.join(tmp, "credentials.json");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolveTeamTarget", () => {
  it("takes the server and organisation from the team block", () => {
    expect(resolveTeamTarget(paths, configWith(block), env())).toMatchObject({
      server: block.server,
      org: block.org,
      token: null,
    });
  });

  it("lets the environment win over the block", () => {
    const target = resolveTeamTarget(
      paths,
      configWith(block),
      env({ GANTRY_SERVER: "http://127.0.0.1:4000/", GANTRY_ORG: "ci-org", GANTRY_TOKEN: "gct_abc" }),
    );
    expect(target).toMatchObject({ server: "http://127.0.0.1:4000", org: "ci-org", token: "gct_abc" });
  });

  it("builds the client config by replacing the block's server and organisation", () => {
    const target = resolveTeamTarget(paths, configWith(block), env({ GANTRY_ORG: "ci-org" }));
    expect(target?.config.team).toMatchObject({ server: block.server, org: "ci-org" });
    expect(configWith(block).team?.org).toBe("block-org"); // the input is not changed
  });

  it("works from the environment alone, with no block", () => {
    const target = resolveTeamTarget(
      paths,
      configWith(),
      env({ GANTRY_SERVER: "https://gantry.example.com", GANTRY_ORG: "acme", GANTRY_TOKEN: "gct_x" }),
    );
    expect(target).toMatchObject({ server: "https://gantry.example.com", org: "acme", token: "gct_x" });
    expect(target?.config.team).toMatchObject({ server: "https://gantry.example.com", org: "acme" });
  });

  it("is null when the server or the organisation is missing", () => {
    expect(resolveTeamTarget(paths, configWith(), env())).toBeNull();
    expect(resolveTeamTarget(paths, configWith({ server: block.server }), env())).toBeNull();
    expect(resolveTeamTarget(paths, configWith({ org: "acme" }), env())).toBeNull();
    expect(
      resolveTeamTarget(paths, configWith(), env({ GANTRY_SERVER: "https://a.example.com" })),
    ).toBeNull();
    expect(resolveTeamTarget(paths, configWith(), env({ GANTRY_ORG: "acme" }))).toBeNull();
    expect(resolveTeamTarget(paths, configWith(), env({ GANTRY_SERVER: "", GANTRY_ORG: "" }))).toBeNull();
  });

  it("has no token when GANTRY_TOKEN is unset and nobody signed in", () => {
    expect(resolveTeamTarget(paths, configWith(block), env())?.token).toBeNull();
  });

  it("uses the credentials file's token for the server only when GANTRY_TOKEN is unset", () => {
    writeCredential(
      block.server,
      { token: "tok-from-file", user: "octo-dev", expires_at: "2099-01-01T00:00:00.000Z" },
      env(),
    );
    expect(resolveTeamTarget(paths, configWith(block), env())?.token).toBe("tok-from-file");
    expect(resolveTeamTarget(paths, configWith(block), env({ GANTRY_TOKEN: "gct_env" }))?.token).toBe(
      "gct_env",
    );
    // a sign-in for another server is not used
    expect(
      resolveTeamTarget(paths, configWith(block), env({ GANTRY_SERVER: "https://other.example.com" }))?.token,
    ).toBeNull();
  });

  it("does not read the credentials file when GANTRY_TOKEN is set", () => {
    fs.writeFileSync(credentials, "{ this is not json");
    expect(resolveTeamTarget(paths, configWith(block), env({ GANTRY_TOKEN: "gct_env" }))?.token).toBe(
      "gct_env",
    );
  });
});
