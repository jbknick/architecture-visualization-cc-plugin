import { gunzipSync, gzipSync } from "node:zlib";
import {
  type AdapterNode,
  type ChangeSet,
  type Edge,
  type FileNode,
  type MainRecord,
  type MainSnapshot,
  type PartRecord,
  PartRecordSchema,
  type RadiusEntry,
  type SymbolNode,
  type Workspace,
} from "./schemas.js";

/** The limits a server gives in its answer to the begin request. A client cuts its parts to them. */
export interface PartLimits {
  part_max_records: number;
  part_max_bytes: number;
}

const encoder = new TextEncoder();
const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function describe(record: PartRecord): string {
  return "id" in record ? `${record.t} ${record.id}` : `${record.t} ${record.from} -> ${record.to}`;
}

/**
 * The records of a main snapshot in the order an upload sends them: workspaces, files, symbols, edges, adapter
 * nodes, each sorted by id (edges by `from`, `to`, `kind`), so a resend of the same cut is byte-identical.
 */
export function mainSnapshotRecords(snapshot: MainSnapshot): MainRecord[] {
  const edges = [...snapshot.edges].sort(
    (a: Edge, b: Edge) =>
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  return [
    ...[...snapshot.workspaces].sort(byId).map((r: Workspace) => ({ t: "w" as const, ...r })),
    ...[...snapshot.files].sort(byId).map((r: FileNode) => ({ t: "f" as const, ...r })),
    ...[...snapshot.symbols].sort(byId).map((r: SymbolNode) => ({ t: "s" as const, ...r })),
    ...edges.map((r) => ({ t: "e" as const, ...r })),
    ...[...snapshot.adapter_nodes].sort(byId).map((r: AdapterNode) => ({ t: "a" as const, ...r })),
  ];
}

/**
 * The records of a change set: the `c` record (everything but `repo`, `nodes` and `radius`), then the node ids
 * (sorted), then the radius entries (sorted by `hop`, then `id`).
 */
export function changeSetRecords(changeSet: ChangeSet): PartRecord[] {
  const { nodes, radius, repo: _repo, ...header } = changeSet;
  const sortedRadius = [...radius].sort(
    (a: RadiusEntry, b: RadiusEntry) => a.hop - b.hop || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return [
    { t: "c", ...header },
    ...[...nodes].sort().map((id) => ({ t: "n" as const, id })),
    ...sortedRadius.map((r) => ({ t: "r" as const, ...r })),
  ];
}

function gzipLines(lines: string[]): Uint8Array {
  return new Uint8Array(gzipSync(lines.join("")));
}

/**
 * Cuts an ordered record list into gzipped NDJSON parts. A part holds at most `part_max_records` records and
 * `part_max_bytes` bytes of decompressed text (each line and its newline counted). Each part is gzipped on its own.
 * A part whose gzip is over `part_max_bytes` is cut in half. Throws, naming the record, when one record cannot fit an
 * empty part. An empty list gives no parts.
 */
export function splitIntoParts(records: readonly PartRecord[], limits: PartLimits): Uint8Array[] {
  const groups: { lines: string[]; records: PartRecord[] }[] = [];
  let current = { lines: [] as string[], records: [] as PartRecord[], bytes: 0 };
  for (const record of records) {
    const line = `${JSON.stringify(record)}\n`;
    const size = encoder.encode(line).length;
    if (size > limits.part_max_bytes) {
      throw new Error(
        `record too large for a part (${size} bytes, limit ${limits.part_max_bytes}): ${describe(record)}`,
      );
    }
    if (
      current.records.length > 0 &&
      (current.records.length + 1 > limits.part_max_records || current.bytes + size > limits.part_max_bytes)
    ) {
      groups.push(current);
      current = { lines: [], records: [], bytes: 0 };
    }
    current.lines.push(line);
    current.records.push(record);
    current.bytes += size;
  }
  if (current.records.length > 0) groups.push(current);

  const out: Uint8Array[] = [];
  const emit = (lines: string[], recs: PartRecord[]): void => {
    const body = gzipLines(lines);
    if (body.length <= limits.part_max_bytes) {
      out.push(body);
      return;
    }
    const first = recs[0];
    if (recs.length < 2 && first !== undefined) {
      throw new Error(`record does not fit a part once compressed: ${describe(first)}`);
    }
    const mid = Math.ceil(recs.length / 2);
    emit(lines.slice(0, mid), recs.slice(0, mid));
    emit(lines.slice(mid), recs.slice(mid));
  };
  for (const group of groups) emit(group.lines, group.records);
  return out;
}

/**
 * Reads one part: gunzips it (at most `maxBytes` decompressed when given) and checks every line with
 * `PartRecordSchema`. Throws on a body that is not gzip, a line that is not JSON or a record that is not valid.
 */
export function decodePart(body: Uint8Array, maxBytes?: number): PartRecord[] {
  const text = gunzipSync(body, maxBytes === undefined ? {} : { maxOutputLength: maxBytes }).toString("utf8");
  const records: PartRecord[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line === "") continue;
    const parsed = PartRecordSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`record ${i + 1}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    records.push(parsed.data);
  }
  return records;
}
