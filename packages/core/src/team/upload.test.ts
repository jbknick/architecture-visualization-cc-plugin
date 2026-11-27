import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePart, splitIntoParts } from "@gantry/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import type { ChangeConsumers, Consumer, HubEntry } from "../review/consumers.js";
import { openStore, type Store } from "../store/index.js";
import {
  buildChangeSet,
  buildMainSnapshot,
  buildMainSnapshotChecked,
  changeSetRecords,
  cutNodes,
  cutRadius,
  mergeRadius,
  snapshotRecords,
} from "./upload.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
interface UploadFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/upload-fixture.js";
const { materializeUploadFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeUploadFixture: (
    name: string,
    opts: {
      dirName: string;
      origin?: string;
      branch?: string;
      edit?: { file: string; from: string; to: string };
    },
  ) => Promise<UploadFixture>;
};

const NOW = "2026-01-02T03:04:05.000Z";
const INPUT = {
  base: "main",
  head: "feat/slug-edit",
  pr: 1,
  owner: "fixture-dev",
  head_ref: "feat/slug-edit",
  base_branch: "main",
  title: "Allow underscores in slugs",
  created_at: "2026-01-01T00:00:00.000Z",
  now: NOW,
};
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

let fx: UploadFixture;
let data: string;
let paths: GantryPaths;
let store: Store;

beforeAll(async () => {
  fx = await materializeUploadFixture("pnpm-turbo", {
    dirName: "pnpm-turbo",
    origin: "https://github.com/fixture/pnpm-turbo.git",
    branch: "feat/slug-edit",
    edit: {
      file: "packages/utils/src/slug.ts",
      from: 'dashed.replace(/[^a-z0-9-]/g, "")',
      to: 'dashed.replace(/[^a-z0-9_-]/g, "")',
    },
  });
  data = mkdtempSync(join(tmpdir(), "gantry-data-"));
  paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  store = openStore(paths.dbPath);
});
afterAll(async () => {
  store.close();
  rmSync(data, { recursive: true, force: true });
  await fx.cleanup();
});

describe("the repo name", () => {
  it("is the origin's owner/name", () => {
    expect(paths.repo).toBe("fixture/pnpm-turbo");
  });
});

describe("buildMainSnapshot", () => {
  it("matches the committed fixture byte for byte, on two runs", async () => {
    const first = json(buildMainSnapshot(store, paths));
    const second = json(buildMainSnapshot(store, paths));
    expect(second).toBe(first);
    await expect(first).toMatchFileSnapshot("../../../../fixtures/team-upload/main-snapshot.json");
  });

  it("has the counts of `gantry index --dump`, and the sha of HEAD", () => {
    const snapshot = buildMainSnapshot(store, paths);
    const dump = dumpGraph(store);
    expect(snapshot.workspaces.length).toBe(dump.workspaces.length);
    expect(snapshot.files.length).toBe(dump.files.length);
    expect(snapshot.symbols.length).toBe(dump.symbols.length);
    expect(snapshot.edges.length).toBe(dump.edges.length);
    expect(snapshot.adapter_nodes.length).toBe(dump.adapterNodes?.length ?? 0);
    expect(snapshot.sha).toBe(fx.git(["rev-parse", "HEAD"]).trim());
  });

  it("sorts every array by id and edges by from, to, kind", () => {
    const s = buildMainSnapshot(store, paths);
    for (const xs of [s.workspaces, s.files, s.symbols, s.adapter_nodes]) {
      const ids = xs.map((x) => x.id);
      expect(ids).toEqual([...ids].sort());
    }
    const keys = s.edges.map((e) => `${e.from}\u0000${e.to}\u0000${e.kind}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("gives a workspace id, not a name, on files and symbols", () => {
    const s = buildMainSnapshot(store, paths);
    const ids = new Set(s.workspaces.map((w) => w.id));
    for (const f of s.files) expect(ids.has(f.workspace)).toBe(true);
    for (const x of s.symbols) expect(ids.has(x.workspace)).toBe(true);
  });

  it("sets content_key for function-like symbols only, and renamed_hash to null when absent", () => {
    const s = buildMainSnapshot(store, paths);
    const fn = s.symbols.filter((x) => ["function", "method", "component", "hook"].includes(x.kind));
    const other = s.symbols.filter((x) => !["function", "method", "component", "hook"].includes(x.kind));
    expect(fn.length).toBeGreaterThan(0);
    expect(other.length).toBeGreaterThan(0);
    for (const x of fn) expect(x.content_key).toBe(`${x.exact_hash}:p1`);
    for (const x of other) expect(x.content_key).toBeNull();
    for (const x of s.symbols)
      expect(x.renamed_hash === null || /^[0-9a-f]{32}$/.test(x.renamed_hash)).toBe(true);
  });

  it("holds the first part of the snapshot in the committed part fixture", async () => {
    const records = snapshotRecords(buildMainSnapshot(store, paths));
    const parts = splitIntoParts(records, { part_max_records: 100, part_max_bytes: 1_048_576 });
    expect(parts.length).toBeGreaterThan(1);
    const first = decodePart(parts[0] as Uint8Array, undefined, "main");
    const ndjson = `${first.map((r) => JSON.stringify(r)).join("\n")}\n`;
    await expect(ndjson).toMatchFileSnapshot("../../../../fixtures/team-upload/main-snapshot.part-1.ndjson");
  });
});

describe("buildChangeSet", () => {
  it("matches the committed fixture byte for byte, on two runs", async () => {
    const a = await buildChangeSet(store, paths, INPUT);
    const b = await buildChangeSet(store, paths, INPUT);
    expect(json(b.changeSet)).toBe(json(a.changeSet));
    await expect(json(a.changeSet)).toMatchFileSnapshot("../../../../fixtures/team-upload/change-set.json");
    expect(a.warnings).toEqual([]);
  });

  it("is a pull request change set that names slugify and the files it edits", async () => {
    const { changeSet: cs } = await buildChangeSet(store, paths, INPUT);
    expect(cs).toMatchObject({
      id: "cs:pr:fixture/pnpm-turbo#1",
      repo: "fixture/pnpm-turbo",
      source: "pr",
      state: "in_review",
      ref: "#1",
      head_ref: "feat/slug-edit",
      base_branch: "main",
      estimated: false,
      links: [],
      owner: "fixture-dev",
      pr: 1,
      title: "Allow underscores in slugs",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: NOW,
      head_sha: fx.git(["rev-parse", "feat/slug-edit"]).trim(),
    });
    expect(cs).not.toHaveProperty("confidence");
    expect(cs.nodes).toContain("sym:fixture/pnpm-turbo:packages/utils/src/slug.ts#slugify");
    expect(cs.nodes).toContain("file:fixture/pnpm-turbo:packages/utils/src/slug.ts");
    expect(cs.nodes).toEqual([...cs.nodes].sort());
    expect(cs.radius.length).toBeGreaterThan(0);
    const order = cs.radius.map((r) => `${String(r.hop).padStart(3, "0")}${r.id}`);
    expect(order).toEqual([...order].sort());
    for (const r of cs.radius) {
      expect(r.tier).toBe(r.hop === 1 ? "direct" : r.hop <= 3 ? "potential" : "reachable");
    }
  });

  it("uses created_at = now and omits title when they are not given", async () => {
    const { head_ref, base_branch, ...rest } = INPUT;
    const { created_at: _c, title: _t, ...bare } = rest;
    const { changeSet } = await buildChangeSet(store, paths, { ...bare, head_ref, base_branch });
    expect(changeSet.created_at).toBe(NOW);
    expect(changeSet).not.toHaveProperty("title");
  });

  it("throws when head_ref or base_branch is missing", async () => {
    const { head_ref: _h, ...noHead } = INPUT;
    const { base_branch: _b, ...noBase } = INPUT;
    await expect(buildChangeSet(store, paths, noHead as typeof INPUT)).rejects.toThrow(/head_ref/);
    await expect(buildChangeSet(store, paths, noBase as typeof INPUT)).rejects.toThrow(/base_branch/);
  });

  it("accepts an empty head_ref (the schema allows it)", async () => {
    const { changeSet } = await buildChangeSet(store, paths, { ...INPUT, head_ref: "" });
    expect(changeSet.head_ref).toBe("");
  });

  it("passes the warnings of the node cut and the radius cut through", async () => {
    const { changeSet, warnings } = await buildChangeSet(store, paths, INPUT, { nodes: 1, near: 0 });
    expect(changeSet.nodes.length).toBe(1);
    expect(changeSet.nodes_total).toBe(2);
    expect(changeSet.radius).toEqual([]);
    expect(warnings).toEqual(["nodes: sent 1 of 2", "radius: sent 0 of 1"]);
  });

  it("gives the change set records in the protocol order: the c record, nodes, radius", async () => {
    const { changeSet } = await buildChangeSet(store, paths, INPUT);
    const records = changeSetRecords(changeSet);
    expect(records[0]?.t).toBe("c");
    expect(records.filter((r) => r.t === "n").length).toBe(changeSet.nodes.length);
    expect(records.filter((r) => r.t === "r").length).toBe(changeSet.radius.length);
  });
});

function consumer(id: string, hop: number): Consumer {
  return {
    id,
    name: id,
    kind: "function",
    path: "p.ts",
    line: 1,
    workspace: null,
    hop,
    uses: [],
    crosses: [],
  };
}
function hub(id: string, hop: number, members: Consumer[], consumersTotal = members.length): HubEntry {
  return {
    hub: id,
    name: id,
    kind: "function",
    path: "p.ts",
    workspace: null,
    hop,
    consumersTotal,
    byWorkspace: [],
    members,
  };
}
function changeConsumers(over: Partial<ChangeConsumers>): ChangeConsumers {
  return {
    id: "sym:x",
    target: "symbol",
    direct: [],
    directTotal: 0,
    potential: [],
    potentialTotal: 0,
    reachable: [],
    reachableTotal: 0,
    hubs: [],
    ...over,
  };
}

describe("cutNodes", () => {
  const ids = Array.from({ length: 5001 }, (_, i) => `n${String(i).padStart(5, "0")}`);
  it("sends exactly 5,000 ids with nodes_total and the warning when more are found", () => {
    const cut = cutNodes(ids);
    expect(cut.nodes).toEqual(ids.slice(0, 5000));
    expect(cut.nodes_total).toBe(5001);
    expect(cut.warning).toBe("nodes: sent 5000 of 5001");
  });
  it("sends no total and no warning at exactly 5,000", () => {
    const cut = cutNodes(ids.slice(0, 5000));
    expect(cut.nodes.length).toBe(5000);
    expect(cut).not.toHaveProperty("nodes_total");
    expect(cut).not.toHaveProperty("warning");
  });
});

describe("adapter labels", () => {
  const patched = (label: string): Store =>
    Object.create(store, {
      effectiveAdapterNodes: {
        value: () => [
          {
            id: "route:fixture/pnpm-turbo:@acme/web:GET /x",
            kind: "route",
            ws: "ws:fixture/pnpm-turbo:@acme/web",
            label,
            fileId: "file:fixture/pnpm-turbo:apps/web/src/lib/slug.ts",
            data: {},
          },
        ],
      },
    });

  it("sends a multi-line label empty, with a warning, and never rewrites it into one line", () => {
    const label = "route(`\n  return secretCode(1);\n`)";
    const { snapshot, warnings } = buildMainSnapshotChecked(patched(label), paths);
    expect(snapshot.adapter_nodes.map((n) => n.label)).toEqual([""]);
    expect(JSON.stringify(snapshot)).not.toContain("secretCode");
    expect(warnings).toEqual(["adapter nodes: 1 label(s) with a line break or control character sent empty"]);
  });
  it.each([
    "\nreturn secretCode(1);",
    "return secretCode(1);\n",
    "\r\treturn secretCode(1);",
    "x\u2028",
    "\u2029x",
  ])("sends a label with an edge line break or control character empty, with the warning (%j)", (label) => {
    const { snapshot, warnings } = buildMainSnapshotChecked(patched(label), paths);
    expect(snapshot.adapter_nodes.map((n) => n.label)).toEqual([""]);
    expect(warnings).toEqual(["adapter nodes: 1 label(s) with a line break or control character sent empty"]);
  });
  it("cuts a label by code points: an astral character at position 200 is kept whole or left out, never split", () => {
    const { snapshot } = buildMainSnapshotChecked(patched(`${"a".repeat(199)}\u{1F600}b`), paths);
    const label = snapshot.adapter_nodes[0]?.label as string;
    expect(label).toBe("a".repeat(199));
    expect(label.length).toBeLessThanOrEqual(200);
    const fits = buildMainSnapshotChecked(patched(`${"a".repeat(198)}\u{1F600}b`), paths).snapshot
      .adapter_nodes[0]?.label as string;
    expect(fits).toBe(`${"a".repeat(198)}\u{1F600}`);
    expect(fits.length).toBe(200);
    expect(JSON.parse(JSON.stringify(fits))).toBe(fits);
  });
  it("keeps a one-line label, trimmed and cut at 200 characters", () => {
    const { snapshot, warnings } = buildMainSnapshotChecked(patched(`  ${"a".repeat(300)}  `), paths);
    expect(snapshot.adapter_nodes[0]?.label).toBe("a".repeat(200));
    expect(warnings).toEqual([]);
  });
});

describe("the radius", () => {
  it("merges by id at the lowest hop, tiers by hop, and marks an id only in hub members as via_hub", () => {
    const a = changeConsumers({
      direct: [consumer("a", 1)],
      directTotal: 1,
      potential: [consumer("b", 2), consumer("c", 3)],
      potentialTotal: 3,
      reachable: [consumer("d", 4)],
      reachableTotal: 4,
      hubs: [hub("h", 5, [consumer("m1", 5), consumer("m2", 5), consumer("c", 5)])],
    });
    const b = changeConsumers({ direct: [consumer("b", 1)], directTotal: 1 });
    const { merged } = mergeRadius([a, b]);
    expect(merged).toEqual([
      { id: "a", hop: 1, tier: "direct", via_hub: false },
      { id: "b", hop: 1, tier: "direct", via_hub: false },
      { id: "c", hop: 3, tier: "potential", via_hub: false },
      { id: "d", hop: 4, tier: "reachable", via_hub: false },
      { id: "h", hop: 4, tier: "reachable", via_hub: false },
      { id: "m1", hop: 5, tier: "reachable", via_hub: true },
      { id: "m2", hop: 5, tier: "reachable", via_hub: true },
    ]);
  });

  it("keeps the hub node as an ordinary entry when a list already holds it", () => {
    const a = changeConsumers({
      potential: [consumer("h", 2)],
      potentialTotal: 3,
      hubs: [hub("h", 3, [consumer("m", 3)])],
    });
    const { merged } = mergeRadius([a]);
    expect(merged.find((e) => e.id === "h")).toEqual({ id: "h", hop: 2, tier: "potential", via_hub: false });
    expect(merged.find((e) => e.id === "m")?.via_hub).toBe(true);
  });

  it("places a missing hub node at hop - 1, and no lower than 1", () => {
    const a = changeConsumers({ hubs: [hub("h1", 2, [consumer("m", 2)]), hub("h2", 1, [consumer("n", 1)])] });
    const { merged } = mergeRadius([a]);
    expect(merged.find((e) => e.id === "h1")?.hop).toBe(1);
    expect(merged.find((e) => e.id === "h2")?.hop).toBe(1);
  });

  it("counts what the engine did not list, once, for the warning", () => {
    const a = changeConsumers({
      direct: [consumer("a", 1)],
      directTotal: 5,
      potential: [consumer("b", 2)],
      potentialTotal: 7,
      hubs: [hub("h", 3, [consumer("m", 3)], 4)],
    });
    // potential: 7 total, 1 listed, 4 stood for by the hub: 2 unlisted; hub: 4 total, 1 member: 3 unlisted; direct 4.
    expect(mergeRadius([a]).unlisted).toBe(4 + 2 + 3);
  });

  it("lowers a hub's hop every time: a shared hub keeps the lowest, whichever change comes first", () => {
    const deep = changeConsumers({ hubs: [hub("h", 5, [consumer("m1", 5)])] });
    const shallow = changeConsumers({ hubs: [hub("h", 3, [consumer("m2", 3)])] });
    for (const order of [
      [deep, shallow],
      [shallow, deep],
    ]) {
      expect(mergeRadius(order).merged.find((e) => e.id === "h")).toEqual({
        id: "h",
        hop: 2,
        tier: "potential",
        via_hub: false,
      });
    }
    // The hub node is also a member of another hub, at a deeper hop.
    const nested = changeConsumers({
      hubs: [hub("g", 5, [consumer("h", 5)]), hub("h", 3, [consumer("m", 3)])],
    });
    expect(mergeRadius([nested]).merged.find((e) => e.id === "h")).toMatchObject({ hop: 2, via_hub: false });
  });

  it("cuts to 500 entries for hops 1 to 3 and 2,500 for hop 4 and over, with a total and a warning", () => {
    const entries = [
      ...Array.from({ length: 600 }, (_, i) => ({
        id: `n${String(i).padStart(4, "0")}`,
        hop: 2,
        tier: "potential" as const,
        via_hub: false,
      })),
      ...Array.from({ length: 2600 }, (_, i) => ({
        id: `r${String(i).padStart(4, "0")}`,
        hop: 4,
        tier: "reachable" as const,
        via_hub: false,
      })),
    ];
    const cut = cutRadius({ merged: entries, unlisted: 0 });
    expect(cut.radius.length).toBe(3000);
    expect(cut.reachable_total).toBe(2600);
    expect(cut.warning).toBe("radius: sent 3000 of 3200");
  });

  it("sends no total and no warning when nothing is cut", () => {
    const merged = [{ id: "a", hop: 1, tier: "direct" as const, via_hub: false }];
    expect(cutRadius({ merged, unlisted: 0 })).toEqual({ radius: merged });
  });
});
