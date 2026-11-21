import { checkImports } from "../advice/imports.js";
import { findDuplicates } from "../dup/engine.js";
import { isSymId, fileId as makeFileId, pathOfFileId } from "../ids.js";
import { parseFile } from "../lang/index.js";
import type { GantryPaths } from "../paths/index.js";
import type { Store } from "../store/index.js";
import {
  type ChangeConsumers,
  type Consumer,
  ConsumerGraph,
  computeConsumers,
  directConsumerUses,
  REACHABLE_FIRST_HOP,
  REACHABLE_NODE_CAP,
  type UseKind,
} from "./consumers.js";
import { type ReviewDiff, readBlobText, type SymbolChange } from "./diff.js";
import { type DirectUse, walkToEnd } from "./reachable.js";
import { COMPLEXITY_THRESHOLD, computeRisk, type Risk } from "./risk.js";

export interface Crossing {
  from: string;
  to: string;
  kind: "workspace" | "app" | "client_server";
}

export interface Impact {
  changed: SymbolChange[];
  callersByHop: { hop: number; ids: string[] }[];
  crossings: Crossing[];
  risk: Risk;
  notes: string[];
  /** Per changed symbol (by id), then per changed file (by path): directly, potentially affected and reachable consumers. */
  consumers: ChangeConsumers[];
  /** The reachable tier of the whole review (#293), counted per hop. */
  reachable: Reachable;
}

/**
 * The distinct nodes the impact walk first reached at hop 4 or later (hops 1 to 3 are in `callersByHop`), counted
 * per hop. The nodes themselves are in `consumers[].reachable`.
 */
export interface Reachable {
  total: number;
  byHop: { hop: number; count: number }[];
}

export const DEFAULT_MAX_HOPS = 3;
/** The walk stops after this many distinct callers. */
export const MAX_IMPACT_NODES = 500;

const TEST_FILE_RE = /\.(?:test|spec)\.[^/]*$/;
const FUNCTION_LIKE = new Set(["function", "method", "component", "hook"]);
const NOTE_LIST = 3;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const list = (ids: string[]): string =>
  ids.length <= NOTE_LIST
    ? ids.join(", ")
    : `${ids.slice(0, NOTE_LIST).join(", ")} and ${ids.length - NOTE_LIST} more`;

export interface ImpactOptions {
  maxHops?: number;
  /** Changed file paths: each gets its own consumers (the files that import it, then theirs). */
  files?: string[];
  /** Walk on past `maxHops` into the reachable tier (default true). False reads the graph per node, as before #293. */
  reachable?: boolean;
  /** Node cap of the walk to the end (default `REACHABLE_NODE_CAP`); a test can lower it. */
  reachableCap?: number;
}

/**
 * Impact of `changes` on the graph in `store` (spec section 11, "Impact and risk"; no model calls, no writes).
 * Hop 1 is every direct consumer (`CONSUMER_KINDS`: calls, renders, hook uses, extends, implements, type references
 * and route edges, plus the files importing an exported change's file that no symbol of theirs already stands for)
 * of every modified, removed, renamed, moved or signature-changed symbol (added symbols are not walked); hops 2 and 3
 * follow the same edge kinds, and a file node continues through the files that import it. Each caller is recorded at
 * the first hop it appears at, in sorted order, and the walk stops at `maxHops` (3) or 500 callers. `consumers` lists
 * both tiers per change and per changed file (`computeConsumers`). Output is sorted
 * and identical across runs.
 */
export function computeImpact(store: Store, changes: SymbolChange[], opts: ImpactOptions = {}): Impact {
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const notes: string[] = [];
  const sources = changes.filter((c) => c.kind !== "added");

  // Seeds: ids the graph may know the symbol by (after the change, and before it for a rename or move).
  const seedChange = new Map<string, SymbolChange>();
  for (const c of sources) {
    for (const id of [c.after?.id, c.before?.id])
      if (id !== undefined && !seedChange.has(id)) seedChange.set(id, c);
  }
  const seeds = [...seedChange.keys()].sort(cmp);
  const seedSet = new Set(seeds);

  const g = new ConsumerGraph(store);
  // Hop 1: every direct consumer of a changed symbol (all consumer edge kinds, plus importers of an exported change's
  // file that no symbol of theirs already stands for; see `directConsumers`).
  const directBy = new Map<SymbolChange, Map<string, Set<UseKind>>>();
  const directUse = new Map<string, DirectUse>();
  for (const c of sources) {
    const uses = directConsumerUses(g, c);
    directBy.set(c, new Map([...uses].map(([id, u]) => [id, u.uses])));
    for (const [id, u] of uses) {
      const prior = directUse.get(id);
      if (prior) {
        for (const k of u.uses) prior.uses.add(k);
        prior.high = prior.high || u.high;
      } else directUse.set(id, { uses: new Set(u.uses), high: u.high });
    }
  }
  // Past the first hop the walk reads the whole graph from memory: one query instead of one per node.
  const reachableOn = opts.reachable ?? true;
  const cap = opts.reachableCap ?? REACHABLE_NODE_CAP;
  if (reachableOn && directUse.size > 0) g.preload();

  const seen = new Set<string>(seeds);
  const callersByHop: Impact["callersByHop"] = [];
  let capped = false;
  const take = (ids: Iterable<string>, found: Set<string>): void => {
    for (const s of [...ids].sort(cmp)) {
      if (seen.has(s)) continue;
      if (seen.size - seeds.length >= MAX_IMPACT_NODES) {
        capped = true;
        return;
      }
      seen.add(s);
      found.add(s);
    }
  };
  let frontier: string[] = [];
  if (maxHops >= 1) {
    const found = new Set<string>();
    take(new Set([...directBy.values()].flatMap((m) => [...m.keys()])), found);
    if (found.size > 0) callersByHop.push({ hop: 1, ids: [...found].sort(cmp) });
    frontier = [...found].sort(cmp);
  }
  for (let hop = 2; hop <= maxHops && frontier.length > 0 && !capped; hop++) {
    const found = new Set<string>();
    for (const node of frontier) {
      take(
        g.incoming(node).map((n) => n.src),
        found,
      );
      if (capped) break;
    }
    if (found.size > 0) callersByHop.push({ hop, ids: [...found].sort(cmp) });
    frontier = [...found].sort(cmp);
  }
  if (capped)
    notes.push(`The caller walk stopped at ${MAX_IMPACT_NODES} nodes; deeper callers are not listed.`);
  // Past hop 3 the walk goes on to the node cap, whether or not the stop above was hit.
  const reachable: Reachable = { total: 0, byHop: [] };
  if (reachableOn) {
    const walk = walkToEnd(g, directUse, seedSet, cap);
    const perHop = new Map<number, number>();
    for (const r of walk.rows)
      if (r.hop >= REACHABLE_FIRST_HOP) perHop.set(r.hop, (perHop.get(r.hop) ?? 0) + 1);
    reachable.byHop = [...perHop].sort((x, y) => x[0] - y[0]).map(([hop, count]) => ({ hop, count }));
    reachable.total = reachable.byHop.reduce((n, h) => n + h.count, 0);
    if (walk.capped)
      notes.push(`The reachable walk stopped at ${cap} nodes; deeper consumers are not listed.`);
  }

  // Crossings, judged between a changed symbol and its direct consumers only.
  const crossingSet = new Map<string, Crossing>();
  for (const [c, direct] of directBy) {
    const sp = (c.after ?? c.before)?.path ?? g.pathOf(c.id);
    for (const caller of direct.keys()) {
      for (const kind of g.crossings(sp, g.pathOf(caller)))
        crossingSet.set(`${c.id}\0${caller}\0${kind}`, { from: c.id, to: caller, kind });
    }
  }
  const crossings = [...crossingSet.values()].sort(
    (a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind),
  );

  // Facts for the risk score.
  const hop1Callers = new Set(
    [...directBy.values()].flatMap((m) => [...m.keys()]).filter((id) => !seedSet.has(id)),
  );
  const exportedNow = (c: SymbolChange): boolean =>
    (c.after?.exported ?? false) || (c.before?.exported ?? false);

  const removedStillUsed = sources.filter(
    (c) => c.kind === "removed" && (c.before?.exported ?? false) && (directBy.get(c)?.size ?? 0) > 0,
  );
  for (const c of removedStillUsed) {
    const users = [...(directBy.get(c)?.keys() ?? [])].sort(cmp);
    notes.push(`Removed export ${c.id} is still used by ${users.length} node(s): ${list(users)}.`);
  }

  const missing = sources.filter(
    (c) => !(c.after && store.getSymbol(c.after.id)) && !(c.before && store.getSymbol(c.before.id)),
  );
  if (missing.length > 0) {
    notes.push(
      `${missing.length} changed symbol(s) are not in the index (${list(missing.map((c) => c.id).sort(cmp))}); their callers are listed only if the index still holds them.`,
    );
  }

  const importedByTest = (path: string): boolean =>
    store
      .effectiveEdges({ dst: makeFileId(store.repo(), path), kind: ["imports"] })
      .some((e) => TEST_FILE_RE.test(pathOfFileId(e.src)));
  const functions = sources.filter((c) => {
    const side = c.after ?? c.before;
    return side !== undefined && FUNCTION_LIKE.has(side.kind) && !TEST_FILE_RE.test(side.path);
  });
  const maxComplexity = Math.max(
    0,
    ...sources.filter((c) => c.after && FUNCTION_LIKE.has(c.after.kind)).map((c) => c.after?.complexity ?? 0),
  );

  const risk = computeRisk({
    signatureChangedExported: sources.some((c) => c.signatureChanged && exportedNow(c)),
    removedExportedWithCallers: removedStillUsed.length > 0,
    hop1Callers: hop1Callers.size,
    crossings: crossings.length,
    maxComplexity: maxComplexity > COMPLEXITY_THRESHOLD ? maxComplexity : 0,
    untested: functions.some((c) => !importedByTest((c.after ?? c.before)?.path ?? "")),
  });

  const consumers = computeConsumers(g, changes, opts.files ?? [], maxHops, reachableOn ? cap : null);
  return { changed: [...changes], callersByHop, crossings, risk, notes, consumers, reachable };
}

/**
 * `computeImpact` for a reviewed range plus the notes that need the head's files: new imports no workspace
 * declares (`checkImports` on the head blobs, only for specifiers the diff added) and added functions that
 * duplicate indexed code (`findDuplicates`, exact and near tiers). Reads blobs with `git show`; writes nothing.
 */
export async function reviewImpact(
  paths: GantryPaths,
  store: Store,
  diff: ReviewDiff,
  opts: ImpactOptions = {},
): Promise<Impact> {
  const impact = computeImpact(store, diff.changes, { files: diff.files.map((f) => f.path), ...opts });
  const extra: string[] = [];

  const addedSpecs = new Map(diff.importChanges.map((c) => [c.path, new Set(c.added)]));
  for (const f of diff.files) {
    if (f.status === "D") continue;
    const specs = addedSpecs.get(f.path);
    if (!specs || specs.size === 0) continue;
    const source = readBlobText(paths.root, diff.head, f.path);
    if (source === undefined) continue;
    for (const finding of checkImports(store, f.path, parseFile(paths.repo, f.path, source))) {
      if (finding.kind === "undeclared" && specs.has(finding.specifier)) {
        extra.push(`New undeclared import "${finding.specifier}" in ${f.path}:${finding.line}.`);
      }
    }
  }

  const parsedCache = new Map<string, { source: string; parsed: ReturnType<typeof parseFile> } | null>();
  for (const c of diff.changes) {
    if (c.kind !== "added" || !c.after || !FUNCTION_LIKE.has(c.after.kind)) continue;
    const path = c.after.path;
    if (!parsedCache.has(path)) {
      const source = readBlobText(paths.root, diff.head, path);
      parsedCache.set(
        path,
        source === undefined ? null : { source, parsed: parseFile(paths.repo, path, source) },
      );
    }
    const entry = parsedCache.get(path);
    const body = entry?.parsed.bodies.get(c.after.id);
    if (!entry || !body) continue;
    const cands = await findDuplicates(
      store,
      {
        code: {
          source: entry.source.slice(body.start, body.end),
          lang: path.endsWith(".tsx") ? "tsx" : "ts",
          path,
        },
        kind: c.after.kind,
      },
      { tiers: ["exact", "near"], excludeIds: [c.id], limit: 3 },
    );
    for (const d of cands)
      extra.push(`New function ${c.id} duplicates ${d.symbolId} (${d.tier}, score ${d.score.toFixed(2)}).`);
  }

  return { ...impact, notes: [...impact.notes, ...extra.sort(cmp)] };
}

/** Changes that stand for "these symbols were modified" (working layer against main), for `paths` and `symbol` input. */
export function modifiedChanges(store: Store, ids: string[]): SymbolChange[] {
  const out: SymbolChange[] = [];
  for (const id of [...new Set(ids)].sort(cmp)) {
    const s = store.getSymbol(id);
    if (!s) continue;
    const side = {
      id: s.id,
      path: pathOfFileId(s.fileId),
      line: s.startLine,
      signature: s.signature,
      exactHash: s.exactHash,
      kind: s.kind,
      exported: s.exported,
      complexity: s.complexity,
    };
    out.push({
      id: s.id,
      kind: "modified",
      before: side,
      after: side,
      signatureChanged: false,
      exportedChanged: false,
      locDelta: 0,
    });
  }
  return out;
}

/** Changes, direct and potential consumers listed per change in the text summary (the JSON has them all). */
const TEXT_CHANGES = 20;
const TEXT_DIRECT = 5;
const TEXT_POTENTIAL = 3;

/** `HomePage (component, apps/web/src/routes/index.tsx:5) renders; crosses app`, or `... hop 2 via X` (potential). */
function consumerLine(c: Consumer): string {
  const where = c.line === null ? c.path : `${c.path}:${c.line}`;
  const via =
    c.via !== undefined
      ? ` hop ${c.hop} via ${c.via.slice(c.via.lastIndexOf(isSymId(c.via) ? "#" : "/") + 1)}`
      : "";
  const crosses = c.crosses.length > 0 ? `; crosses ${c.crosses.join(", ")}` : "";
  return `${c.name} (${c.kind}${where ? `, ${where}` : ""}) ${c.uses.join(", ")}${via}${crosses}`;
}

/** Text summary for `gantry review` without `--json`: risk, reasons, hop counts, crossings, consumers and notes. */
export function formatImpact(diff: ReviewDiff, impact: Impact): string {
  const lines: string[] = [];
  const kinds = new Map<string, number>();
  for (const c of impact.changed) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  const kindText = [...kinds.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  lines.push(
    `Review ${diff.base}...${diff.head}: ${diff.files.length} file(s), ${impact.changed.length} symbol change(s)${kindText ? ` (${kindText})` : ""}`,
  );
  lines.push(`Risk: ${impact.risk.level} (${impact.risk.score}/100)`);
  for (const r of impact.risk.reasons) lines.push(`  ${r}`);
  if (impact.callersByHop.length === 0) lines.push("Callers: none");
  else {
    lines.push("Callers by hop:");
    for (const h of impact.callersByHop)
      lines.push(`  hop ${h.hop}: ${h.ids.length}${h.hop === 1 ? ` (${list(h.ids)})` : ""}`);
  }
  if (impact.crossings.length > 0) {
    lines.push(`Crossings: ${impact.crossings.length}`);
    for (const x of impact.crossings.slice(0, 5)) lines.push(`  ${x.kind}: ${x.from} <- ${x.to}`);
    if (impact.crossings.length > 5) lines.push(`  and ${impact.crossings.length - 5} more`);
  }
  const used = impact.consumers.filter((c) => c.directTotal + c.potentialTotal > 0);
  for (const c of used.slice(0, TEXT_CHANGES)) {
    lines.push(`Consumers of ${c.id}:`);
    lines.push(`  Directly affected (${c.directTotal}):`);
    for (const d of c.direct.slice(0, TEXT_DIRECT)) lines.push(`    ${consumerLine(d)}`);
    if (c.directTotal > TEXT_DIRECT) lines.push(`    and ${c.directTotal - TEXT_DIRECT} more`);
    lines.push(`  Potentially affected (${c.potentialTotal}):`);
    for (const p of c.potential.slice(0, TEXT_POTENTIAL)) lines.push(`    ${consumerLine(p)}`);
    if (c.potentialTotal > TEXT_POTENTIAL) lines.push(`    and ${c.potentialTotal - TEXT_POTENTIAL} more`);
  }
  if (used.length > TEXT_CHANGES)
    lines.push(`Consumers of ${used.length - TEXT_CHANGES} more change(s) are in --json.`);
  if (impact.notes.length > 0) {
    lines.push("Notes:");
    for (const n of impact.notes) lines.push(`  ${n}`);
  }
  return `${lines.join("\n")}\n`;
}
