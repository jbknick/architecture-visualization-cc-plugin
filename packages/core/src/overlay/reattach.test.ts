import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heal } from "../heal/index.js";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import { listUnresolved } from "./reattach.js";
import { readOverlay, saveGroup, saveView, setHidden, setLabel } from "./repo.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
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
const sym = (path: string, name: string) => `sym:pnpm-turbo:${path}#${name}`;

async function setup(): Promise<{ fx: MaterializedFixture; paths: GantryPaths }> {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  const data = mkdtempSync(join(tmpdir(), "gantry-reattach-data-"));
  dataDirs.push(data);
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  return { fx, paths };
}

const read = (fx: MaterializedFixture, rel: string) => readFileSync(join(fx.dir, rel), "utf8");
const write = (fx: MaterializedFixture, rel: string, text: string) => writeFileSync(join(fx.dir, rel), text);
function commit(fx: MaterializedFixture, msg: string): void {
  fx.git(["add", "-A", "-f"]);
  fx.git(["commit", "-q", "-m", msg]);
}

/** Runs `fn` on a fresh connection and closes it. */
function withStore<T>(paths: GantryPaths, fn: (store: ReturnType<typeof openStore>) => T): T {
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** Renames `formatRelativeDate` to `formatRelative` in its file and in the barrel, and commits. */
function renameFormatRelative(fx: MaterializedFixture): void {
  write(fx, DATE, read(fx, DATE).replace("formatRelativeDate", "formatRelative"));
  write(
    fx,
    "packages/utils/src/index.ts",
    read(fx, "packages/utils/src/index.ts").replace("formatRelativeDate", "formatRelative"),
  );
  commit(fx, "rename");
}

describe("reattachOverlay (run by heal)", () => {
  it("a label follows its function through a file move", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    withStore(paths, (s) => setLabel(s, { nodeId: from, text: "Relative date" }));

    fx.git(["mv", DATE, "packages/utils/src/dates.ts"]);
    write(
      fx,
      "packages/utils/src/index.ts",
      read(fx, "packages/utils/src/index.ts").replace('"./date"', '"./dates"'),
    );
    commit(fx, "move");
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      const to = sym("packages/utils/src/dates.ts", "formatRelativeDate");
      expect(readOverlay(s).labels).toEqual([{ nodeId: to, text: "Relative date" }]);
      expect(listUnresolved(s)).toEqual([]);
      expect(s.db.prepare("SELECT node_id FROM overlay.anchors").all()).toEqual([{ node_id: to }]);
    });
  });

  it("a hidden id, a group id and a saved view's hidden id follow the move too", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    const ids = [{ type: "ids" as const, ids: [from] }];
    withStore(paths, (s) => {
      setHidden(s, ids);
      saveGroup(s, { id: "dates", name: "Dates", selectors: ids, mayUse: null });
      saveView(s, {
        id: "v",
        name: "V",
        spec: { view: "project-map", hidden: ids, groups: [], filters: {} },
      });
    });
    fx.git(["mv", DATE, "packages/utils/src/dates.ts"]);
    write(
      fx,
      "packages/utils/src/index.ts",
      read(fx, "packages/utils/src/index.ts").replace('"./date"', '"./dates"'),
    );
    commit(fx, "move");
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      const to = sym("packages/utils/src/dates.ts", "formatRelativeDate");
      const o = readOverlay(s);
      expect(o.hidden).toEqual([{ type: "ids", ids: [to] }]);
      expect(o.groups[0]?.selectors).toEqual([{ type: "ids", ids: [to] }]);
      expect(o.views[0]?.spec.hidden).toEqual([{ type: "ids", ids: [to] }]);
      expect(listUnresolved(s)).toEqual([]);
    });
  });

  it("a label follows a function renamed in place (same body, new name)", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    withStore(paths, (s) => setLabel(s, { nodeId: from, text: "Relative date" }));

    renameFormatRelative(fx);
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      const to = sym(DATE, "formatRelative");
      expect(readOverlay(s).labels).toEqual([{ nodeId: to, text: "Relative date" }]);
      expect(listUnresolved(s)).toEqual([]);
      expect(s.db.prepare("SELECT node_id FROM overlay.anchors").all()).toEqual([{ node_id: to }]);
      expect(s.db.prepare("SELECT node_id FROM overlay.anchor_renames").all()).toEqual([{ node_id: to }]);
    });
  });

  it("a hidden id, a group id and a saved view's hidden id follow a rename in place", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    const ids = [{ type: "ids" as const, ids: [from] }];
    withStore(paths, (s) => {
      setHidden(s, ids);
      saveGroup(s, { id: "dates", name: "Dates", selectors: ids, mayUse: null });
      saveView(s, {
        id: "v",
        name: "V",
        spec: { view: "project-map", hidden: ids, groups: [], filters: {} },
      });
    });
    renameFormatRelative(fx);
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      const to = [{ type: "ids", ids: [sym(DATE, "formatRelative")] }];
      const o = readOverlay(s);
      expect(o.hidden).toEqual(to);
      expect(o.groups[0]?.selectors).toEqual(to);
      expect(o.views[0]?.spec.hidden).toEqual(to);
      expect(listUnresolved(s)).toEqual([]);
    });
  });

  it("a rename in place with a changed body stays as it was and is listed as gone", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    withStore(paths, (s) => setLabel(s, { nodeId: from, text: "Relative date" }));

    renameFormatRelative(fx);
    write(fx, DATE, read(fx, DATE).replace('"just now"', '"now"'));
    commit(fx, "change body");
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      expect(readOverlay(s).labels).toEqual([{ nodeId: from, text: "Relative date" }]);
      expect(listUnresolved(s)).toEqual([
        { entry: "label", id: from, text: "Relative date", reason: "gone" },
      ]);
    });
  });

  it("a function renamed to a hook (same body, other kind family) stays as it was and is listed as gone", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    withStore(paths, (s) => {
      setLabel(s, { nodeId: from, text: "Relative date" });
      expect(s.db.prepare("SELECT family FROM overlay.anchor_families").all()).toEqual([
        { family: "function" },
      ]);
    });

    // `use[A-Z]…` makes the symbol a hook: the same body in the same file, but not the same kind family.
    write(fx, DATE, read(fx, DATE).replace("formatRelativeDate", "useRelativeDate"));
    write(
      fx,
      "packages/utils/src/index.ts",
      read(fx, "packages/utils/src/index.ts").replace("formatRelativeDate", "useRelativeDate"),
    );
    commit(fx, "rename to a hook");
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      const hook = s.getSymbol(sym(DATE, "useRelativeDate"));
      expect(hook?.kind).toBe("hook");
      expect(hook?.renamedHash).toBe(
        (s.db.prepare("SELECT renamed_hash AS h FROM overlay.anchor_renames").get() as { h: string }).h,
      );
      expect(readOverlay(s).labels).toEqual([{ nodeId: from, text: "Relative date" }]);
      expect(listUnresolved(s)).toEqual([
        { entry: "label", id: from, text: "Relative date", reason: "gone" },
      ]);
    });
  });

  it("an anchor with no recorded kind family is never re-attached by renamedHash", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    withStore(paths, (s) => {
      setLabel(s, { nodeId: from, text: "Relative date" });
      s.db.prepare("DELETE FROM overlay.anchor_families").run();
    });
    renameFormatRelative(fx);
    await heal(paths, { reattach: true });
    withStore(paths, (s) => {
      expect(readOverlay(s).labels).toEqual([{ nodeId: from, text: "Relative date" }]);
      expect(listUnresolved(s)).toEqual([
        { entry: "label", id: from, text: "Relative date", reason: "gone" },
      ]);
    });
  });

  it("two renamed-hash candidates are listed as ambiguous and nothing is guessed", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    withStore(paths, (s) => setLabel(s, { nodeId: from, text: "Relative date" }));

    // Rename it in place and add a second copy under another name: two symbols share the renamedHash.
    const text = read(fx, DATE).replace(/formatRelativeDate/g, "formatRelative");
    write(fx, DATE, `${text}\n${text.replace("formatRelative", "formatRelativeCopy")}`);
    write(
      fx,
      "packages/utils/src/index.ts",
      read(fx, "packages/utils/src/index.ts").replace("formatRelativeDate", "formatRelative"),
    );
    commit(fx, "rename and copy");
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      expect(readOverlay(s).labels).toEqual([{ nodeId: from, text: "Relative date" }]);
      expect(listUnresolved(s)).toEqual([
        { entry: "label", id: from, text: "Relative date", reason: "ambiguous" },
      ]);
    });
  });

  it("a heal without reattach (the hooks) does not follow a rename in place", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    withStore(paths, (s) => setLabel(s, { nodeId: from, text: "Relative date" }));
    renameFormatRelative(fx);
    await heal(paths);
    withStore(paths, (s) => expect(readOverlay(s).labels).toEqual([{ nodeId: from, text: "Relative date" }]));
  });

  it("a moved function whose body changed stays as it was and is listed as gone", async () => {
    const { fx, paths } = await setup();
    const from = sym(DATE, "formatRelativeDate");
    withStore(paths, (s) => setLabel(s, { nodeId: from, text: "Relative date" }));

    fx.git(["mv", DATE, "packages/utils/src/dates.ts"]);
    write(
      fx,
      "packages/utils/src/dates.ts",
      read(fx, "packages/utils/src/dates.ts").replace('"just now"', '"now"'),
    );
    write(
      fx,
      "packages/utils/src/index.ts",
      read(fx, "packages/utils/src/index.ts").replace('"./date"', '"./dates"'),
    );
    commit(fx, "move and change");
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      expect(readOverlay(s).labels).toEqual([{ nodeId: from, text: "Relative date" }]);
      expect(listUnresolved(s)).toEqual([
        { entry: "label", id: from, text: "Relative date", reason: "gone" },
      ]);
    });
  });

  it("a hash that matches several symbols is listed as ambiguous and nothing is guessed", async () => {
    const { fx, paths } = await setup();
    const utilsSlug = "packages/utils/src/slug.ts";
    const webSlug = "apps/web/src/lib/slug.ts";
    // Three copies of slugify with one body: the utils one (labelled), the web one, and a new one next to it.
    const body = read(fx, webSlug);
    write(fx, "apps/web/src/lib/slug2.ts", body);
    write(fx, utilsSlug, body); // the internal helper becomes the same exported text as the web copy
    commit(fx, "copies");
    await heal(paths, { reattach: true });
    const from = sym(utilsSlug, "slugify");
    withStore(paths, (s) => {
      setLabel(s, { nodeId: from, text: "Slugs" });
      expect(readOverlay(s).labels).toHaveLength(1);
    });

    fx.git(["rm", "-q", utilsSlug]);
    write(fx, "packages/utils/src/index.ts", read(fx, "packages/utils/src/index.ts"));
    commit(fx, "delete utils copy");
    await heal(paths, { reattach: true });

    withStore(paths, (s) => {
      expect(readOverlay(s).labels).toEqual([{ nodeId: from, text: "Slugs" }]);
      expect(listUnresolved(s)).toEqual([{ entry: "label", id: from, text: "Slugs", reason: "ambiguous" }]);
    });
  });

  it("a heal with no moved symbol leaves overlay.db byte-identical", async () => {
    const { fx, paths } = await setup();
    withStore(paths, (s) => setLabel(s, { nodeId: sym(DATE, "formatRelativeDate"), text: "Relative date" }));
    const sha = () => createHash("sha256").update(readFileSync(paths.overlayPath)).digest("hex");
    await heal(paths, { reattach: true }); // nothing to do yet; checkpoint any WAL state first
    withStore(paths, () => undefined);
    const before = sha();

    write(
      fx,
      "packages/utils/src/time.ts",
      `${read(fx, "packages/utils/src/time.ts")}\nexport const extra = 1;\n`,
    );
    commit(fx, "unrelated change");
    await heal(paths, { reattach: true });

    expect(sha()).toBe(before);
  });
});
