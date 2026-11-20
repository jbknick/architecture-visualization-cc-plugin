import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heal, indexRepo, openStore, readOverlay, resolvePaths, setLabel } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "./entry.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

const DATE = "packages/utils/src/date.ts";
const OLD = `sym:pnpm-turbo:${DATE}#formatRelativeDate`;
const NEW = "sym:pnpm-turbo:packages/utils/src/dates.ts#formatRelativeDate";

/** No hook re-attaches (spec section 11): a hook that heals leaves overlay.db byte-identical; `gantry heal` re-attaches. */
describe("hooks never re-attach overlay entries", () => {
  for (const hook of ["session-start", "post-checkout", "post-merge", "post-rewrite", "pre-push"]) {
    it(hook, async () => {
      const fx = await materializeFixture("pnpm-turbo");
      fixtures.push(fx);
      const data = mkdtempSync(join(tmpdir(), "gantry-hook-reattach-"));
      dataDirs.push(data);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
      const paths = resolvePaths(fx.dir, env);
      await indexRepo(paths, { layer: "main" });
      const open = () => openStore(paths.dbPath, { overlayPath: paths.overlayPath });
      let store = open();
      setLabel(store, { nodeId: OLD, text: "Relative date" });
      store.close();

      fx.git(["mv", DATE, "packages/utils/src/dates.ts"]);
      const index = join(fx.dir, "packages/utils/src/index.ts");
      writeFileSync(index, readFileSync(index, "utf8").replace('"./date"', '"./dates"'));
      fx.git(["add", "-A", "-f"]);
      fx.git(["commit", "-q", "-m", "move"]);

      const sha = () => createHash("sha256").update(readFileSync(paths.overlayPath)).digest("hex");
      const before = sha();
      await runHook(hook, [], fx.dir, env, () => undefined);
      expect(sha()).toBe(before);
      store = open();
      expect(readOverlay(store).labels).toEqual([{ nodeId: OLD, text: "Relative date" }]);
      store.close();

      // The index did move to the new commit, and an explicit heal (which is what `gantry heal` runs) re-attaches.
      await heal(paths, { from: "HEAD~1", reattach: true });
      store = open();
      expect(readOverlay(store).labels).toEqual([{ nodeId: NEW, text: "Relative date" }]);
      store.close();
    });
  }
});
