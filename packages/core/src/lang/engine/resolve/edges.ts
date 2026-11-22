import { EVIDENCE_CAP } from "../../../resolve/index.js";
import type { EdgeKind, EdgeLevel, EdgeRecord } from "../../../types.js";

/**
 * Accumulates the edges of one file by (src, dst, kind): counts add up, evidence is capped, `high` wins. With a `level`
 * every edge carries it (the level of the resolver that produced the edge).
 */
export class EdgeSet {
  private readonly map = new Map<string, EdgeRecord>();
  constructor(
    private readonly fileId: string,
    private readonly level?: EdgeLevel,
  ) {}

  add(src: string, dst: string, kind: EdgeKind, confidence: "high" | "low", evidence: string): void {
    const key = `${src}\0${dst}\0${kind}`;
    let e = this.map.get(key);
    if (!e) {
      e = { src, dst, kind, confidence, count: 0, evidence: [], fileId: this.fileId };
      if (this.level !== undefined) e.level = this.level;
      this.map.set(key, e);
    }
    e.count++;
    if (confidence === "high") e.confidence = "high";
    if (e.evidence.length < EVIDENCE_CAP && !e.evidence.includes(evidence)) e.evidence.push(evidence);
  }

  edges(): EdgeRecord[] {
    return [...this.map.values()];
  }
}
