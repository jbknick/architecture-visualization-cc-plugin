import { checkImports } from "../advice/imports.js";
import { pathOfFileId } from "../describe/factsheet.js";
import { findDuplicates } from "../dup/engine.js";
import { parseSource } from "../parse/index.js";
import type { GantryPaths } from "../paths/index.js";
import type { Store } from "../store/index.js";
import type { EdgeKind } from "../types.js";
import { workspaceForPath } from "../workspace/index.js";
import { type ReviewDiff, readBlobText, type SymbolChange } from "./diff.js";
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
}

export const DEFAULT_MAX_HOPS = 3;
/** The walk stops after this many distinct callers. */
export const MAX_IMPACT_NODES = 500;

const REVERSE_KINDS: EdgeKind[] = ["calls", "renders", "uses_hook"];
const TEST_FILE_RE = /\.(?:test|spec)\.[^/]*$/;
const FUNCTION_LIKE = new Set(["function", "method", "component", "hook"]);
const NOTE_LIST = 3;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pathOfId = (id: string): string =>
  (id.startsWith("sym:") ? id.slice(4).split("#")[0] : pathOfFileId(id)) ?? "";
const list = (ids: string[]): string =>
  ids.length <= NOTE_LIST
    ? ids.join(", ")
    : `${ids.slice(0, NOTE_LIST).join(", ")} and ${ids.length - NOTE_LIST} more`;

export interface ImpactOptions {
  maxHops?: number;
}

/**
 * Impact of `changes` on the graph in `store` (spec section 11, "Impact and risk"; no model calls, no writes).
 * Breadth-first over reverse `calls`/`renders`/`uses_hook` edges from every modified, removed, renamed, moved or
 * signature-changed symbol (added symbols have no callers yet), plus the files that import the file of a removed,
 * renamed or moved symbol; a file node continues through the files that import it. Each caller is recorded at the
 * first hop it appears at, in sorted order, and the walk stops at `maxHops` (3) or 500 callers. Output is sorted
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

  const incoming = (dst: string, kinds: EdgeKind[]): string[] =>
    store
      .effectiveEdges({ dst, kind: kinds })
      .map((e) => e.src)
      .filter((s) => !s.startsWith("ext:") && s !== dst);

  const seen = new Set<string>(seeds);
  const callersByHop: Impact["callersByHop"] = [];
  const hop1: { seed: string; caller: string }[] = [];
  let capped = false;
  let frontier = seeds;
  for (let hop = 1; hop <= maxHops && frontier.length > 0 && !capped; hop++) {
    const found = new Set<string>();
    for (const node of frontier) {
      const srcs = new Set(
        incoming(node, node.startsWith("file:") ? [...REVERSE_KINDS, "imports"] : REVERSE_KINDS),
      );
      if (hop === 1 && !node.startsWith("file:")) {
        const c = seedChange.get(node);
        // A removed, renamed or moved export breaks every file that imports its file.
        if (
          c &&
          (c.kind === "removed" || c.kind === "renamed" || c.kind === "moved") &&
          (c.before?.exported ?? false)
        ) {
          for (const s of incoming(`file:${c.before?.path}`, ["imports"])) srcs.add(s);
        }
      }
      for (const s of [...srcs].sort(cmp)) {
        if (hop === 1) hop1.push({ seed: node, caller: s });
        if (seen.has(s)) continue;
        if (seen.size - seeds.length >= MAX_IMPACT_NODES) {
          capped = true;
          break;
        }
        seen.add(s);
        found.add(s);
      }
      if (capped) break;
    }
    if (found.size > 0) callersByHop.push({ hop, ids: [...found].sort(cmp) });
    frontier = [...found].sort(cmp);
  }
  if (capped)
    notes.push(`The caller walk stopped at ${MAX_IMPACT_NODES} nodes; deeper callers are not listed.`);

  // Crossings, judged between a changed symbol and its direct callers only.
  const workspaces = store.listWorkspaces();
  const fileRec = (path: string) => store.effectiveFile(`file:${path}`);
  const wsOf = (path: string) => (workspaces.length > 0 ? workspaceForPath(workspaces, path) : undefined);
  const isClient = (path: string): boolean => fileRec(path)?.directives?.includes("use client") ?? false;
  const crossingSet = new Map<string, Crossing>();
  for (const { seed, caller } of hop1) {
    const sp = pathOfId(seed);
    const cp = pathOfId(caller);
    if (sp === cp) continue;
    const sw = wsOf(sp);
    const cw = wsOf(cp);
    const add = (kind: Crossing["kind"]): void => {
      crossingSet.set(`${seed}\0${caller}\0${kind}`, { from: seed, to: caller, kind });
    };
    if (sw && cw && sw.id !== cw.id) add(cw.kind === "app" && sw.kind === "package" ? "app" : "workspace");
    if (isClient(sp) !== isClient(cp)) add("client_server");
  }
  const crossings = [...crossingSet.values()].sort(
    (a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind),
  );

  // Facts for the risk score.
  const hop1ByChange = new Map<SymbolChange, Set<string>>();
  for (const { seed, caller } of hop1) {
    const c = seedChange.get(seed);
    if (!c) continue;
    if (!hop1ByChange.has(c)) hop1ByChange.set(c, new Set());
    hop1ByChange.get(c)?.add(caller);
  }
  const hop1Callers = new Set(hop1.map((h) => h.caller).filter((id) => !seedSet.has(id)));
  const exportedNow = (c: SymbolChange): boolean =>
    (c.after?.exported ?? false) || (c.before?.exported ?? false);

  const removedStillUsed = sources.filter(
    (c) => c.kind === "removed" && (c.before?.exported ?? false) && (hop1ByChange.get(c)?.size ?? 0) > 0,
  );
  for (const c of removedStillUsed) {
    const users = [...(hop1ByChange.get(c) ?? [])].sort(cmp);
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
      .effectiveEdges({ dst: `file:${path}`, kind: ["imports"] })
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

  return { changed: [...changes], callersByHop, crossings, risk, notes };
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
  const impact = computeImpact(store, diff.changes, opts);
  const extra: string[] = [];

  const addedSpecs = new Map(diff.importChanges.map((c) => [c.path, new Set(c.added)]));
  for (const f of diff.files) {
    if (f.status === "D") continue;
    const specs = addedSpecs.get(f.path);
    if (!specs || specs.size === 0) continue;
    const source = readBlobText(paths.root, diff.head, f.path);
    if (source === undefined) continue;
    for (const finding of checkImports(store, f.path, parseSource(f.path, source))) {
      if (finding.kind === "undeclared" && specs.has(finding.specifier)) {
        extra.push(`New undeclared import "${finding.specifier}" in ${f.path}:${finding.line}.`);
      }
    }
  }

  const parsedCache = new Map<string, { source: string; parsed: ReturnType<typeof parseSource> } | null>();
  for (const c of diff.changes) {
    if (c.kind !== "added" || !c.after || !FUNCTION_LIKE.has(c.after.kind)) continue;
    const path = c.after.path;
    if (!parsedCache.has(path)) {
      const source = readBlobText(paths.root, diff.head, path);
      parsedCache.set(path, source === undefined ? null : { source, parsed: parseSource(path, source) });
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

/** Text summary for `gantry review` without `--json`: risk, reasons, hop counts, crossings and notes. */
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
  if (impact.notes.length > 0) {
    lines.push("Notes:");
    for (const n of impact.notes) lines.push(`  ${n}`);
  }
  return `${lines.join("\n")}\n`;
}
