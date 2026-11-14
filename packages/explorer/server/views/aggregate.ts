import type { EdgeRecord } from "@gantry/core";
import type { GraphEdge } from "../types.js";
import { getOrInit } from "./options.js";

/**
 * The one definition of "N imports" between two nodes at any level (workspace, directory, file):
 * the number of distinct file-level `imports` edges (importing file -> imported file) whose ends fall
 * under those two nodes. `bindings` is the sum of the imported-name counts of those edges, kept for tooltips.
 * `depends_on` edges are never part of it. Both the project map and the 3D map aggregate through here.
 */
export interface ImportTally {
  imports: number;
  bindings: number;
  low: boolean;
  seen: Set<string>;
}

export function newImportTally(): ImportTally {
  return { imports: 0, bindings: 0, low: false, seen: new Set() };
}

/** Adds one file-level imports edge; a repeated (src file, dst file) pair counts once. */
export function addImportEdge(t: ImportTally, e: EdgeRecord): void {
  if (e.confidence === "low") t.low = true;
  const k = `${e.src}\0${e.dst}`;
  if (t.seen.has(k)) return;
  t.seen.add(k);
  t.imports += 1;
  t.bindings += e.count;
}

/** Builds the view edge for a tally; `bindings` is present only when it differs from the import count. */
export function importGraphEdge(src: string, dst: string, t: ImportTally): GraphEdge {
  const edge: GraphEdge = {
    id: `${src}|imports|${dst}`,
    src,
    dst,
    kind: "imports",
    weight: t.imports,
    confidence: t.low ? "low" : "high",
  };
  if (t.bindings !== t.imports) edge.bindings = t.bindings;
  return edge;
}

/** Sums file-level imports edges per ordered pair of view nodes. */
export class ImportAggregator {
  private readonly m = new Map<string, { src: string; dst: string; tally: ImportTally }>();

  add(src: string, dst: string, e: EdgeRecord): void {
    if (src === dst) return;
    const entry = getOrInit(this.m, `${src}\0${dst}`, () => ({ src, dst, tally: newImportTally() }));
    addImportEdge(entry.tally, e);
  }

  edges(): GraphEdge[] {
    return [...this.m.values()].map((x) => importGraphEdge(x.src, x.dst, x.tally));
  }
}
