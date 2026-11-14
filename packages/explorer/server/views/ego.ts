import type { FileRecord, SymbolRecord } from "@gantry/core";
import { HttpError } from "../errors.js";
import type { GraphEdge, GraphNode, ViewModule } from "../types.js";
import {
  clampInt,
  EGO_PAGE_DEFAULT,
  EGO_PAGE_MAX,
  EGO_PAGE_MIN,
  EGO_ROWS_DEFAULT,
  EGO_ROWS_MAX,
  EGO_ROWS_MIN,
  type GroupItem,
  type GroupPlan,
  planRows,
  type Row,
  type WorkspaceInfo,
} from "./egoGroups.js";
import { shortWorkspaceLabels } from "./labels.js";
import { cmp, getOrInit, optBool, optInt, optList } from "./options.js";

export const EGO_MAX_NODES = 400;
const EGO_KINDS = ["calls", "renders", "uses_hook", "imports"];
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

interface Link {
  src: string;
  dst: string;
  kind: string;
  count: number;
  low: boolean;
}

/**
 * View 2. Ego graph of a symbol or file.
 * Params: `focus=<sym:... | file:...>` (required); `hops` (1-4, default 2; `depth` is accepted as an alias);
 * `edgeKinds` (subset of calls|renders|uses_hook|imports; default calls,renders,uses_hook for a symbol,
 * imports for a file); `highConfidence` (default false).
 *
 * Callees (`side: "out"`) follow edges forward, callers (`side: "in"`) backward; `hop` is the distance from
 * the focus. A file focus works on file nodes: symbol-level edges are lifted to their files. Layout hint
 * `bowtie`: callers in columns left of the focus, callees right of it.
 *
 * Rows: a side at one hop has at most `maxRows` rows (option, 8-40, default 18) however its nodes are spread. A
 * side with more nodes is shown as groups: workspace, then folder, then file (see egoGroups.ts), small siblings
 * merged into one "other callers" row. A group is one node `group:<side>:<hop>:<ws:... | dir:... | file:... |
 * rest:<parent> | more:<group>:<offset>>` (kind `group`, `members` lists what is inside) with aggregated edges.
 * `expand=<group id>|<group id>` (a filter) replaces those groups by their children, at most `pageRows` (option,
 * default 14) rows each, the rest behind a "+N more" group that expands to the next page.
 * Past 400 nodes the farthest ring that does not fit collapses into `+K more` nodes (kind `more`), one per side
 * and file; rings beyond it are dropped. An expansion that would pass 400 nodes is skipped.
 */
export const egoView: ViewModule = {
  id: "ego",
  title: "Function ego graph",
  enabled: true,
  build({ store }, params) {
    const focus = params.focus;
    if (!focus) throw new HttpError(400, "ego requires focus=<symbol or file id>");
    const fileFocus = focus.startsWith("file:");
    if (!fileFocus && !focus.startsWith("sym:")) throw new HttpError(400, "focus must be a sym: or file: id");

    const hops = optInt(params, "hops") ?? params.depth ?? 2;
    if (!Number.isInteger(hops) || hops < 1 || hops > 4)
      throw new HttpError(400, "hops must be an integer 1-4");
    const kindList =
      optList(params, "edgeKinds") ?? (fileFocus ? ["imports"] : ["calls", "renders", "uses_hook"]);
    if (kindList.some((k) => !EGO_KINDS.includes(k))) {
      throw new HttpError(400, `edgeKinds must be a subset of ${EGO_KINDS.join(", ")}`);
    }
    const kinds = new Set(kindList);
    const highOnly = optBool(params, "highConfidence", false);
    const maxRows = clampInt(optInt(params, "maxRows"), EGO_ROWS_MIN, EGO_ROWS_MAX, EGO_ROWS_DEFAULT);
    const pageRows = clampInt(optInt(params, "pageRows"), EGO_PAGE_MIN, EGO_PAGE_MAX, EGO_PAGE_DEFAULT);
    const expand = new Set(optList(params, "expand") ?? []);

    const files = new Map<string, FileRecord>(store.effectiveFiles().map((f) => [f.id, f]));
    const symbols = new Map<string, SymbolRecord>();
    const fnCount = new Map<string, number>();
    for (const s of store.effectiveSymbols()) {
      symbols.set(s.id, s);
      fnCount.set(s.fileId, (fnCount.get(s.fileId) ?? 0) + 1);
    }
    const known = (id: string): boolean => (fileFocus ? files.has(id) : symbols.has(id) || files.has(id));
    if (!(fileFocus ? files.has(focus) : symbols.has(focus)))
      throw new HttpError(404, `Unknown focus: ${focus}`);
    const lift = (id: string): string =>
      fileFocus && id.startsWith("sym:") ? (symbols.get(id)?.fileId ?? id) : id;

    // Selected links, deduplicated after lifting.
    const linkMap = new Map<string, Link>();
    for (const e of store.effectiveEdges({ kind: [...kinds] as never })) {
      if (highOnly && e.confidence === "low") continue;
      const src = lift(e.src);
      const dst = lift(e.dst);
      if (src === dst || !known(src) || !known(dst)) continue;
      const key = `${src}\0${dst}\0${e.kind}`;
      const l = linkMap.get(key);
      if (l) {
        l.count += e.count;
        l.low ||= e.confidence === "low";
      } else linkMap.set(key, { src, dst, kind: e.kind, count: e.count, low: e.confidence === "low" });
    }
    const links = [...linkMap.values()];
    const fwd = new Map<string, string[]>();
    const back = new Map<string, string[]>();
    for (const l of links) {
      (fwd.get(l.src) ?? fwd.set(l.src, []).get(l.src))?.push(l.dst);
      (back.get(l.dst) ?? back.set(l.dst, []).get(l.dst))?.push(l.src);
    }
    const bfs = (adj: Map<string, string[]>): Map<string, number> => {
      const dist = new Map<string, number>([[focus, 0]]);
      let frontier = [focus];
      for (let h = 1; h <= hops && frontier.length; h++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const n of adj.get(id) ?? []) {
            if (!dist.has(n)) {
              dist.set(n, h);
              next.push(n);
            }
          }
        }
        frontier = next;
      }
      return dist;
    };
    const outDist = bfs(fwd);
    const inDist = bfs(back);

    // Rings: hop -> side -> ids. A node reachable both ways keeps its nearer side (callees on a tie).
    const side = new Map<string, "in" | "out">();
    const hopOf = new Map<string, number>();
    for (const [id, h] of outDist)
      if (id !== focus) {
        side.set(id, "out");
        hopOf.set(id, h);
      }
    for (const [id, h] of inDist) {
      if (id === focus) continue;
      const cur = hopOf.get(id);
      if (cur === undefined || h < cur) {
        side.set(id, "in");
        hopOf.set(id, h);
      }
    }
    const rings: string[][] = Array.from({ length: hops + 1 }, () => []);
    for (const [id, h] of hopOf) (rings[h] as string[]).push(id);
    for (const r of rings) r.sort(cmp);

    const wsInfo = new Map<string, WorkspaceInfo>();
    const workspaces = store.listWorkspaces();
    const shortNames = shortWorkspaceLabels(workspaces.map((w) => w.name));
    for (const w of workspaces) wsInfo.set(w.id, { dir: w.dir, short: shortNames.get(w.name) ?? w.name });
    const fileOf = (id: string): FileRecord | undefined => {
      const s = symbols.get(id);
      return s ? files.get(s.fileId) : files.get(id);
    };
    const wsOf = (id: string): string | undefined => {
      const w = fileOf(id)?.workspaceId;
      return w && wsInfo.has(w) ? w : undefined;
    };
    const lineOf = (id: string): number | undefined => symbols.get(id)?.startLine;

    const nodes = new Map<string, GraphNode>();
    const makeNode = (id: string): GraphNode => {
      const ws = wsOf(id);
      const s = symbols.get(id);
      if (s) {
        return {
          id,
          kind: s.kind,
          label: s.name,
          size: 1,
          path: files.get(s.fileId)?.path,
          stats: { functions: 1, loc: s.loc },
          ...(s.exported ? { badges: ["exported"] } : {}),
          ...(ws ? { workspace: ws } : {}),
        };
      }
      const f = files.get(id) as FileRecord;
      const fns = fnCount.get(id) ?? 0;
      return {
        id,
        kind: "file",
        label: baseName(f.path),
        size: Math.max(1, fns),
        path: f.path,
        stats: { files: 1, functions: fns },
        ...(ws ? { workspace: ws } : {}),
      };
    };
    nodes.set(focus, { ...makeNode(focus), side: "focus", hop: 0 });

    // Rows placed on the canvas: per (side, hop), a tree of individual nodes and groups.
    interface Bucket {
      side: "in" | "out";
      hop: number;
      rows: Row[];
    }
    const placed: Bucket[] = [];
    const groupNodeCount = (rows: Row[]): number =>
      rows.reduce((n, r) => n + 1 + ("group" in r && r.expanded ? groupNodeCount(r.rows) : 0), 0);
    const bucketFor = (
      sd: "in" | "out",
      h: number,
      ids: string[],
      expanding: boolean,
      room: number,
    ): Bucket => {
      const items: GroupItem[] = ids.map((id) => ({
        id,
        path: fileOf(id)?.path ?? id,
        ws: wsOf(id) ?? null,
      }));
      const { rows } = planRows(sd, h, items, wsInfo, {
        maxRows,
        pageRows,
        expand: expanding ? expand : new Set(),
        nodeBudget: room,
      });
      return { side: sd, hop: h, rows };
    };

    const memberOf = new Map<string, string>(); // collapsed node id -> its group / "+K more" node id
    let used = 1;
    const ringsAfter = (h: number): boolean => rings.slice(h + 1).some((r) => r.length > 0);
    for (let h = 1; h <= hops; h++) {
      const ring = rings[h] as string[];
      if (ring.length === 0) continue;
      const reserve = ringsAfter(h) ? 2 : 0;
      const sides = (["in", "out"] as const).map((sd) =>
        bucketFor(
          sd,
          h,
          ring.filter((id) => side.get(id) === sd),
          false,
          0,
        ),
      );
      const count = sides.reduce((n, b) => n + b.rows.length, 0);
      if (used + count <= EGO_MAX_NODES - reserve) {
        placed.push(...sides);
        used += count;
        continue;
      }
      // Collapse this ring per (side, file); merge the smallest groups per side if there are too many.
      const groups = new Map<string, { side: "in" | "out"; path?: string; ids: string[] }>();
      for (const id of ring) {
        const sd = side.get(id) as "in" | "out";
        const path = symbols.has(id) ? files.get((symbols.get(id) as SymbolRecord).fileId)?.path : undefined;
        const key = `${sd}\0${path ?? id}`;
        const g = getOrInit(groups, key, () => ({ side: sd, path, ids: [] as string[] }));
        g.ids.push(id);
      }
      const ordered = [...groups.entries()].sort(
        (a, b) => b[1].ids.length - a[1].ids.length || cmp(a[0], b[0]),
      );
      const room = EGO_MAX_NODES - used;
      const keep = ordered.length <= room ? ordered.length : Math.max(0, room - 2);
      const mergedBySide = new Map<"in" | "out", string[]>();
      ordered.forEach(([, g], i) => {
        if (i < keep) {
          addMore(`more:${g.side}:${h}:${g.path ?? g.ids[0]}`, g.side, h, g.ids, g.path);
        } else {
          const list = mergedBySide.get(g.side) ?? [];
          list.push(...g.ids);
          mergedBySide.set(g.side, list);
        }
      });
      for (const [sd, ids] of mergedBySide) addMore(`more:${sd}:${h}:*`, sd, h, ids);
      break; // farther rings are dropped
    }
    function addMore(id: string, sd: "in" | "out", h: number, ids: string[], path?: string): void {
      nodes.set(id, {
        id,
        kind: "more",
        label: `+${ids.length} more`,
        size: ids.length,
        side: sd,
        hop: h,
        ...(path ? { path } : {}),
        stats: { functions: ids.length },
      });
      used++;
      for (const m of ids) memberOf.set(m, id);
    }

    // Expanded groups: re-plan the buckets with the expansions, while the 400-node budget lasts.
    let budget = EGO_MAX_NODES - used;
    if (expand.size > 0) {
      for (let i = 0; i < placed.length; i++) {
        const b = placed[i] as Bucket;
        const ids = rings[b.hop]?.filter((id) => side.get(id) === b.side) ?? [];
        const again = bucketFor(b.side, b.hop, ids, true, budget);
        budget -= groupNodeCount(again.rows) - b.rows.length;
        placed[i] = again;
      }
    }
    const groupNode = (sd: "in" | "out", h: number, g: GroupPlan, parent?: string): GraphNode => {
      const word =
        sd === "in"
          ? g.members.length === 1
            ? "caller"
            : "callers"
          : g.members.length === 1
            ? "callee"
            : "callees";
      return {
        id: g.id,
        kind: "group",
        label: g.label,
        size: g.members.length,
        side: sd,
        hop: h,
        path: g.path,
        ...(g.ws ? { workspace: g.ws } : {}),
        ...(parent ? { group: parent } : {}),
        stats: { members: g.members.length, files: g.files },
        badges: [`${g.members.length} ${word}`],
        members: g.members.map((m) => {
          const line = lineOf(m.id);
          return {
            id: m.id,
            label: symbols.get(m.id)?.name ?? baseName(m.path),
            path: m.path,
            ...(line !== undefined ? { line } : {}),
          };
        }),
      };
    };
    const emit = (sd: "in" | "out", h: number, rows: Row[], parent?: string): void => {
      for (const r of rows) {
        if ("item" in r) {
          nodes.set(r.item.id, {
            ...makeNode(r.item.id),
            side: sd,
            hop: h,
            ...(parent ? { group: parent } : {}),
          });
          continue;
        }
        const g = r.group;
        if (!r.expanded) {
          nodes.set(g.id, groupNode(sd, h, g, parent));
          for (const m of g.members) memberOf.set(m.id, g.id);
          continue;
        }
        // An expanded group stays as a header node (`expanded: true`, no edges); its rows follow as nodes.
        nodes.set(g.id, { ...groupNode(sd, h, g, parent), expanded: true });
        emit(sd, h, r.rows, g.id);
      }
    };
    for (const b of placed) emit(b.side, b.hop, b.rows);

    const ref = (id: string): string | undefined => (nodes.has(id) ? id : memberOf.get(id));
    const agg = new Map<string, GraphEdge>();
    for (const l of links) {
      const src = ref(l.src);
      const dst = ref(l.dst);
      if (!src || !dst || src === dst) continue;
      const id = `${src}|${l.kind}|${dst}`;
      const e = agg.get(id);
      if (e) {
        e.weight += l.count;
        if (l.low) e.confidence = "low";
      } else {
        agg.set(id, { id, src, dst, kind: l.kind, weight: l.count, confidence: l.low ? "low" : "high" });
      }
    }
    return {
      nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
      edges: [...agg.values()].sort((a, b) => cmp(a.id, b.id)),
      layoutHint: "bowtie",
    };
  },
};
