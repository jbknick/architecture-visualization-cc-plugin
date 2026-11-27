import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, readCredential, removeCredential, writeCredential } from "./credentials.js";

let tmp: string;
let file: string;
let env: NodeJS.ProcessEnv;
const entry = { token: "tok-secret-1", user: "maya", expires_at: "2030-01-01T00:00:00.000Z" };
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-credentials-"));
  file = path.join(tmp, "dot-gantry", "credentials.json");
  env = { GANTRY_CREDENTIALS_FILE: file };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("credentials file", () => {
  it("defaults to ~/.gantry/credentials.json and can be moved with GANTRY_CREDENTIALS_FILE", () => {
    expect(credentialsPath({ HOME: "/home/maya" })).toBe("/home/maya/.gantry/credentials.json");
    expect(credentialsPath(env)).toBe(file);
  });

  it("tightens an existing default ~/.gantry directory to 700, but leaves a directory the user named alone", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".gantry"), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(home, ".gantry"), 0o755);
    writeCredential("https://a.example.com", entry, { HOME: home });
    expect(mode(path.join(home, ".gantry"))).toBe(0o700);
    expect(mode(path.join(home, ".gantry", "credentials.json"))).toBe(0o600);

    const own = path.join(tmp, "own");
    fs.mkdirSync(own, { mode: 0o755 });
    fs.chmodSync(own, 0o755);
    writeCredential("https://a.example.com", entry, { GANTRY_CREDENTIALS_FILE: path.join(own, "c.json") });
    expect(mode(own)).toBe(0o755);
    expect(mode(path.join(own, "c.json"))).toBe(0o600);
  });

  it("reads nothing when there is no file", () => {
    expect(readCredential("https://gantry.example.com", env)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes the file with mode 600 in a directory of mode 700", () => {
    writeCredential("https://gantry.example.com", entry, env);
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      servers: { "https://gantry.example.com": entry },
    });
  });

  it("reads an entry back, with or without a trailing slash on the server", () => {
    writeCredential("https://gantry.example.com/", entry, env);
    expect(readCredential("https://gantry.example.com", env)).toEqual(entry);
    expect(readCredential("https://gantry.example.com/", env)).toEqual(entry);
    expect(readCredential("https://other.example.com", env)).toBeUndefined();
  });

  it("writes atomically: no temporary file is left behind and a replaced entry is whole", () => {
    writeCredential("https://a.example.com", entry, env);
    writeCredential("https://a.example.com", { ...entry, user: "sam" }, env);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["credentials.json"]);
    expect(readCredential("https://a.example.com", env)?.user).toBe("sam");
    expect(mode(file)).toBe(0o600);
  });

  it("keeps the other servers' entries when one is written or removed", () => {
    writeCredential("https://a.example.com", entry, env);
    writeCredential("https://b.example.com", { ...entry, token: "tok-secret-2" }, env);
    expect(removeCredential("https://a.example.com", env)).toBe(true);
    expect(readCredential("https://a.example.com", env)).toBeUndefined();
    expect(readCredential("https://b.example.com", env)?.token).toBe("tok-secret-2");
    expect(fs.readFileSync(file, "utf8")).not.toContain("tok-secret-1");
    expect(mode(file)).toBe(0o600);
  });

  it("removing an entry that is not there leaves the file alone and says so", () => {
    expect(removeCredential("https://a.example.com", env)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("treats a file that is not valid as no sign-in, and replaces it on the next write", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(readCredential("https://a.example.com", env)).toBeUndefined();
    writeCredential("https://a.example.com", entry, env);
    expect(readCredential("https://a.example.com", env)).toEqual(entry);
  });
});
