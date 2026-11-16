import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentKey } from "../describe/factsheet.js";
import { storeDescriptions } from "../describe/store.js";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { ftsSearch } from "../search/fts.js";
import { openStore } from "../store/index.js";
import { heal, refreshWorking, staleFiles } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git repo of `n` files with two functions each, indexed (main layer at HEAD). */
async function repoOf(n: number): Promise<{ root: string; paths: GantryPaths; file: (k: number) => string }> {
  const tmp = mkdtempSync(join(tmpdir(), "gantry-fts-"));
  dirs.push(tmp);
  const root = join(tmp, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fts-repo", version: "0.0.0" }));
  const file = (k: number) => `src/m${String(k).padStart(3, "0")}.ts`;
  for (let k = 0; k < n; k++) {
    writeFileSync(
      join(root, file(k)),
      `export function alpha${k}(x: number): number {\n  return x + ${k};\n}\n\nexport function beta${k}(s: string): string {\n  return s.repeat(${k + 1});\n}\n`,
    );
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Gantry Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const paths = resolvePaths(root, { HOME: join(tmp, "home"), CLAUDE_PLUGIN_DATA: join(tmp, "data") });
  await heal(paths);
  return { root, paths, file };
}

interface FtsRow {
  rowid: number;
  symbol_id: string;
  name_tokens: string;
  path: string;
}

function ftsState(paths: GantryPaths) {
  const s = openStore(paths.dbPath);
  try {
    const rows = s.db
      .prepare("SELECT rowid, symbol_id, name_tokens, path FROM fts_symbols ORDER BY rowid")
      .all() as FtsRow[];
    const anyLayer = new Set(
      (s.db.prepare("SELECT DISTINCT id FROM symbols").all() as { id: string }[]).map((r) => r.id),
    );
    const effective = s.effectiveSymbols().map((x) => x.id);
    return { rows, anyLayer, effective };
  } finally {
    s.close();
  }
}

describe("targeted re-index keeps fts_symbols exact (rowid deletes, more than one write batch)", () => {
  it("no duplicates, no orphans, every effective symbol searchable, other files' rows untouched", async () => {
    const N = 260; // more than TX_BATCH (200) changed files in one refreshWorking
    const { root, paths, file } = await repoOf(N + 20);
    const before = ftsState(paths);
    const untouched = (r: FtsRow) => Number(/m(\d+)\.ts$/.exec(r.path)?.[1]) >= N;
    const untouchedBefore = before.rows.filter(untouched);
    expect(untouchedBefore).toHaveLength(40);

    for (let k = 0; k < N; k++) {
      const p = join(root, file(k));
      const text = readFileSync(p, "utf8");
      if (k % 4 === 0)
        writeFileSync(p, text.replace(`return x + ${k};`, `return x * ${k + 2};`)); // edit body
      else if (k % 4 === 1)
        writeFileSync(p, text.replace(`beta${k}`, `gamma${k}`)); // rename
      else if (k % 4 === 2)
        writeFileSync(p, text.slice(0, text.indexOf("\n\nexport function beta"))); // remove
      else writeFileSync(p, `${text}\nexport function extra${k}(): number {\n  return ${k};\n}\n`); // add
    }
    unlinkSync(join(root, file(N - 1)));
    await refreshWorking(paths);

    // A PostToolUse-style single-file re-index in between, then more edits and another refresh.
    const one = join(root, file(1));
    writeFileSync(one, readFileSync(one, "utf8").replace("gamma1", "delta1"));
    await indexRepo(paths, { layer: "working", files: [file(1)] });
    await new Promise((r) => setTimeout(r, 20));
    for (let k = 4; k < N; k += 8) {
      const p = join(root, file(k));
      writeFileSync(p, readFileSync(p, "utf8").replace(`alpha${k}`, `omega${k}`));
    }
    await refreshWorking(paths);

    const after = ftsState(paths);
    const ids = after.rows.map((r) => r.symbol_id);
    expect(new Set(ids).size, "duplicate symbol_id rows").toBe(ids.length);
    expect(
      ids.filter((id) => !after.anyLayer.has(id)),
      "orphan rows",
    ).toEqual([]);
    expect(
      after.effective.filter((id) => !ids.includes(id)),
      "effective symbols without a row",
    ).toEqual([]);
    expect(ids).toContain(`sym:${file(1)}#delta1`);
    expect(ids).toContain(`sym:${file(4)}#omega4`);
    expect(ids).toContain(`sym:${file(3)}#extra3`);
    // Files nobody touched keep their exact rows (same rowid, same content).
    expect(after.rows.filter(untouched)).toEqual(untouchedBefore);

    // Reverting everything drops the working rows: the rows of working-only symbols (renamed, added) go with them.
    execFileSync("git", ["checkout", "--", "."], { cwd: root, stdio: "ignore" });
    await refreshWorking(paths);
    const reverted = ftsState(paths);
    const back = reverted.rows.map((r) => r.symbol_id);
    expect(new Set(back).size).toBe(back.length);
    expect(
      back.filter((id) => !reverted.anyLayer.has(id)),
      "orphan rows after revert",
    ).toEqual([]);
    expect([...back].sort()).toEqual([...before.rows.map((r) => r.symbol_id)].sort());
  }, 120_000);
});

describe("a revert restores the search rows of main-layer symbols (#165)", () => {
  const found = (paths: GantryPaths, q: string): string[] => {
    const s = openStore(paths.dbPath);
    try {
      return ftsSearch(s, q, { descriptions: true }).map((h) => h.id);
    } finally {
      s.close();
    }
  };
  const describeEffective = (paths: GantryPaths, id: string, behavior: string, term: string): void => {
    const s = openStore(paths.dbPath);
    try {
      const sym = s.effectiveSymbols().find((x) => x.id === id);
      if (!sym) throw new Error(`no effective symbol ${id}`);
      storeDescriptions(s, [
        {
          contentKey: contentKey(sym.exactHash),
          model: null,
          description: { behavior, searchTerms: [term], nameFits: true, suggestedName: `${term}Name` },
        },
      ]);
    } finally {
      s.close();
    }
  };
  const revert = async (root: string, paths: GantryPaths): Promise<void> => {
    execFileSync("git", ["checkout", "--", "."], { cwd: root, stdio: "ignore" });
    await refreshWorking(paths);
  };

  it("a renamed function is found by its original name only after the revert", async () => {
    const { root, paths, file } = await repoOf(2);
    const id = `sym:${file(0)}#alpha0`;
    const p = join(root, file(0));
    writeFileSync(p, readFileSync(p, "utf8").replace("alpha0", "renamedzulu"));
    await refreshWorking(paths);
    expect(found(paths, "renamedzulu")).toEqual([`sym:${file(0)}#renamedzulu`]);
    expect(found(paths, "alpha0")).not.toContain(id);

    await revert(root, paths);
    expect(found(paths, "alpha0")).toEqual([id]);
    expect(found(paths, "renamedzulu")).toEqual([]);
  });

  it("a changed body and description leave the main description in the row after the revert", async () => {
    const { root, paths, file } = await repoOf(2);
    const id = `sym:${file(0)}#alpha0`;
    describeEffective(paths, id, "adds the index to a number", "quuxmain");
    expect(found(paths, "quuxmain")).toEqual([id]);

    const p = join(root, file(0));
    writeFileSync(p, readFileSync(p, "utf8").replace("return x + 0;", "return x * 7;"));
    await refreshWorking(paths);
    describeEffective(paths, id, "multiplies a number by seven", "zebrawork");
    expect(found(paths, "zebrawork")).toEqual([id]);

    await revert(root, paths);
    expect(found(paths, "zebrawork")).toEqual([]);
    expect(found(paths, "quuxmain")).toEqual([id]);
    expect(found(paths, "alpha0")).toEqual([id]);
  });
});

describe("a revert clears working description text from main symbols that have no description (#165)", () => {
  it("search no longer finds the working description terms", async () => {
    const { root, paths, file } = await repoOf(2);
    const id = `sym:${file(0)}#alpha0`;
    const p = join(root, file(0));
    writeFileSync(p, readFileSync(p, "utf8").replace("return x + 0;", "return x * 7;"));
    await refreshWorking(paths);
    const s = openStore(paths.dbPath);
    try {
      const sym = s.effectiveSymbols().find((x) => x.id === id);
      storeDescriptions(s, [
        {
          contentKey: contentKey(sym?.exactHash ?? ""),
          model: null,
          description: { behavior: "multiplies by seven", searchTerms: ["zebrawork"], nameFits: true },
        },
      ]);
      expect(ftsSearch(s, "zebrawork", { descriptions: true }).map((h) => h.id)).toEqual([id]);
    } finally {
      s.close();
    }
    execFileSync("git", ["checkout", "--", "."], { cwd: root, stdio: "ignore" });
    await refreshWorking(paths);
    const t = openStore(paths.dbPath);
    try {
      expect(ftsSearch(t, "zebrawork", { descriptions: true })).toEqual([]);
      expect(ftsSearch(t, "sevens multiplies", { descriptions: true })).toEqual([]);
      expect(ftsSearch(t, "alpha0", { descriptions: true }).map((h) => h.id)).toEqual([id]);
    } finally {
      t.close();
    }
  });
});

describe("the stale check takes no optional git locks", () => {
  it("passes --no-optional-locks to every git call and leaves no index.lock", async () => {
    const { root, paths, file } = await repoOf(3);
    writeFileSync(join(root, file(0)), "export const changed = 1;\n");
    const bin = mkdtempSync(join(tmpdir(), "gantry-gitlog-"));
    dirs.push(bin);
    const log = join(bin, "calls.log");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const s = openStore(paths.dbPath);
    try {
      expect(staleFiles(paths, s).files).toEqual([file(0)]);
    } finally {
      s.close();
      process.env.PATH = oldPath;
    }
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.some((c) => c.includes(" status "))).toBe(true);
    for (const c of calls) expect(c.startsWith("--no-optional-locks "), c).toBe(true);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
  });
});
