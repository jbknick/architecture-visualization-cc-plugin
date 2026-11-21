import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import { matchAny, matchSelector, type SelectableNode } from "./select.js";

const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<{ dir: string; cleanup(): Promise<void> }>;
};

let store: Store;
let nodes: SelectableNode[];
let cleanup: () => Promise<void>;
let data: string;

beforeAll(async () => {
  const fx = await materializeFixture("pnpm-turbo");
  cleanup = fx.cleanup;
  data = mkdtempSync(join(tmpdir(), "gantry-select-"));
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  mkdirSync(paths.dataDir, { recursive: true });
  await indexRepo(paths, { layer: "main" });
  store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  nodes = [
    ...store
      .listWorkspaces()
      .map((w): SelectableNode => ({ id: w.id, kind: "workspace", path: w.dir, workspace: w.id })),
    ...store.effectiveFiles().map(
      (f): SelectableNode => ({
        id: f.id,
        kind: "file",
        path: f.path,
        ...(f.workspaceId ? { workspace: f.workspaceId } : {}),
      }),
    ),
    ...store.effectiveSymbols().map((s): SelectableNode => {
      const f = store.effectiveFile(s.fileId);
      return {
        id: s.id,
        kind: s.kind,
        ...(f ? { path: f.path } : {}),
        ...(f?.workspaceId ? { workspace: f.workspaceId } : {}),
      };
    }),
  ];
});
afterAll(async () => {
  store.close();
  rmSync(data, { recursive: true, force: true });
  await cleanup();
});

const select = (sel: Parameters<typeof matchSelector>[0]) => nodes.filter((n) => matchSelector(sel, n));

describe("matchSelector on fixtures/pnpm-turbo", () => {
  it("a glob matches the files under it and their symbols, and no other node", () => {
    const got = select({ type: "glob", glob: "packages/utils/src/**" });
    const files = got.filter((n) => n.kind === "file").map((n) => n.path);
    expect(files).toEqual(
      expect.arrayContaining(["packages/utils/src/date.ts", "packages/utils/src/time.ts"]),
    );
    expect(files).toHaveLength(
      store.effectiveFiles().filter((f) => f.path.startsWith("packages/utils/src/")).length,
    );
    expect(got.every((n) => n.path?.startsWith("packages/utils/src/"))).toBe(true);
    const symbols = got.filter((n) => n.kind !== "file" && n.kind !== "workspace");
    expect(symbols.length).toBeGreaterThan(0);
    expect(got.length).toBe(files.length + symbols.length);
    // Everything else with a path under utils/src is covered; nothing outside it is.
    expect(nodes.filter((n) => n.path?.startsWith("packages/utils/src/")).length).toBe(got.length);
  });

  it("a directory matches the glob and the glob without /**", () => {
    const dir: SelectableNode = { id: "dir:packages/utils/src", kind: "dir", path: "packages/utils/src" };
    expect(matchSelector({ type: "glob", glob: "packages/utils/src/**" }, dir)).toBe(true);
    expect(matchSelector({ type: "glob", glob: "packages/utils/**" }, dir)).toBe(true);
    expect(matchSelector({ type: "glob", glob: "packages/ui/**" }, dir)).toBe(false);
  });

  it("a glob matches dot paths and a node without a path never matches", () => {
    expect(
      matchSelector({ type: "glob", glob: "**/*.ts" }, { id: "a", kind: "file", path: ".hidden/x.ts" }),
    ).toBe(true);
    expect(matchSelector({ type: "glob", glob: "**" }, { id: "ext:react", kind: "external" })).toBe(false);
  });

  it("kind matches the node kind", () => {
    const got = select({ type: "kind", kind: "workspace" });
    expect(got.length).toBe(store.listWorkspaces().length);
    expect(got.every((n) => n.kind === "workspace")).toBe(true);
    expect(select({ type: "kind", kind: "function" }).every((n) => n.kind === "function")).toBe(true);
  });

  it("workspace matches members and the workspace node itself", () => {
    const ui = store.listWorkspaces().find((w) => w.dir === "packages/ui");
    expect(ui).toBeDefined();
    const got = select({ type: "workspace", workspace: ui?.id as string });
    expect(got.some((n) => n.id === ui?.id)).toBe(true);
    expect(got.some((n) => n.path === "packages/ui/src/internal.ts")).toBe(true);
    expect(got.every((n) => n.workspace === ui?.id)).toBe(true);
  });

  it("ids matches exactly", () => {
    const f = nodes.find(
      (n) => n.path === "packages/ui/src/internal.ts" && n.kind === "file",
    ) as SelectableNode;
    expect(select({ type: "ids", ids: [f.id, "file:nope:x.ts"] }).map((n) => n.id)).toEqual([f.id]);
  });

  it("matchAny is an or over the list and false for an empty list", () => {
    const f = nodes.find((n) => n.kind === "file") as SelectableNode;
    expect(matchAny([], f)).toBe(false);
    expect(
      matchAny(
        [
          { type: "kind", kind: "table" },
          { type: "ids", ids: [f.id] },
        ],
        f,
      ),
    ).toBe(true);
  });
});
