import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, resetStaleStore, SCHEMA_VERSION, StaleStoreError } from "./index.js";

let dir: string;
let dbPath: string;
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gantry-stale-"));
  dbPath = join(dir, "gantry.db");
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function build(version: number): void {
  const s = openStore(dbPath);
  s.close();
  const raw = new Database(dbPath);
  raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
  raw.close();
}

const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

describe("a store from another version of Gantry", () => {
  it("is the current version when new", () => {
    expect(SCHEMA_VERSION).toBe(8);
    const s = openStore(dbPath);
    expect(s.getMeta("schema_version")).toBe("8");
    s.close();
  });

  it("(a) is refused by openStore with StaleStoreError", () => {
    build(6);
    let caught: unknown;
    try {
      openStore(dbPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaleStoreError);
    expect(caught).toMatchObject({ found: 6, expected: 8, dbPath });
    // Refusing it changes nothing.
    const raw = new Database(dbPath, { readonly: true });
    expect(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "6" });
    raw.close();
  });

  it("(b) is deleted by resetStaleStore, with a message naming both versions", () => {
    build(6);
    writeFileSync(`${dbPath}-wal`, "");
    writeFileSync(`${dbPath}-shm`, "");
    writeFileSync(join(dir, "parse-cache.db"), "");
    writeFileSync(join(dir, "config.json"), "{}");
    expect(resetStaleStore({ dbPath })).toEqual({ reset: true, found: 6 });
    for (const f of ["gantry.db", "gantry.db-wal", "gantry.db-shm", "parse-cache.db"])
      expect(existsSync(join(dir, f))).toBe(false);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(stderr.join("")).toBe(
      "gantry: the index was built by an older version of Gantry (schema 6, now 8); rebuilding it\n",
    );
    openStore(dbPath).close(); // a new store opens
    expect(resetStaleStore({ dbPath })).toEqual({ reset: false });
  });

  it("(c) leaves a current store untouched", () => {
    build(SCHEMA_VERSION);
    const before = sha(dbPath);
    expect(resetStaleStore({ dbPath })).toEqual({ reset: false });
    expect(sha(dbPath)).toBe(before);
    expect(stderr).toEqual([]);
  });

  it("(d) resets a newer store too", () => {
    build(9);
    expect(() => openStore(dbPath)).toThrow(StaleStoreError);
    expect(resetStaleStore({ dbPath })).toEqual({ reset: true, found: 9 });
    expect(existsSync(dbPath)).toBe(false);
    expect(stderr.join("")).toContain("(schema 9, now 8)");
  });

  it("(e) resets a current store whose repo name changed, and leaves one with the same name", () => {
    const s = openStore(dbPath);
    s.setMeta("repo", "a/b");
    s.close();
    expect(resetStaleStore({ dbPath, repo: "a/b" })).toEqual({ reset: false });
    expect(existsSync(dbPath)).toBe(true);
    expect(resetStaleStore({ dbPath, repo: "c/d" })).toEqual({ reset: true, found: SCHEMA_VERSION });
    expect(existsSync(dbPath)).toBe(false);
    expect(stderr.join("")).toContain("(a/b -> c/d)");
  });

  it("does nothing when there is no store", () => {
    expect(resetStaleStore({ dbPath })).toEqual({ reset: false });
    expect(existsSync(dbPath)).toBe(false);
  });
});
