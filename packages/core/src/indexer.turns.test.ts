import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexRepo } from "./indexer.js";
import { resolvePaths } from "./paths/index.js";

// #358: the Go parser's trees are freed by finalizers that Node runs on a turn of the event loop, so a long indexing
// loop must give the loop a turn now and then. 450 files is more than four parse slices (100 files) and two write
// batches (200 files); the old code gave the loop no turn while it parsed and wrote (the file reads before them are
// real I/O and turn the loop on their own, which this test does not count: it counts calls of setImmediate).
const helperPath = "../test/helpers/fixture.js";
const { materializeFiles } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFiles: (
    files: Record<string, string>,
    repo?: string,
  ) => Promise<{ dir: string; cleanup(): Promise<void> }>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0)) await c();
});

describe("indexRepo and the event loop (#358)", () => {
  it("turns the event loop while it parses and writes a large repository", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 450; i++) {
      files[`src/m${i}.ts`] = `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`;
    }
    const fx = await materializeFiles(files, "synthetic");
    cleanups.push(fx.cleanup);
    const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
    cleanups.push(() => rmSync(data, { recursive: true, force: true }));
    const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });

    const spy = vi.spyOn(globalThis, "setImmediate");
    const r = await indexRepo(paths, { layer: "main" });
    expect(r.files).toBeGreaterThanOrEqual(450);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4 + 3);
  });
});
