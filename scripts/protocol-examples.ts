/**
 * Writes the example payloads of `@gantry/protocol` into `packages/protocol/examples/`:
 * `pnpm exec tsx scripts/protocol-examples.ts`.
 *
 * The data is `fixtures/pnpm-turbo`, indexed in a temporary copy, with the repo named `fixture/pnpm-turbo`. The
 * output is deterministic, so running it again changes nothing. `packages/protocol/src/examples.test.ts` parses
 * every file with its schema.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentKey, indexRepo, openStore, resolvePaths } from "../packages/core/src/index.js";
import { materializeFixture } from "../packages/core/test/helpers/fixture.js";
import {
  type AdapterNode,
  type ChangeSet,
  changeSetIdForPr,
  changeSetRecords,
  type DescriptionsRequest,
  type Edge,
  type FileNode,
  type MainSnapshot,
  mainSnapshotRecords,
  type SymbolNode,
  splitIntoParts,
  type Workspace,
} from "../packages/protocol/src/index.js";

const OUT = join(import.meta.dirname, "../packages/protocol/examples");
const REPO = "fixture/pnpm-turbo";
const SHA = "1863607d4346a2737224baab89b421b2b1a1b8bf";
const HEAD_SHA = "7e3d9a1c5b8f20466d1ae9c3b7f45082d6c1e9ab";
const LIMITS = { part_max_records: 40, part_max_bytes: 1_048_576 };

/** The fixture is indexed under the name of its directory; the examples use the name of a hosted repo. */
const rename = (id: string): string => id.replace(/^([a-z]+):pnpm-turbo:/, `$1:${REPO}:`);

async function snapshot(): Promise<MainSnapshot> {
  const fx = await materializeFixture("pnpm-turbo");
  const data = mkdtempSync(join(tmpdir(), "gantry-protocol-examples-"));
  try {
    const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    await indexRepo(paths, { layer: "main" });
    const store = openStore(paths.dbPath);
    try {
      const files = store.effectiveFiles();
      const workspaceOfFile = new Map(files.map((f) => [f.id, f.workspaceId ?? ""]));
      const workspaces: Workspace[] = store
        .listWorkspaces()
        .map((w) => ({ id: rename(w.id), name: w.name, path: w.dir }));
      const fileNodes: FileNode[] = files
        .filter((f) => f.workspaceId !== null)
        .map((f) => ({
          id: rename(f.id),
          path: f.path,
          workspace: rename(f.workspaceId ?? ""),
          lang: f.lang,
        }));
      const symbols: SymbolNode[] = store.effectiveSymbols().map((s) => ({
        id: rename(s.id),
        name: s.name,
        kind: s.kind,
        lang: s.lang,
        path: files.find((f) => f.id === s.fileId)?.path ?? "",
        workspace: rename(workspaceOfFile.get(s.fileId) ?? ""),
        line_start: s.startLine,
        line_end: s.endLine,
        exact_hash: s.exactHash,
        renamed_hash: s.renamedHash ?? null,
        content_key: contentKey(s.exactHash),
      }));
      const edges: Edge[] = store
        .effectiveEdges()
        .filter((e) => e.kind !== "similar_to")
        .map((e) => ({ from: rename(e.src), to: rename(e.dst), kind: e.kind }));
      const adapterNodes: AdapterNode[] = store.effectiveAdapterNodes().map((n) => ({
        id: rename(n.id),
        kind: n.kind,
        workspace: rename(n.ws ?? ""),
        label: n.label,
        file_id: rename(n.fileId),
      }));
      return {
        repo: REPO,
        sha: SHA,
        workspaces,
        files: fileNodes,
        symbols,
        edges,
        adapter_nodes: adapterNodes,
      };
    } finally {
      store.close();
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
    await fx.cleanup();
  }
}

const json = (name: string, value: unknown): void =>
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const snap = await snapshot();

  const parts = splitIntoParts(mainSnapshotRecords(snap), LIMITS);
  for (const [i, p] of parts.entries()) writeFileSync(join(OUT, `main-snapshot.part-${i + 1}.ndjson.gz`), p);
  json("upload-start-main.json", {
    kind: "main",
    sha: SHA,
    counts: {
      workspaces: snap.workspaces.length,
      files: snap.files.length,
      symbols: snap.symbols.length,
      edges: snap.edges.length,
      adapter_nodes: snap.adapter_nodes.length,
    },
  });
  json("upload-begun.json", { upload_id: "5f3a9c1e7b2d4a60918c3e7d", ...LIMITS, max_parts: 1000 });
  json("upload-status.json", {
    status: "loading",
    parts: { total: parts.length, received: parts.length, done: 0, failed: 0 },
  });

  const slugFile = snap.files.find((f) => f.path.endsWith("utils/src/slug.ts"));
  const slugSymbol = snap.symbols.find((s) => s.path.endsWith("utils/src/slug.ts"));
  const others = snap.symbols.filter((s) => s.id !== slugSymbol?.id).slice(0, 2);
  if (slugFile === undefined || slugSymbol === undefined || others.length < 2) {
    throw new Error("the fixture no longer has the symbols the examples use");
  }
  // The radius is illustrative, not computed.
  const changeSet: ChangeSet = {
    id: changeSetIdForPr(REPO, 1),
    repo: REPO,
    source: "pr",
    state: "in_review",
    ref: "#1",
    head_ref: "feat/slug-edit",
    base_branch: "main",
    nodes: [slugFile.id, slugSymbol.id].sort(),
    radius: [
      { id: others[0]?.id ?? "", hop: 1, tier: "direct", via_hub: false },
      { id: others[1]?.id ?? "", hop: 4, tier: "reachable", via_hub: false },
    ],
    estimated: false,
    owner: "octo-dev",
    title: "Handle accents in slugify",
    pr: 1,
    head_sha: HEAD_SHA,
    created_at: "2026-11-20T09:15:00.000Z",
    updated_at: "2026-11-20T09:40:12.000Z",
    links: [],
  };
  json("change-set.json", changeSet);
  const csParts = splitIntoParts(changeSetRecords(changeSet), LIMITS);
  for (const [i, p] of csParts.entries()) writeFileSync(join(OUT, `change-set.part-${i + 1}.ndjson.gz`), p);
  json("upload-start-change-set.json", {
    kind: "change_set",
    counts: { nodes: changeSet.nodes.length, radius: changeSet.radius.length },
  });
  json("close-request.json", { merged: true, head_sha: HEAD_SHA });

  const group = {
    id: "web-app",
    name: "Web app",
    selectors: [
      {
        type: "workspace",
        workspace: snap.workspaces.find((w) => w.name.endsWith("web"))?.id ?? snap.workspaces[0]?.id,
      },
    ],
    mayUse: null,
  };
  const view = {
    id: "api-only",
    name: "API only",
    spec: { view: "api-only", level: "files", hidden: [], groups: [], filters: {} },
  };
  json("group.json", group);
  json("view.json", view);
  json("pull-response.json", {
    change_sets: [changeSet],
    team_views: [view],
    groups: [group],
    settings: { default_view: "api-only" },
    pulled_at: "2026-11-20T09:41:00.000Z",
  });
  const descriptions: DescriptionsRequest = {
    repo: REPO,
    descriptions: [
      {
        content_key: slugSymbol.content_key ?? "",
        behavior: "Turns a title into a lower-case, dash-separated URL slug.",
        search_terms: ["slug", "url", "kebab case"],
        name_fits: true,
        provenance: "model",
        model: "claude-haiku-4-5",
        prompt_version: "p1",
        created_at: "2026-11-20T09:00:00.000Z",
      },
    ],
  };
  json("descriptions-request.json", descriptions);
  json("whoami-ci.json", { kind: "ci", org: "acme", repo: REPO, repo_connected: true, protocol: 1 });
  json("whoami-user.json", {
    kind: "user",
    user: "octo-dev",
    org: "acme",
    role: "member",
    repo: REPO,
    repo_connected: true,
    protocol: 1,
  });
  json("error.json", { error: "budget", message: "the daily upload capacity is used; try later" });
  // The files are formatted as Biome formats them, so `biome check` passes and a second run changes nothing.
  execFileSync("pnpm", ["exec", "biome", "format", "--write", OUT], { stdio: "ignore" });
}

await main();
