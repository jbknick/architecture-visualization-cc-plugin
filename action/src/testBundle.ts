// Bundles the real entry points (the CLI and the Action scripts) from source into a temp plugin home, so an e2e test
// never depends on a built plugin/dist: it works on a fresh checkout and always runs the current source.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";

const root = join(import.meta.dirname, "../..");

export interface TestBundle {
  /** The bundled plugin home: `bin/gantry`, `dist/cli.js` and the requested Action scripts, as in `plugin/`. */
  home: string;
  cleanup(): void;
}

/** Entry names: `cli`, `action` (action/src/main.ts) and `upload` (action/src/upload-main.ts). */
const ENTRIES = {
  cli: "packages/cli/src/main.ts",
  action: "action/src/main.ts",
  upload: "action/src/upload-main.ts",
} as const;

export async function bundlePlugin(names: (keyof typeof ENTRIES)[]): Promise<TestBundle> {
  const home = mkdtempSync(join(tmpdir(), "gantry-e2e-bundle-"));
  mkdirSync(join(home, ".claude-plugin"));
  mkdirSync(join(home, "bin"));
  copyFileSync(join(root, "plugin/.claude-plugin/plugin.json"), join(home, ".claude-plugin/plugin.json"));
  copyFileSync(join(root, "plugin/bin/gantry"), join(home, "bin/gantry"));
  symlinkSync(join(root, "node_modules"), join(home, "node_modules"), "dir");
  await build({
    entry: Object.fromEntries(names.map((n) => [n, join(root, ENTRIES[n])])),
    outDir: join(home, "dist"),
    format: ["esm"],
    platform: "node",
    target: "node22",
    external: [
      "better-sqlite3",
      "sqlite-vec",
      "oxc-parser",
      "oxc-resolver",
      "@huggingface/transformers",
      "onnxruntime-node",
    ],
    esbuildOptions(o) {
      o.alias = {
        "@gantry/core": join(root, "packages/core/src/index.ts"),
        "@gantry/protocol": join(root, "packages/protocol/src/index.ts"),
      };
    },
    silent: true,
    dts: false,
    config: false,
  });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
