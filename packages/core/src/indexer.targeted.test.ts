import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "./indexer.js";
import { type GantryPaths, resolvePaths } from "./paths/index.js";
import { openStore } from "./store/index.js";

// Issue #360: a targeted re-index (the PostToolUse hook) took 2.4 s on a 6,033-file repo because it re-resolved the
// edges of every file. Its cost has to follow the edited files, not the size of the repository.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FILES = 300;
const mod = (i: number): string => `src/f${i}.ts`;

/** A chain of FILES modules (each imports the one before it), a barrel over f5 and a user of the barrel. */
function makeRepo(): { dir: string; paths: GantryPaths } {
  // The repo name is the folder name, so each repo gets the same name under a folder of its own.
  const parent = mkdtempSync(join(tmpdir(), "gantry-targeted-"));
  const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
  dirs.push(parent, data);
  const dir = join(parent, "synth");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "synth" }));
  writeFileSync(join(dir, mod(0)), "export const v0 = (): number => 0;\n");
  for (let i = 1; i < FILES; i++) {
    writeFileSync(
      join(dir, mod(i)),
      `import { v${i - 1} } from "./f${i - 1}";\nexport const v${i} = (): number => v${i - 1}() + 1;\n`,
    );
  }
  writeFileSync(join(dir, "src/barrel.ts"), 'export * from "./f5";\n');
  writeFileSync(
    join(dir, "src/user.ts"),
    'import { v5 } from "./barrel";\nexport const useIt = (): number => v5();\n',
  );
  // Imports a file that does not exist yet.
  writeFileSync(
    join(dir, "src/waiting.ts"),
    'import { fresh } from "./fresh";\nexport const wait = (): number => fresh();\n',
  );
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  return { dir, paths: resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data }) };
}

function effective(paths: GantryPaths): string {
  const s = openStore(paths.dbPath);
  try {
    return JSON.stringify(s.effectiveEdges());
  } finally {
    s.close();
  }
}

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

describe("targeted re-index follows the edited files (#360)", () => {
  it("resolves the specifiers of the edited file and its importers, not of every file", async () => {
    const { dir, paths } = makeRepo();
    const full = await indexRepo(paths, { layer: "main" });
    // Every file's specifiers were resolved by the full run.
    expect(sum(full.specifierCounts)).toBeGreaterThan(FILES);

    writeFileSync(
      join(dir, mod(200)),
      'import { v199 } from "./f199";\nexport const v200 = (): number => v199() + 2;\n',
    );
    const r = await indexRepo(paths, { layer: "working", files: [mod(200)] });
    // f200 and its importer f201 only; the old run resolved all 300 files.
    expect(sum(r.specifierCounts)).toBeLessThanOrEqual(10);
    expect(r.files).toBe(1);
  });

  it("gives the same effective edges as indexing the edited tree from scratch", async () => {
    const edited = makeRepo();
    await indexRepo(edited.paths, { layer: "main" });
    // A rename that a barrel passes on to its user, and a file that something was waiting for.
    writeFileSync(
      join(edited.dir, mod(5)),
      'import { v4 } from "./f4";\nexport const w5 = (): number => v4();\n',
    );
    writeFileSync(join(edited.dir, "src/fresh.ts"), "export const fresh = (): number => 1;\n");
    const r = await indexRepo(edited.paths, { layer: "working", files: [mod(5), "src/fresh.ts"] });
    expect(r.files).toBe(2);

    const scratch = makeRepo();
    writeFileSync(
      join(scratch.dir, mod(5)),
      'import { v4 } from "./f4";\nexport const w5 = (): number => v4();\n',
    );
    writeFileSync(join(scratch.dir, "src/fresh.ts"), "export const fresh = (): number => 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: scratch.dir });
    await indexRepo(scratch.paths, { layer: "main" });

    const norm = (s: string): string => s.split(edited.dir).join("R").split(scratch.dir).join("R");
    const a = JSON.parse(norm(effective(edited.paths))) as { src: string; dst: string; kind: string }[];
    const b = JSON.parse(norm(effective(scratch.paths))) as { src: string; dst: string; kind: string }[];
    const key = (e: { src: string; dst: string; kind: string }): string => `${e.src}|${e.dst}|${e.kind}`;
    expect(a.map(key).sort()).toEqual(b.map(key).sort());
    // The barrel's user lost its call into the renamed function, and the waiting file reaches the new one.
    expect(a.some((e) => e.kind === "calls" && e.src.endsWith("src/user.ts#useIt"))).toBe(false);
    expect(a.some((e) => e.kind === "imports" && e.dst.endsWith("src/fresh.ts"))).toBe(true);
  });
});
