import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type ChangeSet,
  ChangeSetSchema,
  changeSetIdForPr,
  type MainSnapshot,
  MainSnapshotSchema,
  mainSnapshotRecords,
  type PartRecord,
  changeSetRecords as protocolChangeSetRecords,
  type RadiusEntry,
} from "@gantry/protocol";
import { contentKey, FUNCTION_LIKE_KINDS } from "../describe/factsheet.js";
import { fileId as makeFileId, parseId, parseWorkspaceId, workspaceId } from "../ids.js";
import type { GantryPaths } from "../paths/index.js";
import {
  type ChangeConsumers,
  type Consumer,
  REACHABLE_FIRST_HOP,
  REACHABLE_NODE_CAP,
} from "../review/consumers.js";
import { reviewDiff } from "../review/diff.js";
import { computeImpact } from "../review/impact.js";
import type { Store } from "../store/index.js";
import { hasHiddenText } from "../text/untrusted.js";
import type { SymbolKind } from "../types.js";

/**
 * The two payloads a team upload sends: the graph of `main` and one pull request's changed nodes with their blast
 * radius (spec section 20). Both are pure functions of the index: names, paths, line ranges, edges and hashes. Nothing
 * here reads a file's text, and nothing carries a function body, a signature, file contents or a fact sheet: every
 * field is picked by name from the store rows, and the protocol schemas are strict, so a field added by mistake fails
 * the parse. Nothing in this file sends a request.
 */

/** Wire cut for hops 1 to 3 and for hop 4 and over (spec section 20, "Radius"). */
export const RADIUS_NEAR_CAP = 500;
export const RADIUS_REACHABLE_CAP = REACHABLE_NODE_CAP;
/** Wire cut for a change set's `nodes`. */
export const NODES_CAP = 5000;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byId = <T extends { id: string }>(a: T, b: T): number => cmp(a.id, b.id);
const FUNCTION_LIKE = new Set<SymbolKind>(FUNCTION_LIKE_KINDS);

function parseOrThrow<T>(
  what: string,
  schema: {
    safeParse(
      v: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
  value: unknown,
): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new Error(
    `${what} does not match the protocol schema at ${issue?.path.map(String).join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
  );
}

function headSha(paths: GantryPaths): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: paths.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = r.status === 0 ? r.stdout.trim() : "";
  if (sha === "") throw new Error("cannot read HEAD of the checkout (git rev-parse HEAD failed)");
  return sha;
}

/** True for an id of this repo (`file:`, `sym:` and the adapter kinds carry the repo right after the prefix). */
function inRepo(id: string, repo: string): boolean {
  const ws = parseWorkspaceId(id);
  if (ws !== undefined) return ws.repo === repo;
  return parseId(id)?.repo === repo;
}

/**
 * The graph of `main` as the index holds it, as a `MainSnapshot`: workspaces, files, symbols, edges and adapter nodes
 * of `paths.repo`, each array sorted by id (edges by `from`, `to`, `kind`). A symbol has no `shape_hash` and no
 * signature; `content_key` is set for function-like kinds only. Byte-stable for one index.
 */
export function buildMainSnapshot(store: Store, paths: GantryPaths): MainSnapshot {
  return buildMainSnapshotChecked(store, paths).snapshot;
}

/** At most 200 UTF-16 units (the schema counts those), never splitting a surrogate pair. */
function cutLabel(s: string, max = 200): string {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/**
 * True when `s` holds a line break or another control character (C0, DEL, C1, line and paragraph separators) or an
 * invisible format character (zero-width, bidi, tag characters, private use, a lone surrogate).
 */
function hasControl(s: string): boolean {
  return hasHiddenText(s);
}

/**
 * `buildMainSnapshot` with the warnings a command prints to stderr. An adapter label with a line break or another
 * control character is never rewritten: it is sent empty and counted, so a multi-line label cannot reach the wire.
 */
export function buildMainSnapshotChecked(
  store: Store,
  paths: GantryPaths,
): { snapshot: MainSnapshot; warnings: string[] } {
  const warnings: string[] = [];
  const repo = paths.repo;
  const rootWorkspace = workspaceId(repo, ".");
  const workspaces = store
    .listWorkspaces()
    .filter((w) => inRepo(w.id, repo))
    .map((w) => ({ id: w.id, name: w.name, path: w.dir }))
    .sort(byId);
  const files = store.effectiveFiles().filter((f) => inRepo(f.id, repo));
  const filePath = new Map(files.map((f) => [f.id, f.path]));
  const fileWorkspace = new Map(files.map((f) => [f.id, f.workspaceId ?? rootWorkspace]));
  const symbols = store
    .effectiveSymbols()
    .filter((s) => fileWorkspace.has(s.fileId))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      lang: s.lang,
      path: filePath.get(s.fileId) as string,
      workspace: fileWorkspace.get(s.fileId) as string,
      line_start: s.startLine,
      line_end: s.endLine,
      exact_hash: s.exactHash,
      renamed_hash: s.renamedHash === undefined || s.renamedHash === "" ? null : s.renamedHash,
      content_key: FUNCTION_LIKE.has(s.kind) ? contentKey(s.exactHash) : null,
    }))
    .sort(byId);
  // An edge belongs to the repo of its source. Its target may be another repo's node or an external package (`ext:react`).
  const edges = store
    .effectiveEdges()
    .filter((e) => e.kind !== "similar_to" && inRepo(e.src, repo))
    .map((e) => ({ from: e.src, to: e.dst, kind: e.kind }))
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind));
  let heldBack = 0;
  const adapterNodes = store
    .effectiveAdapterNodes()
    .filter((n) => inRepo(n.id, repo))
    .map((n) => {
      // The control check runs on the raw label: trimming first would drop a leading or trailing line break unseen.
      const bad = hasControl(n.label);
      if (bad) heldBack += 1;
      return { n, label: bad ? "" : cutLabel(n.label.trim()) };
    })
    .map(({ n, label }) => ({
      id: n.id,
      kind: n.kind,
      workspace: n.ws ?? rootWorkspace,
      label,
      file_id: n.fileId === "" ? null : n.fileId,
    }))
    .sort(byId);
  if (heldBack > 0) {
    warnings.push(`adapter nodes: ${heldBack} label(s) with a line break or control character sent empty`);
  }
  const snapshot = parseOrThrow("main snapshot", MainSnapshotSchema, {
    repo,
    sha: headSha(paths),
    workspaces,
    files: files
      .map((f) => ({ id: f.id, path: f.path, workspace: fileWorkspace.get(f.id) as string, lang: f.lang }))
      .sort(byId),
    symbols,
    edges,
    adapter_nodes: adapterNodes,
  });
  return { snapshot, warnings };
}

/**
 * The wire cut: at most 500 entries for hops 1 to 3 and 2,500 for hop 4 and over (the first ones in hop, id order).
 * `reachable_total` is the number of hop-4-and-over ids before the cut, set only when it is more than what is sent.
 * `warning` is `radius: sent <sent> of <known>` when entries are missing, whether the wire or the engine cut them.
 */
export function cutRadius(
  r: Radius,
  nearCap = RADIUS_NEAR_CAP,
  reachableCap = RADIUS_REACHABLE_CAP,
): { radius: RadiusEntry[]; reachable_total?: number; warning?: string } {
  const near = r.merged.filter((e) => e.hop < REACHABLE_FIRST_HOP).slice(0, nearCap);
  const farAll = r.merged.filter((e) => e.hop >= REACHABLE_FIRST_HOP);
  const far = farAll.slice(0, reachableCap);
  const radius = [...near, ...far];
  const known = r.merged.length + r.unlisted;
  return {
    radius,
    ...(farAll.length > far.length ? { reachable_total: farAll.length } : {}),
    ...(radius.length < known ? { warning: `radius: sent ${radius.length} of ${known}` } : {}),
  };
}

/** The first `cap` ids (sorted), with `nodes_total` and a warning only when something was cut. */
export function cutNodes(
  sorted: readonly string[],
  cap = NODES_CAP,
): { nodes: string[]; nodes_total?: number; warning?: string } {
  if (sorted.length <= cap) return { nodes: [...sorted] };
  return {
    nodes: sorted.slice(0, cap),
    nodes_total: sorted.length,
    warning: `nodes: sent ${cap} of ${sorted.length}`,
  };
}

export interface ChangeSetInput {
  /** The pull request's base and head, as git refs (`reviewDiff` takes the merge base). */
  base: string;
  head: string;
  /** The pull request number. */
  pr: number;
  /** The author's GitHub login. */
  owner: string;
  /** The pull request's head branch. */
  head_ref: string;
  /** The pull request's base branch. */
  base_branch: string;
  title?: string;
  /** The pull request's creation time (ISO); defaults to `now`. */
  created_at?: string;
  /** An ISO time; defaults to the current time in UTC. */
  now?: string;
}

export interface BuiltChangeSet {
  changeSet: ChangeSet;
  /** Lines for stderr, one per cut that hid something (`radius: sent <sent> of <known>`, `nodes: sent 5000 of <n>`). */
  warnings: string[];
}

const tierOf = (hop: number): RadiusEntry["tier"] =>
  hop >= REACHABLE_FIRST_HOP ? "reachable" : hop >= 2 ? "potential" : "direct";

export interface Radius {
  merged: RadiusEntry[];
  /** Entries the engine knew about but did not list, summed over changes and tiers (an upper bound). */
  unlisted: number;
}

/**
 * The radius before the wire cut: every list of every change's consumers (`direct`, `potential`, `reachable` and every
 * hub's `members`) merged by id at the lowest hop, sorted by hop then id. An id that appears only in hub members has
 * `via_hub` true; the hub node itself is one ordinary entry, added at `hop - 1` (at least 1) when no list holds it.
 */
export function mergeRadius(consumers: readonly ChangeConsumers[]): Radius {
  const hops = new Map<string, number>();
  const ordinary = new Set<string>();
  const lower = (id: string, hop: number): void => {
    const known = hops.get(id);
    if (known === undefined || hop < known) hops.set(id, hop);
  };
  let unlisted = 0;
  for (const c of consumers) {
    for (const list of [c.direct, c.potential, c.reachable]) {
      for (const e of list as Consumer[]) {
        ordinary.add(e.id);
        lower(e.id, e.hop);
      }
    }
    unlisted += Math.max(0, c.directTotal - c.direct.length);
    // `potentialTotal` and `reachableTotal` count the consumers a hub stands for; the lists leave them out and the
    // hub's `members` hold at most MAX_CONSUMERS of them. Count the two gaps apart so nothing is counted twice.
    for (const [total, listed, near] of [
      [c.potentialTotal, c.potential.length, true],
      [c.reachableTotal, c.reachable.length, false],
    ] as const) {
      const hubs = c.hubs.filter((h) => h.hop < REACHABLE_FIRST_HOP === near);
      const stood = hubs.reduce((n, h) => n + h.consumersTotal, 0);
      unlisted += Math.max(0, total - listed - stood);
      for (const h of hubs) unlisted += Math.max(0, h.consumersTotal - h.members.length);
    }
  }
  const members = new Set<string>();
  for (const c of consumers) {
    for (const h of c.hubs) {
      for (const m of h.members) {
        members.add(m.id);
        lower(m.id, m.hop);
      }
    }
  }
  for (const c of consumers) {
    for (const h of c.hubs) {
      ordinary.add(h.hub);
      lower(h.hub, Math.max(1, h.hop - 1));
    }
  }
  const merged = [...hops.entries()]
    .map(([id, hop]) => ({ id, hop, tier: tierOf(hop), via_hub: members.has(id) && !ordinary.has(id) }))
    .sort((a, b) => a.hop - b.hop || cmp(a.id, b.id));
  return { merged, unlisted };
}

/**
 * One pull request's change set: the changed symbol and file ids (`nodes`) and their blast radius (`radius`), from
 * `reviewDiff` and the review engine's consumers. `source` is `pr`, `state` `in_review`, `links` empty. Cuts the
 * radius to 500 entries for hops 1 to 3 and 2,500 for hop 4 and over, and `nodes` to 5,000 ids; each cut sets its
 * `*_total` field and adds a warning line. Throws when `head_ref` or `base_branch` is missing.
 */
export async function buildChangeSet(
  store: Store,
  paths: GantryPaths,
  input: ChangeSetInput,
  /** Cut sizes; a test lowers them. The wire values are the defaults. */
  caps: { nodes?: number; near?: number; reachable?: number } = {},
): Promise<BuiltChangeSet> {
  if (typeof input.head_ref !== "string") {
    throw new Error("buildChangeSet: head_ref (the pull request's head branch) is required");
  }
  if (typeof input.base_branch !== "string" || input.base_branch === "") {
    throw new Error("buildChangeSet: base_branch is required");
  }
  const diff = await reviewDiff(paths, input.base, input.head);
  const impact = computeImpact(store, diff.changes, { files: diff.files.map((f) => f.path) });
  const warnings: string[] = [];

  const allNodes = [
    ...new Set([...diff.changes.map((c) => c.id), ...diff.files.map((f) => makeFileId(paths.repo, f.path))]),
  ].sort(cmp);
  const nodeCut = cutNodes(allNodes, caps.nodes);
  if (nodeCut.warning !== undefined) warnings.push(nodeCut.warning);

  const { merged, unlisted } = mergeRadius(impact.consumers);
  const cut = cutRadius({ merged, unlisted }, caps.near, caps.reachable);
  if (cut.warning !== undefined) warnings.push(cut.warning);

  const now = input.now ?? new Date().toISOString();
  const changeSet = parseOrThrow("change set", ChangeSetSchema, {
    id: changeSetIdForPr(paths.repo, input.pr),
    repo: paths.repo,
    source: "pr",
    state: "in_review",
    ref: `#${input.pr}`,
    head_ref: input.head_ref,
    base_branch: input.base_branch,
    nodes: nodeCut.nodes,
    ...(nodeCut.nodes_total !== undefined ? { nodes_total: nodeCut.nodes_total } : {}),
    radius: cut.radius,
    ...(cut.reachable_total !== undefined ? { reachable_total: cut.reachable_total } : {}),
    estimated: false,
    owner: input.owner,
    ...(input.title !== undefined ? { title: input.title } : {}),
    pr: input.pr,
    head_sha: revParse(paths, input.head),
    created_at: input.created_at ?? now,
    updated_at: now,
    links: [],
  });
  return { changeSet, warnings };
}

function revParse(paths: GantryPaths, ref: string): string {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
    cwd: paths.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = r.status === 0 ? r.stdout.trim() : "";
  if (sha === "") throw new Error(`unknown git ref: ${ref}`);
  return sha;
}

/** The NDJSON records of a main snapshot in the protocol's fixed order. */
export function snapshotRecords(snapshot: MainSnapshot): PartRecord[] {
  return mainSnapshotRecords(snapshot);
}

/** The NDJSON records of a change set: the `c` record, the sorted nodes, the radius sorted by hop then id. */
export function changeSetRecords(changeSet: ChangeSet): PartRecord[] {
  return protocolChangeSetRecords(changeSet);
}

/**
 * What a dry run summarises: the gzipped parts of a main snapshot or change set, the body of a close request, or the
 * bodies of the description requests, exactly as the real upload would send them.
 */
export type DryRunPayload =
  | { kind: "main" | "change_set"; parts: readonly Uint8Array[] }
  | { kind: "close"; body: string }
  | { kind: "descriptions"; bodies: readonly string[] };

export interface PayloadSummary {
  kind: DryRunPayload["kind"];
  /** Text bytes: the decompressed parts (each record and its newline), or the request bodies. */
  bytes: number;
  /** Gzip bytes: the sum over the parts, or over each request body gzipped on its own. */
  gzip_bytes: number;
  parts: number;
  fields: Record<string, { count: number; bytes: number }>;
}

const SECTION_OF_TAG: Record<string, string> = {
  w: "workspaces",
  f: "files",
  s: "symbols",
  e: "edges",
  a: "adapter_nodes",
  c: "change_set",
  n: "nodes",
  r: "radius",
};

const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * The short view of an upload for `gantry upload --dry-run --summary`: counts and sizes per field, no content. Keys are
 * sorted at every level so the same payload always prints the same text.
 */
export function summarisePayload(payload: DryRunPayload): PayloadSummary {
  const fields = new Map<string, { count: number; bytes: number }>();
  const add = (name: string, bytes: number, count = 1): void => {
    const entry = fields.get(name) ?? { count: 0, bytes: 0 };
    entry.count += count;
    entry.bytes += bytes;
    fields.set(name, entry);
  };
  let bytes = 0;
  let gzipBytes = 0;
  let parts = 0;
  if (payload.kind === "close") {
    const body = JSON.parse(payload.body) as Record<string, unknown>;
    for (const [name, value] of Object.entries(body)) add(name, utf8(JSON.stringify(value)));
    bytes = utf8(payload.body);
    gzipBytes = gzipSync(payload.body).length;
    parts = 1;
  } else if (payload.kind === "descriptions") {
    for (const body of payload.bodies) {
      const request = JSON.parse(body) as { descriptions: unknown[] };
      add("descriptions", utf8(JSON.stringify(request.descriptions)), request.descriptions.length);
      bytes += utf8(body);
      gzipBytes += gzipSync(body).length;
    }
    parts = payload.bodies.length;
  } else {
    for (const part of payload.parts) {
      const text = gunzipSync(part).toString("utf8");
      bytes += utf8(text);
      gzipBytes += part.length;
      for (const line of text.split("\n")) {
        if (line === "") continue;
        const tag = (JSON.parse(line) as { t: string }).t;
        add(SECTION_OF_TAG[tag] ?? tag, utf8(line));
      }
    }
    parts = payload.parts.length;
  }
  const sorted = [...fields.entries()].sort(([a], [b]) => cmp(a, b));
  return {
    kind: payload.kind,
    bytes,
    gzip_bytes: gzipBytes,
    parts,
    fields: Object.fromEntries(sorted),
  };
}
