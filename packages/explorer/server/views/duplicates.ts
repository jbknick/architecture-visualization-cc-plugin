import {
  contentKey,
  type FileRecord,
  getVector,
  minhashJaccard,
  type Store,
  type SymbolRecord,
  storedKeys,
  type Tier,
  vecAvailable,
  type WorkspaceRecord,
} from "@gantry/core";
import type { ApiContext, GraphEdge, GraphNode, ViewModule, ViewParams, ViewResult } from "../types.js";
import { adviceFor, type MemberAdvice } from "./dupAdvice.js";
import { shortWorkspaceLabels } from "./labels.js";
import { cmp, isTestPath, optBool, optInt, optList } from "./options.js";

const TIER_ORDER: readonly Tier[] = ["exact", "near", "code_vector", "semantic"];
const TIER_RANK: Record<Tier, number> = { exact: 0, near: 1, code_vector: 2, semantic: 3 };
const CALLER_KINDS = ["calls", "renders", "uses_hook"] as const;
/** The view returns at most this many groups (the best-ranked); the summary counts what is returned. */
export const MAX_CLUSTERS = 500;

export interface DupMember {
  id: string;
  name: string;
  kind: string;
  path: string;
  line: number;
  endLine: number;
  loc: number;
  workspaceId: string | null;
  exported: boolean;
  /** Distinct functions that call, render or use it. */
  fanIn: number;
  /** How this member relates to the keep candidate; null on the keep candidate itself. */
  tier: Tier | null;
  /** Similarity to the keep candidate in 0..1 (1 only for identical code); null when it cannot be measured. */
  score: number | null;
  keep: boolean;
  advice?: MemberAdvice;
}

export interface DupCluster {
  id: string;
  /** The loosest link inside the cluster: what the whole group can honestly be called. */
  tier: Tier;
  /** Number of similar_to links per tier. */
  tiers: Record<Tier, number>;
  size: number;
  loc: number;
  /** size x loc. */
  rank: number;
  keep: string;
  keepReason: string;
  /** Distinct workspace ids of the members, sorted. */
  workspaces: string[];
  members: DupMember[];
  /** The similar_to links that hold the group together (`a` < `b`), so a client knows which pairs to dismiss. */
  links: { a: string; b: string; tier: Tier }[];
}

export interface DupWorkspace {
  id: string;
  name: string;
  shortLabel: string;
  kind: string;
}

export interface DupSkipInfo {
  tier: Tier;
  reason: "vectors_unavailable" | "not_embedded" | "no_description";
  message: string;
}

export interface DupSplit {
  /** Sorted workspace ids the groups span; one id means "within one workspace". */
  workspaces: string[];
  clusters: number;
  functions: number;
}

export interface DuplicatesResult extends ViewResult {
  layoutHint: "clusters";
  clusters: DupCluster[];
  summary: { clusters: number; functions: number; duplicateLines: number; crossWorkspace: number };
  splits: DupSplit[];
  workspaces: DupWorkspace[];
  skipped: DupSkipInfo[];
}

interface Link {
  a: string;
  b: string;
  tier: Tier;
}

interface Info {
  sym: SymbolRecord;
  file: FileRecord;
  ws: WorkspaceRecord | undefined;
  fanIn: number;
}

const parseTier = (evidence: string[]): Tier => {
  const t = evidence[0];
  return (TIER_ORDER as readonly string[]).includes(t ?? "") ? (t as Tier) : "near";
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Union-find over symbol ids; the smaller id is always the root, so the result does not depend on edge order. */
class Components {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== (this.parent.get(root) as string)) root = this.parent.get(root) as string;
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const [lo, hi] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent.set(hi, lo);
  }
  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of [...this.parent.keys()]) {
      const r = this.find(id);
      const list = out.get(r);
      if (list) list.push(id);
      else out.set(r, [id]);
    }
    return out;
  }
}

/** Why the keep candidate was chosen, from the facts that decided it. */
function keepReason(k: Info, size: number): string {
  const parts: string[] = [];
  if (k.ws?.kind === "package") parts.push(`in the shared package ${k.ws.name}`);
  else if (k.ws) parts.push(`in ${k.ws.name}`);
  parts.push(k.sym.exported ? "exported" : "not exported yet");
  parts.push(k.fanIn === 1 ? "called by 1 function" : `called by ${k.fanIn} functions`);
  const text = parts.join(", ");
  const others = size > 2 ? `the other ${size - 1} copies` : "the other copy";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}; ${others} can use it.`;
}

/** Shared package first, then exported, then most callers; path and id make the choice stable. */
function pickKeep(infos: Info[]): Info {
  const rank = (i: Info): number => (i.ws?.kind === "package" ? 2 : 0) + (i.sym.exported ? 1 : 0);
  return [...infos].sort(
    (a, b) =>
      rank(b) - rank(a) || b.fanIn - a.fanIn || cmp(a.file.path, b.file.path) || cmp(a.sym.id, b.sym.id),
  )[0] as Info;
}

function vectorOf(store: Store, s: SymbolRecord): Float32Array | undefined {
  return s.exactHash === "" ? undefined : getVector(store, "vec_code", contentKey(s.exactHash));
}

interface RelationInput {
  store: Store;
  keep: SymbolRecord;
  keepVec: Float32Array | undefined;
  nearJaccard: number;
  codeVectorMin: number;
}

/** How `m` relates to the keep candidate: the direct link's tier if there is one, else measured from the hashes. */
function relation(
  inp: RelationInput,
  m: SymbolRecord,
  directTier: Tier | undefined,
  ownTier: Tier | undefined,
): { tier: Tier; score: number | null } {
  const { keep } = inp;
  const identical = keep.exactHash !== "" && keep.exactHash === m.exactHash;
  const sameShape = keep.shapeHash !== "" && keep.shapeHash === m.shapeHash;
  const jac =
    keep.minhash.length > 0 && keep.minhash.length === m.minhash.length
      ? minhashJaccard(keep.minhash, m.minhash)
      : null;
  const mv = inp.keepVec ? vectorOf(inp.store, m) : undefined;
  const cos = inp.keepVec && mv ? cosine(inp.keepVec, mv) : null;
  let tier: Tier;
  if (identical) tier = "exact";
  else if (directTier) tier = directTier;
  else if (sameShape || (jac !== null && jac >= inp.nearJaccard)) tier = "near";
  else if (cos !== null && cos >= inp.codeVectorMin) tier = "code_vector";
  else tier = ownTier ?? "near";
  let score: number | null;
  if (tier === "exact") score = 1;
  else if (tier === "code_vector") score = cos ?? jac;
  else score = jac ?? (sameShape ? 1 : null);
  return { tier, score: score === null ? null : round3(score) };
}

/** Which of the wanted vector tiers cannot contribute, and what to do about it. */
function skippedTiers(store: Store, wanted: ReadonlySet<Tier>): DupSkipInfo[] {
  const out: DupSkipInfo[] = [];
  if (!vecAvailable(store)) {
    const message =
      "Vector search is not available on this machine, so renamed and reworded copies are not checked.";
    if (wanted.has("code_vector")) out.push({ tier: "code_vector", reason: "vectors_unavailable", message });
    if (wanted.has("semantic")) out.push({ tier: "semantic", reason: "vectors_unavailable", message });
    return out;
  }
  if (wanted.has("code_vector") && storedKeys(store, "vec_code").size === 0) {
    out.push({
      tier: "code_vector",
      reason: "not_embedded",
      message: "Run gantry embed to also find renamed copies.",
    });
  }
  if (wanted.has("semantic") && storedKeys(store, "vec_descriptions").size === 0) {
    out.push({
      tier: "semantic",
      reason: "no_description",
      message: "Run gantry embed to also find code that does the same thing in different words.",
    });
  }
  return out;
}

/**
 * View 3. Clusters are the connected components of the `similar_to` edges that survive the options
 * (`tiers` list, default all; `hideTests` default true), minus dismissed pairs. Options on the groups:
 * `workspaces` (keep groups with a member in one of them), `minSize` (default 2). Groups are ranked by
 * size x total lines of code, then size, then id. The keep candidate is the member in a shared package
 * (workspace kind "package"), then exported, then with the most callers, then by path.
 */
export function buildDuplicates(ctx: ApiContext, params: ViewParams): DuplicatesResult {
  const { store, config } = ctx;
  const hideTests = optBool(params, "hideTests", true);
  const tierFilter = new Set<Tier>(
    (optList(params, "tiers") ?? TIER_ORDER).filter((t): t is Tier =>
      (TIER_ORDER as readonly string[]).includes(t),
    ),
  );
  const wsFilter = optList(params, "workspaces");
  const minSize = Math.max(2, optInt(params, "minSize") ?? 2);

  const workspaces = store.listWorkspaces();
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const short = shortWorkspaceLabels(workspaces.map((w) => w.name));
  const files = new Map(store.effectiveFiles().map((f) => [f.id, f]));
  const symbols = new Map(store.effectiveSymbols().map((s) => [s.id, s]));
  const dismissed = new Set(
    (store.db.prepare("SELECT a, b FROM dismissals").all() as { a: string; b: string }[]).map(
      (r) => `${r.a}\n${r.b}`,
    ),
  );

  const links: Link[] = [];
  for (const e of store.effectiveEdges({ kind: ["similar_to"] })) {
    const [a, b] = e.src < e.dst ? [e.src, e.dst] : [e.dst, e.src];
    const tier = parseTier(e.evidence);
    if (!tierFilter.has(tier) || dismissed.has(`${a}\n${b}`)) continue;
    const sa = symbols.get(a);
    const sb = symbols.get(b);
    const fa = sa && files.get(sa.fileId);
    const fb = sb && files.get(sb.fileId);
    if (!fa || !fb) continue;
    if (hideTests && (isTestPath(fa.path) || isTestPath(fb.path))) continue;
    links.push({ a, b, tier });
  }

  const callers = new Map<string, Set<string>>();
  for (const e of store.effectiveEdges({ kind: [...CALLER_KINDS] })) {
    if (e.src === e.dst) continue;
    let set = callers.get(e.dst);
    if (!set) {
      set = new Set();
      callers.set(e.dst, set);
    }
    set.add(e.src);
  }

  const comps = new Components();
  for (const l of links) comps.union(l.a, l.b);
  const linksOf = new Map<string, Link[]>();
  for (const l of links) {
    const root = comps.find(l.a);
    const list = linksOf.get(root);
    if (list) list.push(l);
    else linksOf.set(root, [l]);
  }

  const thresholds = config.duplicates?.thresholds;
  const clusters: DupCluster[] = [];
  const keepOf = new Map<string, SymbolRecord>();

  for (const [root, ids] of comps.groups()) {
    if (ids.length < minSize) continue;
    const infos: Info[] = ids.map((id) => {
      const sym = symbols.get(id) as SymbolRecord;
      const file = files.get(sym.fileId) as FileRecord;
      return {
        sym,
        file,
        ws: file.workspaceId ? wsById.get(file.workspaceId) : undefined,
        fanIn: callers.get(id)?.size ?? 0,
      };
    });
    if (wsFilter && !infos.some((i) => i.file.workspaceId && wsFilter.includes(i.file.workspaceId))) continue;

    const keepInfo = pickKeep(infos);
    const direct = new Map<string, Tier>();
    const weakestOwn = new Map<string, Tier>();
    const tiers: Record<Tier, number> = { exact: 0, near: 0, code_vector: 0, semantic: 0 };
    let loosest: Tier = "exact";
    for (const l of linksOf.get(root) ?? []) {
      tiers[l.tier] += 1;
      if (TIER_RANK[l.tier] > TIER_RANK[loosest]) loosest = l.tier;
      if (l.a === keepInfo.sym.id) direct.set(l.b, l.tier);
      if (l.b === keepInfo.sym.id) direct.set(l.a, l.tier);
      for (const id of [l.a, l.b]) {
        const w = weakestOwn.get(id);
        if (!w || TIER_RANK[l.tier] > TIER_RANK[w]) weakestOwn.set(id, l.tier);
      }
    }
    const rel: RelationInput = {
      store,
      keep: keepInfo.sym,
      keepVec: vectorOf(store, keepInfo.sym),
      nearJaccard: thresholds?.nearJaccard ?? 0.85,
      codeVectorMin: thresholds?.codeVector ?? 0.96,
    };
    const ordered = [...infos].sort((x, y) =>
      x === keepInfo ? -1 : y === keepInfo ? 1 : cmp(x.file.path, y.file.path) || cmp(x.sym.id, y.sym.id),
    );
    const members = ordered.map((i): DupMember => {
      const isKeep = i === keepInfo;
      const r = isKeep ? null : relation(rel, i.sym, direct.get(i.sym.id), weakestOwn.get(i.sym.id));
      return {
        id: i.sym.id,
        name: i.sym.name,
        kind: i.sym.kind,
        path: i.file.path,
        line: i.sym.startLine,
        endLine: i.sym.endLine,
        loc: i.sym.loc,
        workspaceId: i.file.workspaceId,
        exported: i.sym.exported,
        fanIn: i.fanIn,
        tier: r ? r.tier : null,
        score: isKeep ? 1 : (r?.score ?? null),
        keep: isKeep,
      };
    });
    const loc = members.reduce((s, m) => s + m.loc, 0);
    const id = `cluster:${[...ids].sort()[0]}`;
    keepOf.set(id, keepInfo.sym);
    clusters.push({
      id,
      tier: loosest,
      tiers,
      size: members.length,
      loc,
      rank: members.length * loc,
      keep: keepInfo.sym.id,
      keepReason: keepReason(keepInfo, members.length),
      workspaces: [
        ...new Set(infos.map((i) => i.file.workspaceId).filter((w): w is string => w !== null)),
      ].sort(),
      members,
      links: [...(linksOf.get(root) ?? [])].sort((x, y) => cmp(x.a, y.a) || cmp(x.b, y.b)),
    });
  }

  clusters.sort((a, b) => b.rank - a.rank || b.size - a.size || cmp(a.id, b.id));
  const shown = clusters.slice(0, MAX_CLUSTERS);

  const splitMap = new Map<string, DupSplit>();
  let functions = 0;
  let duplicateLines = 0;
  let crossWorkspace = 0;
  for (const c of shown) {
    const keep = keepOf.get(c.id) as SymbolRecord;
    for (const m of c.members) {
      if (m.keep) continue;
      const advice = adviceFor(store, config, m.path, keep);
      if (advice) m.advice = advice;
      duplicateLines += m.loc;
    }
    functions += c.size;
    if (c.workspaces.length > 1) crossWorkspace += 1;
    const key = c.workspaces.join("|");
    const s = splitMap.get(key) ?? { workspaces: c.workspaces, clusters: 0, functions: 0 };
    s.clusters += 1;
    s.functions += c.size;
    splitMap.set(key, s);
  }
  const splits = [...splitMap.values()].sort(
    (a, b) => b.clusters - a.clusters || cmp(a.workspaces.join("|"), b.workspaces.join("|")),
  );

  const nodes: GraphNode[] = [];
  const shownSyms = new Set<string>();
  for (const c of shown) {
    for (const m of c.members) {
      shownSyms.add(m.id);
      nodes.push({
        id: m.id,
        kind: m.kind,
        label: m.name,
        size: m.loc,
        path: m.path,
        stats: { functions: 1, loc: m.loc },
        ...(m.workspaceId ? { workspace: m.workspaceId } : {}),
        ...(m.keep ? { badges: ["keep"] } : {}),
      });
    }
  }
  const edges: GraphEdge[] = links
    .filter((l) => shownSyms.has(l.a) && shownSyms.has(l.b))
    .map((l) => ({
      id: `${l.a}|similar_to|${l.b}`,
      src: l.a,
      dst: l.b,
      kind: "similar_to",
      weight: 1,
      confidence: l.tier === "code_vector" ? ("low" as const) : ("high" as const),
    }));
  nodes.sort((a, b) => cmp(a.id, b.id));
  edges.sort((a, b) => cmp(a.id, b.id));

  return {
    nodes,
    edges,
    layoutHint: "clusters",
    clusters: shown,
    summary: { clusters: shown.length, functions, duplicateLines, crossWorkspace },
    splits,
    workspaces: workspaces
      .map((w) => ({ id: w.id, name: w.name, shortLabel: short.get(w.name) ?? w.name, kind: w.kind }))
      .sort((a, b) => cmp(a.id, b.id)),
    skipped: skippedTiers(store, tierFilter),
  };
}

export const duplicatesView: ViewModule = {
  id: "duplicates",
  title: "Duplicates",
  enabled: true,
  build: (ctx, params) => buildDuplicates(ctx, params),
};
