import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo, resolvePaths } from "@gantry/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { postToolUse } from "./postToolUse.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFiles } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFiles: (files: Record<string, string>, repo?: string) => Promise<MaterializedFixture>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

// A recipe regex is untrusted input: one that backtracks catastrophically must not hold up the PostToolUse hook.
describe("PostToolUse with a recipe regex that backtracks catastrophically", () => {
  it("re-indexes the edited file, skips the rule with one note and returns quickly", async () => {
    const recipe = {
      version: 1,
      helpers: ["text-rules"],
      rules: [
        {
          id: "bad",
          language: "text",
          files: ["**/*.schema"],
          rule: { regex: "(a+)+$", flags: "gm" },
          emit: { kind: "table", name: "$1" },
          examples: { match: [], noMatch: [] },
        },
      ],
    };
    const fx = await materializeFiles({
      "package.json": JSON.stringify({ name: "app", private: true }),
      "src/a.ts": "export const a = 1;\n",
      "db/big.schema": `${"a".repeat(100_000)}!\n`,
      ".gantry/recipe.json": JSON.stringify(recipe),
    });
    cleanups.push(() => fx.cleanup());
    const data = mkdtempSync(join(tmpdir(), "gantry-hook-regex-"));
    cleanups.push(() => rmSync(data, { recursive: true, force: true }));
    const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      lines.push(String(s));
      return true;
    }) as never);
    await indexRepo(paths, { layer: "main" });
    appendFileSync(join(fx.dir, "src/a.ts"), "export const b = 2;\n");
    lines.length = 0;
    const t0 = performance.now();
    const out = await postToolUse(paths, {
      toolName: "Edit",
      filePath: join(fx.dir, "src/a.ts"),
      sessionId: "s1",
    });
    const ms = performance.now() - t0;
    vi.restoreAllMocks();
    expect(out).toBeUndefined();
    expect(ms).toBeLessThan(1500);
    expect(lines.filter((l) => l.includes("recipe rule bad skipped"))).toEqual([
      "Gantry: recipe rule bad skipped: regex exceeded 100 ms\n",
    ]);
  });
});
