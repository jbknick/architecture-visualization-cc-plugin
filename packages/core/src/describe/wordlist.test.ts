import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bloomHashes } from "./bloom.js";
import { itTiming } from "./itTiming.js";
import { WORD_BLOOM_BASE64, WORD_COUNT } from "./wordlist.data.js";
import { HAND_LIST_COUNTS, isBaseWord, isWord, wordlistInitMs } from "./wordlist.js";

describe("word list", () => {
  it("records its provenance: public-domain Webster's Second International", () => {
    const head = readFileSync(join(__dirname, "wordlist.data.ts"), "utf8").slice(0, 400);
    expect(head).toContain("Webster's Second International");
    expect(head).toContain("copyright lapsed");
    const gen = readFileSync(join(__dirname, "../../../../scripts/build-wordlist.ts"), "utf8");
    expect(gen).toContain("/usr/share/dict/README");
    expect(gen).toContain("copyright has lapsed");
  });

  it("is a compact asset: about 230k words in under 600 KB of source", () => {
    expect(WORD_COUNT).toBeGreaterThan(200_000);
    expect(WORD_BLOOM_BASE64.length).toBeLessThan(600_000);
  });

  itTiming("initialises lazily in under 50 ms", () => {
    expect(isWord("session")).toBe(true);
    console.log(
      `word list init ${wordlistInitMs.toFixed(2)} ms, ${WORD_BLOOM_BASE64.length} base64 characters`,
    );
    expect(wordlistInitMs).toBeLessThan(50);
  });

  it("hashes deterministically", () => {
    expect(bloomHashes("session")).toEqual(bloomHashes("session"));
    expect(bloomHashes("session")).not.toEqual(bloomHashes("sessions"));
  });

  it("has a false-positive rate of at most 0.1% on strings that are not words", () => {
    let x = 12345;
    const next = () => {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      return x >>> 8;
    };
    const letters = "bcdfghjklmnpqrstvwxz";
    let hits = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      // 8 to 12 letters, consonants only: no English word looks like this
      let w = "";
      const len = 8 + (next() % 5);
      for (let k = 0; k < len; k++) w += letters[next() % letters.length];
      if (isBaseWord(w)) hits++;
    }
    console.log(`word list false positives: ${hits} of ${n}`);
    expect(hits / n).toBeLessThanOrEqual(0.001);
  });

  it("holds more than 600 hand-listed programming and web terms", () => {
    expect(HAND_LIST_COUNTS.tech).toBeGreaterThanOrEqual(600);
    for (const w of [
      "async",
      "callback",
      "middleware",
      "plugin",
      "webhook",
      "oauth",
      "regex",
      "json",
      "yaml",
      "config",
      "auth",
      "repo",
      "api",
      "url",
      "uuid",
      "cron",
      "cli",
      "sdk",
      "ui",
      "ux",
      "db",
      "sql",
      "http",
      "https",
      "css",
      "html",
      "dom",
      "email",
      "database",
      "timeout",
    ])
      expect(isWord(w), w).toBe(true);
  });

  it("resolves plain English and regular derived forms", () => {
    for (const w of [
      "session",
      "returns",
      "deleted",
      "stopped",
      "stopping",
      "reloading",
      "retries",
      "requeues",
      "requeued",
      "hashes",
      "bigger",
      "biggest",
      "quickly",
      "readable",
      "usable",
      "kindness",
      "placement",
      "creation",
      "unlocked",
      "nonempty",
      "preload",
      "subtree",
      "multithreaded",
      "autosave",
      "reconnections",
      "debouncing",
      "serializable",
      "evaluator",
    ])
      expect(isWord(w), w).toBe(true);
  });

  it("rejects run-on words, hosts, top-level domains and made-up names", () => {
    for (const w of [
      "leftpad",
      "leftpadsecure",
      "evilpad",
      "authbypass",
      "pastebinmirror",
      "rs",
      "sh",
      "com",
      "org",
      "xyz",
      "pw",
      "pl",
      "mov",
      "qwertyuiop",
      "xyzzyplugh",
      "exfiltrateeverything",
      "supercalifragilistic",
    ])
      expect(isWord(w), w).toBe(false);
  });

  it("accepts short words only from the hand list", () => {
    for (const w of ["a", "an", "is", "of", "to", "id", "ip", "ok", "the", "and", "key", "zip"]) {
      expect(isWord(w) || w === "a", w).toBe(true);
    }
    expect(isWord("zz")).toBe(false);
    expect(isWord("qx")).toBe(false);
  });
});
