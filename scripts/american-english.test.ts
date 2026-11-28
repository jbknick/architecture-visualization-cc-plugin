import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { convert, filesInScope, findWords, read, scanFile, WORDS } from "./american-english.js";

// Allow-list: one entry per line, `<path> <word> | <reason>`; `*` as the word allows every converted word in that file.
// The path is exact, or ends in `/` to cover every file under it.
const allowFile = resolve(import.meta.dirname, "american-english.allow.txt");

function loadAllow(): { path: string; word: string; reason: string }[] {
  return readFileSync(allowFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => {
      const [left = "", reason = ""] = l.split(" | ");
      const [path = "", word = "*"] = left.trim().split(/\s+/);
      return { path, word: word.toLowerCase(), reason: reason.trim() };
    });
}

describe("American English", () => {
  it("every allow-list entry has a reason and points at a file in scope", () => {
    const files = new Set(filesInScope());
    for (const e of loadAllow()) {
      expect(e.reason, `${e.path} ${e.word}`).not.toBe("");
      const hit = e.path.endsWith("/") ? [...files].some((f) => f.startsWith(e.path)) : files.has(e.path);
      expect(hit, `allow-list entry ${e.path} matches no file in scope`).toBe(true);
    }
  });

  it("text a person reads uses American spelling", () => {
    const allow = loadAllow();
    const allowed = (file: string, word: string): boolean =>
      allow.some(
        (e) =>
          (e.path.endsWith("/") ? file.startsWith(e.path) : file === e.path) &&
          (e.word === "*" || e.word === word.toLowerCase()),
      );
    const found: string[] = [];
    for (const file of filesInScope()) {
      const text = read(file);
      for (const hit of scanFile(file, text)) {
        if (allowed(file, hit.word)) continue;
        const line = text.slice(0, hit.index).split("\n").length;
        found.push(`${file}:${line}: ${hit.word} -> ${convert(hit.word)}`);
      }
    }
    expect(
      found,
      "British spelling found; use American English or add an allow-list entry with a reason",
    ).toEqual([]);
  });

  it("converts word forms and keeps their case", () => {
    expect(convert("Organisation and colours, centred; cancelled; for ever")).toBe(
      "Organization and colors, centered; canceled; forever",
    );
    expect(convert("ORGANISATION")).toBe("ORGANIZATION");
  });

  it("leaves words that only look British alone", () => {
    for (const w of [
      "raise",
      "promise",
      "exercise",
      "advise",
      "precise",
      "otherwise",
      "enterprise",
      "devise",
      "supervise",
      "noise",
      "concise",
      "expertise",
      "franchise",
      "comprise",
      "surprise",
      "revise",
      "premise",
      "analysis",
      "metropolis",
      "emphasis",
      "model",
      "label",
      "center",
      "color",
    ]) {
      expect(findWords(w), w).toEqual([]);
    }
  });

  it("leaves the GitHub Actions function cancelled() alone", () => {
    expect(findWords("if: ${{ !cancelled() }}")).toEqual([]);
    expect(findWords("the job was cancelled")).toHaveLength(1);
  });

  it("maps every word to a different spelling", () => {
    for (const [b, a] of Object.entries(WORDS)) expect(a, b).not.toBe(b);
  });
});
