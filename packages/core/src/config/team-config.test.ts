import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GantryError } from "../errors.js";
import type { GantryPaths } from "../paths/index.js";
import { isTeamServerUrl, loadConfig, saveProjectConfig } from "./index.js";
import { resolveTeamSettings } from "./team.js";

let tmp: string;
let p: GantryPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-team-config-"));
  p = {
    root: tmp,
    repo: "repo",
    workspace: { file: null, repos: [{ name: "repo", root: tmp }] },
    worktreeHash: "0".repeat(16),
    dataDir: path.join(tmp, "data"),
    dbPath: path.join(tmp, "data", "gantry.db"),
    overlayPath: path.join(tmp, "data", "overlay.db"),
    configPath: path.join(tmp, "data", "config.json"),
    catalogDir: path.join(tmp, "data", "catalog"),
    logsDir: path.join(tmp, "data", "logs"),
    globalConfigPath: path.join(tmp, "global.json"),
    shimPath: path.join(tmp, "gantry"),
  };
  fs.mkdirSync(p.dataDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const writeProject = (value: unknown): void => fs.writeFileSync(p.configPath, JSON.stringify(value));

describe("the team block", () => {
  it("is absent by default, so there is no team", () => {
    const config = loadConfig(p);
    expect(config.team).toBeUndefined();
    expect("team" in config).toBe(false);
    expect(resolveTeamSettings(config, {})).toEqual({ upload: { descriptions: true, working: false } });
  });

  it("accepts a valid block and fills the upload defaults", () => {
    writeProject({ team: { server: "https://gantry.example.com", org: "acme" } });
    expect(loadConfig(p).team).toEqual({
      server: "https://gantry.example.com",
      org: "acme",
      upload: { descriptions: true, working: false },
    });
  });

  it("keeps the upload choices it is given", () => {
    writeProject({
      team: {
        server: "https://gantry.example.com",
        org: "acme",
        upload: { descriptions: false, working: true },
      },
    });
    expect(loadConfig(p).team?.upload).toEqual({ descriptions: false, working: true });
  });

  it("allows http for localhost and 127.0.0.1 only", () => {
    expect(isTeamServerUrl("http://localhost:8787")).toBe(true);
    expect(isTeamServerUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isTeamServerUrl("https://gantry.example.com")).toBe(true);
    expect(isTeamServerUrl("http://gantry.example.com")).toBe(false);
    expect(isTeamServerUrl("ftp://gantry.example.com")).toBe(false);
    expect(isTeamServerUrl("gantry.example.com")).toBe(false);
  });

  it.each([
    ["an http server that is not local", { server: "http://gantry.example.com", org: "acme" }],
    ["a server that is not a URL", { server: "gantry", org: "acme" }],
    ["an empty org", { server: "https://gantry.example.com", org: "" }],
    ["a missing org", { server: "https://gantry.example.com" }],
    ["a missing server", { org: "acme" }],
    [
      "an upload choice that is not a boolean",
      { server: "https://g.example.com", org: "a", upload: { working: 1 } },
    ],
  ])("skips a project file with %s, with a warning", (_name, team) => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeProject({ team });
    expect(loadConfig(p).team).toBeUndefined();
    expect(stderr.mock.calls.join("")).toContain("ignoring invalid config");
  });

  it("is written by the config writer and refuses an invalid patch", () => {
    saveProjectConfig(p, { team: { server: "https://gantry.example.com", org: "acme" } });
    expect(JSON.parse(fs.readFileSync(p.configPath, "utf8"))).toEqual({
      team: { server: "https://gantry.example.com", org: "acme" },
    });
    expect(() => saveProjectConfig(p, { team: { server: "http://gantry.example.com" } })).toThrow(
      /Invalid config/,
    );
  });
});

describe("environment overrides", () => {
  const file = { server: "https://file.example.com", org: "file-org" };
  const config = () => {
    writeProject({ team: file });
    return loadConfig(p);
  };

  it("uses the file when no variable is set", () => {
    expect(resolveTeamSettings(config(), {})).toEqual({
      ...file,
      upload: { descriptions: true, working: false },
    });
  });

  it("GANTRY_SERVER overrides team.server", () => {
    const s = resolveTeamSettings(config(), { GANTRY_SERVER: "https://env.example.com/" });
    expect(s.server).toBe("https://env.example.com");
    expect(s.org).toBe("file-org");
  });

  it("GANTRY_ORG overrides team.org", () => {
    const s = resolveTeamSettings(config(), { GANTRY_ORG: "env-org" });
    expect(s.org).toBe("env-org");
    expect(s.server).toBe("https://file.example.com");
  });

  it("GANTRY_TOKEN is the token, and there is none without it", () => {
    expect(resolveTeamSettings(config(), { GANTRY_TOKEN: "gct_abc" }).token).toBe("gct_abc");
    expect(resolveTeamSettings(config(), {}).token).toBeUndefined();
  });

  it("needs no team block at all", () => {
    const s = resolveTeamSettings(loadConfig(p), {
      GANTRY_SERVER: "http://127.0.0.1:9",
      GANTRY_ORG: "acme",
      GANTRY_TOKEN: "t",
    });
    expect(s).toEqual({
      server: "http://127.0.0.1:9",
      org: "acme",
      token: "t",
      upload: { descriptions: true, working: false },
    });
  });

  it("ignores an empty variable", () => {
    expect(resolveTeamSettings(config(), { GANTRY_SERVER: "", GANTRY_ORG: " " }).org).toBe("file-org");
  });

  it("refuses a GANTRY_SERVER that is not allowed", () => {
    let thrown: unknown;
    try {
      resolveTeamSettings(config(), { GANTRY_SERVER: "http://evil.example.com" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GantryError);
    expect((thrown as GantryError).code).toBe("team_config");
  });
});
