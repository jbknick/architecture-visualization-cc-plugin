import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dismiss } from "../dup/engine.js";
import { openStore, type Store } from "../store/index.js";
import {
  deleteGroup,
  deleteView,
  readOverlay,
  resetOverlay,
  saveGroup,
  saveView,
  setHidden,
  setLabel,
} from "./repo.js";
import type { Group, SavedView, Selector } from "./types.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(): { store: Store; reopen: () => Store } {
  const dir = mkdtempSync(join(tmpdir(), "gantry-overlay-repo-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "gantry.db");
  const make = (): Store => {
    const s = openStore(path, { overlayPath: join(dir, "overlay.db") });
    stores.push(s);
    return s;
  };
  return { store: make(), reopen: make };
}

const dates: Group = {
  id: "dates",
  name: "Dates",
  selectors: [{ type: "glob", glob: "packages/utils/src/{date,time}.ts" }],
  mayUse: null,
};
const ui: Group = {
  id: "ui",
  name: "UI",
  selectors: [{ type: "kind", kind: "component" }],
  mayUse: ["dates"],
};
const curated: SavedView = {
  id: "curated",
  name: "Curated",
  spec: { view: "project-map", level: "files", hidden: [], groups: ["dates", "ui"], filters: {} },
};

describe("overlay repo", () => {
  it("starts empty", () => {
    expect(readOverlay(open().store)).toEqual({ labels: [], hidden: [], groups: [], views: [] });
  });

  it("round-trips labels, and empty text removes one", () => {
    const { store } = open();
    setLabel(store, { nodeId: "file:r:b.ts", text: "B" });
    setLabel(store, { nodeId: "file:r:a.ts", text: "A" });
    setLabel(store, { nodeId: "file:r:a.ts", text: "A2" });
    expect(readOverlay(store).labels).toEqual([
      { nodeId: "file:r:a.ts", text: "A2" },
      { nodeId: "file:r:b.ts", text: "B" },
    ]);
    setLabel(store, { nodeId: "file:r:a.ts", text: "" });
    expect(readOverlay(store).labels).toEqual([{ nodeId: "file:r:b.ts", text: "B" }]);
  });

  it("round-trips the hidden list in order and replaces it", () => {
    const { store } = open();
    const list: Selector[] = [
      { type: "glob", glob: "z/**" },
      { type: "kind", kind: "dir" },
      { type: "ids", ids: ["file:r:a.ts"] },
    ];
    setHidden(store, list);
    expect(readOverlay(store).hidden).toEqual(list);
    setHidden(store, list.slice(1, 2));
    expect(readOverlay(store).hidden).toEqual([{ type: "kind", kind: "dir" }]);
    setHidden(store, []);
    expect(readOverlay(store).hidden).toEqual([]);
  });

  it("round-trips groups (with and without a rule) and saved views, sorted by id", () => {
    const { store } = open();
    saveGroup(store, ui);
    saveGroup(store, dates);
    saveView(store, curated);
    expect(readOverlay(store).groups).toEqual([dates, ui]);
    expect(readOverlay(store).views).toEqual([curated]);
    saveGroup(store, { ...ui, mayUse: null });
    expect(readOverlay(store).groups[1]?.mayUse).toBeNull();
    expect(store.db.prepare("SELECT count(*) AS n FROM overlay.group_rules").get()).toEqual({ n: 0 });
  });

  it("writes equal bytes for equal input", () => {
    const { store } = open();
    saveView(store, curated);
    const read = () => store.db.prepare("SELECT spec FROM overlay.views").get();
    const first = read();
    saveView(store, JSON.parse(JSON.stringify(curated)));
    expect(read()).toEqual(first);
  });

  it("rejects a value the schema refuses, writing nothing", () => {
    const { store } = open();
    expect(() => saveGroup(store, { ...dates, id: "Bad" })).toThrow();
    expect(() => saveGroup(store, { ...dates, selectors: [] })).toThrow();
    expect(readOverlay(store).groups).toEqual([]);
  });

  it("deleteGroup removes the group and its rule, and cleans mayUse and saved views", () => {
    const { store } = open();
    saveGroup(store, dates);
    saveGroup(store, ui);
    saveView(store, curated);
    expect(deleteGroup(store, "dates")).toBe(true);
    const state = readOverlay(store);
    expect(state.groups.map((g) => g.id)).toEqual(["ui"]);
    expect(state.groups[0]?.mayUse).toEqual([]);
    expect(state.views[0]?.spec.groups).toEqual(["ui"]);
    expect(deleteGroup(store, "dates")).toBe(false);
    expect(deleteGroup(store, "ui")).toBe(true);
    expect(store.db.prepare("SELECT count(*) AS n FROM overlay.group_rules").get()).toEqual({ n: 0 });
  });

  it("deleteView reports whether it existed", () => {
    const { store } = open();
    saveView(store, curated);
    expect(deleteView(store, "curated")).toBe(true);
    expect(deleteView(store, "curated")).toBe(false);
  });

  it("survives closing and reopening the store", () => {
    const { store, reopen } = open();
    setLabel(store, { nodeId: "file:r:a.ts", text: "A" });
    saveGroup(store, dates);
    const before = readOverlay(store);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(readOverlay(reopen())).toEqual(before);
  });

  it("resetOverlay clears the curation tables and keeps dismissals and layouts", () => {
    const { store } = open();
    setLabel(store, { nodeId: "file:r:a.ts", text: "A" });
    setHidden(store, [{ type: "kind", kind: "dir" }]);
    saveGroup(store, ui);
    saveView(store, curated);
    dismiss(store, "sym:r:b.ts#b", "sym:r:a.ts#a", "because");
    store.db.prepare("INSERT INTO overlay.layouts(view, node_id, x, y) VALUES ('debug', 'ws:.', 1, 2)").run();
    resetOverlay(store);
    expect(readOverlay(store)).toEqual({ labels: [], hidden: [], groups: [], views: [] });
    expect(store.db.prepare("SELECT count(*) AS n FROM overlay.dismissals").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT count(*) AS n FROM overlay.layouts").get()).toEqual({ n: 1 });
  });
});
