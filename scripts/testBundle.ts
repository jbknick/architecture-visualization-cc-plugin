// Bundles the real plugin entries from source into a temp plugin home, for the tests that spawn them. It uses the
// entries, externals and prompts copy of tsup.config.ts, so a test runs what the build ships, but needs no
// plugin/dist: it works on a fresh checkout and always runs the current source.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { copyPrompts, entry, external } from "../tsup.config.js";

const root = join(import.meta.dirname, "..");

export interface TestBundle {
  /** A plugin home: `bin/gantry`, `.claude-plugin/plugin.json` and `dist/<name>.js` for each requested entry. */
  home: string;
  cleanup(): void;
}

export async function bundlePlugin(names: (keyof typeof entry)[]): Promise<TestBundle> {
  const home = mkdtempSync(join(tmpdir(), "gantry-test-bundle-"));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  try {
    mkdirSync(join(home, ".claude-plugin"));
    mkdirSync(join(home, "bin"));
    copyFileSync(join(root, "plugin/.claude-plugin/plugin.json"), join(home, ".claude-plugin/plugin.json"));
    copyFileSync(join(root, "plugin/bin/gantry"), join(home, "bin/gantry"));
    symlinkSync(join(root, "node_modules"), join(home, "node_modules"), "dir");
    await build({
      entry: Object.fromEntries(names.map((n) => [n, join(root, entry[n])])),
      outDir: join(home, "dist"),
      format: ["esm"],
      platform: "node",
      target: "node22",
      external,
      // Workspace packages resolve to their source, by exact specifier only: a subpath such as
      // @gantry/protocol/testing keeps resolving through the package's own exports.
      esbuildPlugins: [
        {
          name: "gantry-workspace-source",
          setup(b) {
            b.onResolve({ filter: /^@gantry\/(core|protocol)$/ }, (a) => ({
              path: join(root, "packages", a.path.slice("@gantry/".length), "src/index.ts"),
            }));
          },
        },
      ],
      silent: true,
      dts: false,
      config: false,
    });
    copyPrompts(join(home, "dist"), root);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { home, cleanup };
}
