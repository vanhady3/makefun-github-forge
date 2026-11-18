// gitutil.ts — git object model, pkt-line framing and the packfile codec.
//
// Everything here is Node 22 stdlib only (node:crypto for SHA-1, node:zlib for
// object compression). No git binary exists in the trial, so the forge stores
// objects itself and speaks the smart-HTTP wire format directly.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: no object, an unborn ref, a delete. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** A git object type. */
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored git object: its type and its raw bytes (without the `<type> <size>\0` header). */
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** SHA-1 of a buffer, as lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id git computes for `<type> <size>\0<data>`. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** A parsed commit object. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit's raw bytes: header lines until the blank line, then the message. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** One tree entry: mode, file name, object id. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree's raw bytes: `<mode> <name>\0<20-byte oid>` entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(pos, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Build a tree's raw bytes from entries, sorted the way git sorts them (by name, directories as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The fixed identity the forge stamps on commits it creates (contents API, merges). Deterministic: no clock. */
export const FORGE_IDENTITY = 'Mamang Forge <forge@make.fun>';
/** The fixed commit timestamp (seconds since epoch) the forge stamps. Deterministic: no clock. */
export const FORGE_TIMESTAMP = 1700000000;

/** Build a commit's raw bytes. */
export function buildCommit(opts: { tree: string; parents: readonly string[]; message: string }): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FORGE_IDENTITY} ${FORGE_TIMESTAMP} +0000`);
  lines.push(`committer ${FORGE_IDENTITY} ${FORGE_TIMESTAMP} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${opts.message}`, 'utf8');
}

/** A parsed annotated tag. */
export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  message: string;
}

/** Parse an annotated tag's raw bytes. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of total length (including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet `0001`. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktItem = string | Buffer | 'flush' | 'delim';

/** Encode a mixed sequence of pkt-lines, flushes and delims. */
export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** One decoded packet. */
export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/**
 * Decode pkt-lines from `buf` starting at `start`. Stops at the end of the buffer.
 * Returns the packets and the offset just past the last complete packet. Throws on a
 * malformed length prefix or a truncated packet.
 */
export function decodePktLines(buf: Buffer, start = 0): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let pos = start;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > buf.length) throw new Error('malformed pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, offset: pos };
}

// ---------------------------------------------------------------- packfiles

/** Pack entry type numbers. */
const PACK_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;
const PACK_TYPE_NAME: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Encode one pack entry's type/size header (the git varint form). */
function encodeObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Write a packfile (version 2, plain objects only, no deltas) for the given objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = PACK_TYPE[obj.type];
    parts.push(encodeObjectHeader(typeNum, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Read one git varint (delta size encoding: 7 bits per byte, little-endian groups). */
function readDeltaVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const byte = buf[p];
    p += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: p };
}

/** Apply a delta instruction stream to a base object, producing the target bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const src = readDeltaVarint(delta, p);
  p = src.next;
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const dst = readDeltaVarint(delta, p);
  p = dst.next;
  const chunks: Buffer[] = [];
  let outLen = 0;
  while (p < delta.length) {
    const op = delta[p];
    p += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[p++];
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      chunks.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      if (p + op > delta.length) throw new Error('delta insert out of range');
      chunks.push(delta.subarray(p, p + op));
      p += op;
      outLen += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== dst.value) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks, outLen);
}

interface DeltaEntry {
  /** Offset of this entry's header in the pack, for OFS_DELTA base resolution. */
  entryOffset: number;
  /** OFS_DELTA: the base is at entryOffset - ofsBase. REF_DELTA: base by oid. */
  ofsBase: number | null;
  refBase: string | null;
  delta: Buffer;
  size: number;
}

/**
 * Adler-32, the checksum zlib stores as the last 4 bytes of a stream.
 */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one zlib stream starting at `pos` and report where it ends.
 * Node's inflateSync ignores trailing bytes, so one inflate of the remainder gives
 * the data; the stream's end is the 4-byte Adler-32 of that data, found by scanning
 * for it (and verified by re-inflating the candidate slice). One inflate per entry
 * instead of a binary search of them.
 */
function inflateWithLength(buf: Buffer, pos: number): { data: Buffer; next: number } {
  const data = inflateSync(buf.subarray(pos));
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(adler32(data), 0);
  let idx = buf.indexOf(tail, pos);
  while (idx !== -1) {
    const end = idx + 4;
    try {
      const check = inflateSync(buf.subarray(pos, end));
      if (check.equals(data)) return { data, next: end };
    } catch {
      // Not the real stream end (the checksum bytes appeared inside the data).
    }
    idx = buf.indexOf(tail, end);
  }
  throw new Error('deflate stream end not found');
}

/**
 * Read a packfile into objects by id. Handles plain objects, OFS_DELTA and REF_DELTA
 * (deltas resolve against other pack entries, in any order, to a fixpoint). Throws on a
 * malformed pack. The 20-byte trailer is not verified here; the caller checks it.
 */
export function readPack(buf: Buffer): { objects: Map<string, GitObject>; deltaCount: number } {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  const deltas: DeltaEntry[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = pos;
    let byte = buf[pos];
    pos += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let ofsBase: number | null = null;
    let refBase: string | null = null;
    if (typeNum === 6) {
      byte = buf[pos];
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      ofsBase = offset;
    } else if (typeNum === 7) {
      refBase = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateWithLength(buf, pos);
    pos = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    if (typeNum === 6 || typeNum === 7) {
      deltas.push({ entryOffset, ofsBase, refBase, delta: inflated.data, size });
    } else {
      const type = PACK_TYPE_NAME[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const oid = hashObject(type, inflated.data);
      objects.set(oid, { type, data: inflated.data });
      byOffset.set(entryOffset, oid);
    }
  }
  // Resolve deltas to a fixpoint: a delta's base may itself be a delta's result.
  let remaining = deltas;
  let deltaCount = 0;
  while (remaining.length > 0) {
    const next: DeltaEntry[] = [];
    let progressed = false;
    for (const entry of remaining) {
      let baseOid: string | undefined;
      if (entry.ofsBase !== null) baseOid = byOffset.get(entry.entryOffset - entry.ofsBase);
      else if (entry.refBase !== null) baseOid = entry.refBase;
      const base = baseOid !== undefined ? objects.get(baseOid) : undefined;
      if (base === undefined) {
        next.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.delta);
      if (data.length !== entry.size) throw new Error('delta target size mismatch');
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(entry.entryOffset, oid);
      deltaCount += 1;
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base not found');
    remaining = next;
  }
  return { objects, deltaCount };
}

/** Verify a packfile's trailer SHA-1 covers all bytes before it. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: '', expected: '' };
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  return { ok: actual === expected, actual, expected };
}
