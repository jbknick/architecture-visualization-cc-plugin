/**
 * A minimal protobuf wire reader, enough for the SCIP messages (spec section 11, precise mode). It reads a buffer
 * field by field: varints, length-delimited fields and the fixed-width kinds that have to be skipped. There is no
 * code generation and no dependency.
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

export class ProtoError extends Error {}

export interface Field {
  /** The field number. */
  no: number;
  wire: number;
  /** The value of a varint field. */
  num: number;
  /** The payload of a length-delimited field (a view of the buffer, not a copy). */
  bytes: Uint8Array;
}

const EMPTY = new Uint8Array(0);

/**
 * Reads a varint at `at`. Returns the value and the position after it. A value above 2^53 loses its low bits; the
 * SCIP fields are lengths, enum values, role bit sets and line numbers, none of which get near it. A negative `int32`
 * is written as ten bytes; the low 32 bits are what a reader keeps (`| 0`), done by the callers that read an `int32`.
 */
export function readVarint(buf: Uint8Array, at: number): [value: number, next: number] {
  let result = 0;
  let scale = 1;
  let pos = at;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new ProtoError("truncated varint");
    const b = buf[pos++] as number;
    result += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return [result, pos];
    scale *= 128;
  }
  throw new ProtoError("varint longer than 10 bytes");
}

/** The int32 a varint holds: its low 32 bits, signed (a negative value is ten bytes on the wire). */
export function varintToInt32(buf: Uint8Array, at: number): [value: number, next: number] {
  let low = 0;
  let pos = at;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new ProtoError("truncated varint");
    const b = buf[pos++] as number;
    if (i < 5) low = (low | ((b & 0x7f) << (7 * i))) >>> 0;
    if ((b & 0x80) === 0) return [low | 0, pos];
  }
  throw new ProtoError("varint longer than 10 bytes");
}

/** Iterates the fields of one message held in `buf`. */
export function* fields(buf: Uint8Array): Generator<Field> {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const no = Math.floor(tag / 8);
    const wire = tag % 8;
    if (no === 0) throw new ProtoError("field number 0");
    if (wire === WIRE_VARINT) {
      const [num, next] = readVarint(buf, pos);
      pos = next;
      yield { no, wire, num, bytes: EMPTY };
    } else if (wire === WIRE_LEN) {
      const [len, next] = readVarint(buf, pos);
      if (next + len > buf.length) throw new ProtoError("length-delimited field runs past the message");
      yield { no, wire, num: 0, bytes: buf.subarray(next, next + len) };
      pos = next + len;
    } else if (wire === WIRE_FIXED64) {
      if (pos + 8 > buf.length) throw new ProtoError("truncated fixed64");
      pos += 8;
    } else if (wire === WIRE_FIXED32) {
      if (pos + 4 > buf.length) throw new ProtoError("truncated fixed32");
      pos += 4;
    } else {
      throw new ProtoError(`unsupported wire type ${wire}`);
    }
  }
}

const utf8 = new TextDecoder("utf-8");
export const text = (b: Uint8Array): string => utf8.decode(b);

/** The int32 values of a repeated field: one packed field (length-delimited) or one varint per field. */
export function packedInt32(f: Field): number[] {
  if (f.wire === WIRE_VARINT) return [f.num | 0];
  const out: number[] = [];
  let pos = 0;
  while (pos < f.bytes.length) {
    const [v, next] = varintToInt32(f.bytes, pos);
    out.push(v);
    pos = next;
  }
  return out;
}
