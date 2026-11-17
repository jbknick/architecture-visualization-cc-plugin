import type { EdgeKind, EdgeRecord, FileRecord, SymbolRecord } from "../types.js";
import type { Store } from "./repo.js";

/**
 * A read-only, in-memory view of a store's effective edges, adapter nodes, files and symbols (#48). Every
 * `effectiveEdges` call of the real store runs one SQL query with the effective-layer join, which is what makes a
 * `trace` from each of a hundred routes slow; the snapshot loads the edges and adapter nodes once and answers the
 * same filters from maps, in the same order (src, dst, kind; nodes by id). Symbols are looked up lazily and cached.
 * Every other method goes to the real store. The snapshot does not see writes made after it was taken: callers key
 * it on `store.generation()` (see `snapshotOf`).
 */
export function snapshotStore(store: Store): Store {
  const edges = store.effectiveEdges();
  const bySrc = new Map<string, EdgeRecord[]>();
  const byDst = new Map<string, EdgeRecord[]>();
  for (const e of edges) {
    let a = bySrc.get(e.src);
    if (!a) {
      a = [];
      bySrc.set(e.src, a);
    }
    a.push(e);
    let b = byDst.get(e.dst);
    if (!b) {
      b = [];
      byDst.set(e.dst, b);
    }
    b.push(e);
  }
  const adapters = store.effectiveAdapterNodes();
  const symbols = new Map<string, SymbolRecord | undefined>();
  let files: FileRecord[] | undefined;

  const overrides: Partial<Store> = {
    effectiveEdges(filter: { src?: string; dst?: string; kind?: EdgeKind[] } = {}) {
      let list: EdgeRecord[] =
        filter.src !== undefined
          ? (bySrc.get(filter.src) ?? [])
          : filter.dst !== undefined
            ? (byDst.get(filter.dst) ?? [])
            : edges;
      if (filter.src !== undefined && filter.dst !== undefined)
        list = list.filter((e) => e.dst === filter.dst);
      if (filter.kind) {
        const kinds = new Set<string>(filter.kind);
        return list.filter((e) => kinds.has(e.kind));
      }
      return list.slice();
    },
    effectiveAdapterNodes(filter: { kind?: string; ws?: string; fileId?: string } = {}) {
      return adapters.filter(
        (n) =>
          (filter.kind === undefined || n.kind === filter.kind) &&
          (filter.ws === undefined || n.ws === filter.ws) &&
          (filter.fileId === undefined || n.fileId === filter.fileId),
      );
    },
    getSymbol(id: string) {
      if (!symbols.has(id)) symbols.set(id, store.getSymbol(id));
      return symbols.get(id);
    },
    effectiveFiles() {
      files ??= store.effectiveFiles();
      return files.slice();
    },
  };
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop as keyof Store];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const snapshots = new WeakMap<Store, { generation: string; snap: Store }>();

/** The snapshot of `store` for its current generation; taken again once anything was written. */
export function snapshotOf(store: Store): Store {
  const gen = store.generation();
  const cur = snapshots.get(store);
  if (cur && cur.generation === gen) return cur.snap;
  const snap = snapshotStore(store);
  snapshots.set(store, { generation: gen, snap });
  return snap;
}
