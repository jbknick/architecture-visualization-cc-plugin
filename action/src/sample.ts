// Typed sample inputs for the Action's tests: the shapes of `gantry review --json` and `gantry duplicates --json`,
// checked against the real types by tsc, so a change to either output breaks the build here first.
import type { DuplicatesJson, ReviewJson } from "./comment.js";

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "b".repeat(40);

export function sampleReview(
  over: { symbols?: number; consumersPer?: number; nameLength?: number } = {},
): ReviewJson {
  const n = over.symbols ?? 2;
  const per = over.consumersPer ?? 3;
  const pad = "x".repeat(over.nameLength ?? 0);
  const changed: ReviewJson["changes"] = [];
  const consumers: NonNullable<ReviewJson["impact"]>["consumers"] = [];
  for (let i = 0; i < n; i++) {
    const path = `packages/app/src/feature${i}${pad}.ts`;
    const id = `sym:repo:${path}#doThing${i}${pad}`;
    const side = {
      id,
      path,
      line: 10 + i,
      signature: "(a: string) => string",
      exactHash: `h${i}`,
      kind: "function" as const,
      exported: true,
      complexity: 3,
    };
    changed.push({
      id,
      kind: i % 2 === 0 ? "modified" : "added",
      before: i % 2 === 0 ? side : undefined,
      after: side,
      signatureChanged: i % 2 === 0,
      exportedChanged: false,
      locDelta: 4,
    });
    const make = (hop: number, k: number) => ({
      id: `sym:repo:apps/web/src/use${i}-${k}-${hop}${pad}.ts#caller${k}`,
      name: `caller${k}${pad}`,
      kind: "function",
      path: `apps/web/src/use${i}-${k}-${hop}${pad}.ts`,
      line: k + 1,
      workspace: "web",
      hop,
      uses: ["calls" as const],
      crosses: hop === 1 ? ["workspace" as const] : [],
      via: hop === 1 ? undefined : `sym:repo:apps/web/src/use${i}-0-1.ts#caller0`,
    });
    consumers.push({
      id,
      target: "symbol",
      direct: Array.from({ length: Math.min(per, 200) }, (_, k) => make(1, k)),
      directTotal: per,
      potential: Array.from({ length: Math.min(per, 200) }, (_, k) => make(2, k)),
      potentialTotal: per,
      reachable: [],
      reachableTotal: 0,
      hubs: [],
    });
  }
  return {
    base: SHA_BASE,
    head: SHA_HEAD,
    mergeBase: SHA_BASE,
    files: [{ path: "packages/app/src/feature0.ts", status: "M" }],
    changes: changed,
    importChanges: [],
    impact: {
      changed,
      callersByHop: [],
      reachable: { total: 0, byHop: [] },
      hubs: [],
      crossings: changed
        .slice(0, 12)
        .map((c) => ({ from: c.id, to: `sym:repo:apps/web/src/a.ts#a`, kind: "workspace" as const })),
      risk: {
        score: 45,
        level: "medium",
        reasons: ["signature changed on an exported symbol (+30)", "3 direct callers (+15)"],
      },
      notes: [
        "New function sym:repo:a.ts#f duplicates sym:repo:b.ts#f (exact, score 1.00).",
        "Removed export x is still used.",
      ],
      consumers,
    },
  };
}

export function sampleDuplicates(clusters = 1): DuplicatesJson {
  const member = (path: string, name: string, keep: boolean, id: string) => ({
    id,
    name,
    kind: "function",
    path,
    line: 3,
    endLine: 9,
    loc: 7,
    workspaceId: null,
    exported: true,
    fanIn: 1,
    tier: keep ? null : ("exact" as const),
    score: keep ? null : 1,
    keep,
  });
  const out: DuplicatesJson["clusters"] = [];
  for (let i = 0; i < clusters; i++) {
    out.push({
      id: `c${i}`,
      tier: "exact",
      tiers: { exact: 1, near: 0, code_vector: 0, semantic: 0 },
      size: 2,
      loc: 14,
      rank: 28,
      keep: `sym:repo:packages/app/src/feature${i}.ts#doThing${i}`,
      keepReason: "most callers",
      workspaces: [],
      members: [
        member(
          `packages/app/src/feature${i}.ts`,
          `doThing${i}`,
          true,
          `sym:repo:packages/app/src/feature${i}.ts#doThing${i}`,
        ),
        member(
          `packages/lib/src/old${i}.ts`,
          `doThing${i}`,
          false,
          `sym:repo:packages/lib/src/old${i}.ts#doThing${i}`,
        ),
      ],
      links: [],
    });
  }
  return {
    summary: { clusters, functions: clusters * 2, duplicateLines: clusters * 7, crossWorkspace: 0 },
    clusters: out,
  };
}
