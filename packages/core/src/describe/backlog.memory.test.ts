import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import { syncBacklog } from "./backlog.js";

// Memory regression for #358: `gantry init` on a repository with thousands of Go files ran out of memory. The tree-sitter
// trees of the Go parser (`@ast-grep/napi`) are freed by finalizers that run on a turn of the event loop, so a
// synchronous loop that parses many Go files keeps every tree. `syncBacklog` parsed every Go file with a one-statement
// function (Go has no description templates, so the parse was wasted), which took grafana from 0.15 GiB to 5.3 GiB
// inside that one call. These tests use a synthetic repository, not grafana.

const goParses = vi.hoisted(() => ({ n: 0 }));
vi.mock("../lang/engine/grammar.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lang/engine/grammar.js")>();
  return {
    ...mod,
    parseTree: (pack: Parameters<typeof mod.parseTree>[0], source: string) => {
      goParses.n++;
      return mod.parseTree(pack, source);
    },
  };
});

const helperPath = "../../test/helpers/fixture.js";
const { materializeFiles } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFiles: (
    files: Record<string, string>,
    repo?: string,
  ) => Promise<{ dir: string; cleanup(): Promise<void> }>;
};

const cleanups: (() => Promise<void>)[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const c of cleanups.splice(0)) await c();
});

/** `packages` Go packages of `perPackage` files, each file `funcs` one-statement functions with different bodies. */
function goRepo(packages: number, perPackage: number, funcs: number): Record<string, string> {
  const files: Record<string, string> = { "go.mod": "module example.com/synthetic\n\ngo 1.22\n" };
  let k = 0;
  for (let p = 0; p < packages; p++) {
    for (let f = 0; f < perPackage; f++) {
      const body: string[] = [`package p${p}\n`];
      for (let i = 0; i < funcs; i++) {
        body.push(
          `// F${f}x${i} scales its argument.\nfunc F${f}x${i}(x int) int {\n\treturn x*${++k} + ${p}\n}\n`,
        );
      }
      files[`pkg/p${p}/f${f}.go`] = body.join("\n");
    }
  }
  return files;
}

async function indexed(files: Record<string, string>): Promise<GantryPaths> {
  const fx = await materializeFiles(files, "synthetic");
  cleanups.push(fx.cleanup);
  const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
  dataDirs.push(data);
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  return paths;
}

describe("syncBacklog and Go files (#358)", () => {
  it("does not parse Go files to look for description templates", async () => {
    const paths = await indexed(goRepo(3, 4, 5));
    const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
    try {
      const before = goParses.n;
      const r = syncBacklog(store, { root: paths.root });
      expect(r.enqueued).toBe(60); // every Go function still lands in the backlog
      expect(goParses.n - before).toBe(0);
    } finally {
      store.close();
    }
  });

  it("holds less than 150 MiB of native memory for 1,200 Go files", async () => {
    const paths = await indexed(goRepo(40, 30, 12));
    const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
    try {
      // Let the finalizers of the index run, so the baseline holds no trees from the index.
      for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
      const before = process.memoryUsage().rss;
      syncBacklog(store, { root: paths.root });
      const grown = (process.memoryUsage().rss - before) / 1048576;
      // Parsing all 1,200 files grew the process by about 480 MiB before the fix, and by about 36 MiB after it.
      expect(grown).toBeLessThan(150);
    } finally {
      store.close();
    }
  }, 120_000);
});
