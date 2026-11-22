import fs from "node:fs";
import {
  type Field,
  fields,
  ProtoError,
  packedInt32,
  readVarint,
  text,
  WIRE_LEN,
  WIRE_VARINT,
} from "./proto.js";

/**
 * The SCIP messages Gantry reads (https://github.com/sourcegraph/scip, `scip.proto`), by field number:
 *
 *   Index { metadata = 1, documents = 2, external_symbols = 3 }
 *   Metadata { tool_info = 2 { name = 1, version = 2 }, project_root = 3 }
 *   Document { relative_path = 1, occurrences = 2, symbols = 3, language = 4, text = 5, position_encoding = 6 }
 *   Occurrence { range = 1 (3 or 4 int32), symbol = 2, symbol_roles = 3, single_line_range = 8, multi_line_range = 9 }
 *   SingleLineRange { line = 1, start_character = 2, end_character = 3 }
 *   MultiLineRange { start_line = 1, start_character = 2, end_line = 3, end_character = 4 }
 *   SymbolInformation { symbol = 1, kind = 5, display_name = 6 }
 *
 * Everything else is skipped. Lines and characters are 0-based and the end is exclusive; how a character counts
 * (UTF-8 bytes, UTF-16 code units, code points) is the document's `positionEncoding`.
 */

export const SYMBOL_ROLE_DEFINITION = 0x1;
export const SYMBOL_ROLE_IMPORT = 0x2;

/** `PositionEncoding`: 0 unspecified, 1 UTF-8 bytes, 2 UTF-16 code units, 3 UTF-32 code points. */
export type PositionEncoding = 0 | 1 | 2 | 3;

export interface ScipMetadata {
  toolName: string;
  toolVersion: string;
  projectRoot: string;
}

export interface ScipOccurrence {
  /** 0-based. */
  line: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  symbol: string;
  /** The `SymbolRole` bit set. */
  roles: number;
}

export interface ScipSymbolInformation {
  symbol: string;
  /** `SymbolInformation.Kind`, 0 when absent. */
  kind: number;
  displayName: string;
}

export interface ScipDocument {
  /** Relative to the index's project root, with `/`. */
  path: string;
  language: string;
  /** The text of the file as it was indexed, when the indexer wrote it (most do not). */
  text?: string;
  positionEncoding: PositionEncoding;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export type ScipItem =
  | { kind: "metadata"; metadata: ScipMetadata }
  | { kind: "document"; document: ScipDocument };

/** The occurrence range, from `typed_range` when set (it wins) or the deprecated `range` list of 3 or 4 integers. */
function parseOccurrence(buf: Uint8Array): ScipOccurrence | null {
  let legacy: number[] | undefined;
  let typed: [number, number, number, number] | undefined;
  let symbol = "";
  let roles = 0;
  for (const f of fields(buf)) {
    if (f.no === 1) legacy = [...(legacy ?? []), ...packedInt32(f)];
    else if (f.no === 2 && f.wire === WIRE_LEN) symbol = text(f.bytes);
    else if (f.no === 3 && f.wire === WIRE_VARINT) roles = f.num | 0;
    else if (f.no === 8 && f.wire === WIRE_LEN) {
      const r = parseRange(f.bytes, false);
      if (r) typed = r;
    } else if (f.no === 9 && f.wire === WIRE_LEN) {
      const r = parseRange(f.bytes, true);
      if (r) typed = r;
    }
  }
  let r: [number, number, number, number] | undefined = typed;
  if (!r && legacy) {
    if (legacy.length === 3)
      r = [legacy[0] as number, legacy[1] as number, legacy[0] as number, legacy[2] as number];
    else if (legacy.length === 4)
      r = [legacy[0] as number, legacy[1] as number, legacy[2] as number, legacy[3] as number];
  }
  if (!r) return null;
  return { line: r[0], startCharacter: r[1], endLine: r[2], endCharacter: r[3], symbol, roles };
}

/** A `SingleLineRange` (line, start, end) or a `MultiLineRange` (start line, start, end line, end), as start line, start, end line, end. */
function parseRange(buf: Uint8Array, multi: boolean): [number, number, number, number] | null {
  const v = [0, 0, 0, 0];
  for (const f of fields(buf)) {
    if (f.wire === WIRE_VARINT && f.no >= 1 && f.no <= 4) v[f.no - 1] = f.num | 0;
  }
  return multi
    ? [v[0] as number, v[1] as number, v[2] as number, v[3] as number]
    : [v[0] as number, v[1] as number, v[0] as number, v[2] as number];
}

function parseSymbolInformation(buf: Uint8Array): ScipSymbolInformation {
  const out: ScipSymbolInformation = { symbol: "", kind: 0, displayName: "" };
  for (const f of fields(buf)) {
    if (f.no === 1 && f.wire === WIRE_LEN) out.symbol = text(f.bytes);
    else if (f.no === 5 && f.wire === WIRE_VARINT) out.kind = f.num;
    else if (f.no === 6 && f.wire === WIRE_LEN) out.displayName = text(f.bytes);
  }
  return out;
}

export function parseDocument(buf: Uint8Array): ScipDocument {
  const doc: ScipDocument = {
    path: "",
    language: "",
    positionEncoding: 0,
    occurrences: [],
    symbols: [],
  };
  for (const f of fields(buf)) {
    if (f.no === 1 && f.wire === WIRE_LEN) doc.path = text(f.bytes);
    else if (f.no === 2 && f.wire === WIRE_LEN) {
      const o = parseOccurrence(f.bytes);
      if (o) doc.occurrences.push(o);
    } else if (f.no === 3 && f.wire === WIRE_LEN) doc.symbols.push(parseSymbolInformation(f.bytes));
    else if (f.no === 4 && f.wire === WIRE_LEN) doc.language = text(f.bytes);
    else if (f.no === 5 && f.wire === WIRE_LEN) doc.text = text(f.bytes);
    else if (f.no === 6 && f.wire === WIRE_VARINT) {
      doc.positionEncoding = (f.num >= 0 && f.num <= 3 ? f.num : 0) as PositionEncoding;
    }
  }
  return doc;
}

export function parseMetadata(buf: Uint8Array): ScipMetadata {
  const out: ScipMetadata = { toolName: "", toolVersion: "", projectRoot: "" };
  for (const f of fields(buf)) {
    if (f.no === 2 && f.wire === WIRE_LEN) {
      for (const t of fields(f.bytes)) {
        if (t.no === 1 && t.wire === WIRE_LEN) out.toolName = text(t.bytes);
        else if (t.no === 2 && t.wire === WIRE_LEN) out.toolVersion = text(t.bytes);
      }
    } else if (f.no === 3 && f.wire === WIRE_LEN) out.projectRoot = text(f.bytes);
  }
  return out;
}

const CHUNK = 1 << 20;

/**
 * Reads a SCIP index file as a stream: the metadata once, then one document at a time, so that memory holds one
 * document and one read buffer, not the index. `external_symbols` are skipped. A file that is not a SCIP index, or is
 * cut short, throws `ProtoError`.
 */
export async function* readScip(file: string): AsyncGenerator<ScipItem> {
  const handle = await fs.promises.open(file, "r");
  try {
    let buf: Buffer = Buffer.alloc(0);
    let start = 0;
    let eof = false;
    const fill = async (): Promise<boolean> => {
      if (eof) return false;
      const chunk = Buffer.alloc(CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, null);
      if (bytesRead === 0) {
        eof = true;
        return false;
      }
      buf = Buffer.concat([buf.subarray(start), chunk.subarray(0, bytesRead)]);
      start = 0;
      return true;
    };
    // Reads the next top-level field of `Index`; undefined at the end of the file.
    const next = async (): Promise<Field | undefined> => {
      for (;;) {
        if (start >= buf.length && !(await fill())) return undefined;
        try {
          const [tag, afterTag] = readVarint(buf, start);
          const no = Math.floor(tag / 8);
          const wire = tag % 8;
          if (no === 0) throw new ProtoError("field number 0");
          if (wire === WIRE_VARINT) {
            const [num, after] = readVarint(buf, afterTag);
            start = after;
            return { no, wire, num, bytes: new Uint8Array(0) };
          }
          if (wire !== WIRE_LEN) throw new ProtoError(`unexpected wire type ${wire} at the top level`);
          const [len, after] = readVarint(buf, afterTag);
          if (after + len > buf.length) {
            if (await fill()) continue;
            throw new ProtoError("the file ends inside a field");
          }
          const field: Field = { no, wire, num: 0, bytes: buf.subarray(after, after + len) };
          start = after + len;
          return field;
        } catch (err) {
          if (err instanceof ProtoError && err.message.startsWith("truncated varint") && (await fill()))
            continue;
          throw err;
        }
      }
    };
    for (;;) {
      const f = await next();
      if (!f) return;
      if (f.no === 1 && f.wire === WIRE_LEN) yield { kind: "metadata", metadata: parseMetadata(f.bytes) };
      else if (f.no === 2 && f.wire === WIRE_LEN)
        yield { kind: "document", document: parseDocument(f.bytes) };
    }
  } finally {
    await handle.close();
  }
}
