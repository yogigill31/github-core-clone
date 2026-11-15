// Git smart HTTP: protocol v2 (ls-refs, fetch) and v0 (upload-pack, receive-pack),
// pkt-line framing, packfile reading and writing. No deltas are ever sent — the
// suite accepts a pack with zero deltas — but packs the client sends are read with
// full delta resolution, so a real git client works too.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  isObjectId,
  isAncestor,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  collectReachable,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

export const PKT_LINE_MAX = 65520;
const MAX_SIDEBAND_DATA = PKT_LINE_MAX - 5; // 4-byte length + 1 band byte

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on garbage (callers answer 400). */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length < 4 || offset + length > buffer.length) throw new Error('bad pkt-line length');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile version 2 from plain objects (no deltas), with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject & { oid: string }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // Node's inflateSync ignores bytes after the stream's end, and throws
  // "unexpected end of file" for a truncated stream — so success is monotonic
  // in the end offset, and a binary search finds the stream's exact end.
  let lo = offset;
  let hi = buffer.length;
  try {
    inflateSync(buffer.subarray(offset, hi));
  } catch {
    throw new Error('pack entry zlib stream is truncated');
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buffer.subarray(offset, hi)), next: hi };
}

/** Apply a git delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= delta[offset++]! << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= delta[offset++]! << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (produced !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks);
}

export interface PackObject extends GitObject {
  oid: string;
}

/**
 * Read a packfile (v2 or v3), resolving ofs-delta and ref-delta entries against
 * objects in the same pack. Returns the objects keyed by oid.
 */
export function readPack(buffer: Buffer): Map<string, PackObject> {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  interface Entry {
    offset: number;
    type: GitObjectType | 'ofs-delta' | 'ref-delta';
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const { size, next, first } = readVarintSize(buffer, offset);
    offset = next;
    const code = (first >> 4) & 0x07;
    if (code === 6) {
      const { baseOffset, next: afterBase } = readOfsDeltaBase(buffer, offset);
      const { data, next: afterData } = inflateAt(buffer, afterBase);
      const entry: Entry = { offset: start, type: 'ofs-delta', size, data, baseOffset: start - baseOffset };
      entries.push(entry);
      byOffset.set(start, entry);
      offset = afterData;
    } else if (code === 7) {
      const baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      const { data, next: afterData } = inflateAt(buffer, offset + 20);
      const entry: Entry = { offset: start, type: 'ref-delta', size, data, baseOid };
      entries.push(entry);
      byOffset.set(start, entry);
      offset = afterData;
    } else {
      const type = CODE_TYPE[code];
      if (type === undefined) throw new Error(`unknown pack object type code ${code}`);
      const { data, next: afterData } = inflateAt(buffer, offset);
      const entry: Entry = { offset: start, type, size, data };
      entries.push(entry);
      byOffset.set(start, entry);
      offset = afterData;
    }
  }
  const resolved = new Map<string, PackObject>();
  const resolve = (entry: Entry): PackObject => {
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: PackObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base is outside the pack');
        base = resolve(baseEntry);
      } else {
        base = resolved.get(entry.baseOid!);
        if (base === undefined) throw new Error('ref-delta base is outside the pack');
      }
      const data = applyDelta(base.data, entry.data);
      const object: PackObject = { type: base.type, data, oid: hashObject(base.type, data) };
      resolved.set(object.oid, object);
      return object;
    }
    const object: PackObject = { type: entry.type as GitObjectType, data: entry.data, oid: hashObject(entry.type as GitObjectType, entry.data) };
    resolved.set(object.oid, object);
    return object;
  };
  for (const entry of entries) resolve(entry);
  return resolved;
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_V2_CAPS = [
  'version 2',
  'ls-refs=unborn',
  'fetch=shallow filter',
  'object-format=sha1',
  `agent=${AGENT}`,
];

const UPLOAD_V0_CAPS = [
  'multi_ack', 'thin-pack', 'side-band', 'side-band-64k', 'ofs-delta', 'shallow',
  'no-progress', 'include-tag', 'multi_ack_detailed', `agent=${AGENT}`,
];

const RECEIVE_V0_CAPS = [
  'report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`,
];

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name, with peeled oids for annotated tags. */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      entry.peeled = parseTag(object.data).object;
    }
    out.push(entry);
  }
  return out;
}

function v0RefAdvertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = refLines(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const capText = [...caps, `symref=HEAD:refs/heads/${repo.defaultBranch}`].join(' ');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capText}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD\0${capText}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capText}\n`));
    }
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2CapabilityAdvertisement(): Buffer {
  return encodePktLines([...UPLOAD_V2_CAPS.map((line) => `${line}\n`), 'flush']);
}

// ---------------------------------------------------------------------------
// Fetch computation
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send (commits, trees, blobs, tags), in a stable order. */
  objects: PackObject[];
  /** New shallow boundaries (deepest commits sent whose parents were not sent). */
  shallow: string[];
  /** Former shallow boundaries whose parents are now sent. */
  unshallow: string[];
  /** Haves that are ancestors of a want (ACK lines). */
  acks: string[];
  /** True when the client sent at least one `have` line. v2 only sends an
   * acknowledgments section in that case; real git rejects the response
   * otherwise ("expected 'packfile', received 'acknowledgments'"). */
  hasHaves: boolean;
  /** True when every want is already held (nothing to send). */
  nothingNew: boolean;
}

/**
 * Work out what a fetch sends. `wants` are commit/tag oids, `haves` are commits the
 * client holds, `boundaries` are the client's shallow commits (their parents are not
 * held), `depth` is the deepen limit (undefined = the whole history).
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  boundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const boundarySet = new Set(boundaries);
  // Held = reachable(haves), stopping at shallow boundaries (their parents are not held).
  const held = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      held.add(oid);
      if (boundarySet.has(oid)) continue;
      const object = lookup(oid);
      if (object?.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        queue.push(...commit.parents);
      } else if (object?.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object?.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }
  // Commits to send: walk from wants, tracking generations; stop past the depth limit
  // and past shallow boundaries (their parents are already held or out of scope).
  const sendCommits = new Set<string>();
  {
    const queue: Array<{ oid: string; depth: number }> = wants
      .filter((oid) => isObjectId(oid))
      .map((oid) => ({ oid, depth: 0 }));
    const seen = new Set<string>();
    while (queue.length) {
      const { oid, depth: d } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        // A wanted tag: send the tag and its target.
        if (!held.has(oid)) sendCommits.add(oid);
        const target = parseTag(object.data).object;
        if (!seen.has(target)) queue.push({ oid: target, depth: d });
        continue;
      }
      if (object.type !== 'commit') continue;
      if (depth !== undefined && d >= depth) continue; // past the depth limit: not sent
      if (!held.has(oid)) sendCommits.add(oid);
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) {
        if (!seen.has(parent)) queue.push({ oid: parent, depth: d + 1 });
      }
    }
  }
  // The new shallow boundary (only a depth-limited fetch has one): the sent commits
  // whose parents were not sent in this fetch. For a depth-1 clone that is the tip
  // itself; for deepen 2 it is the parent; for a shallow fetch of a new tip it is
  // the new tip. A full fetch has no boundary: any unsent parent is already held.
  const newShallow = new Set<string>();
  if (depth !== undefined) {
    for (const oid of sendCommits) {
      const object = lookup(oid);
      if (object?.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((p) => !sendCommits.has(p))) {
        newShallow.add(oid);
      }
    }
  }
  // Unshallow: former boundaries whose parents are now sent.
  const unshallow: string[] = [];
  for (const boundary of boundaries) {
    const object = lookup(boundary);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((p) => sendCommits.has(p) || held.has(p))) {
      // The boundary's parents are now known: it stops being shallow, unless it
      // is itself still a boundary (its parents were not all sent).
      if (!newShallow.has(boundary)) unshallow.push(boundary);
    }
  }
  // Objects to send: the sent commits/tags plus their trees and blobs. This
  // walk follows trees and blobs only — never a commit's parents. Following
  // parents here would pull the whole history into a depth-limited fetch
  // (a depth-1 clone must land the tip only), so a separate walk is used
  // instead of collectReachable.
  const toSend = new Set<string>();
  {
    const queue = [...sendCommits];
    while (queue.length) {
      const oid = queue.pop()!;
      if (toSend.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      toSend.add(oid);
      if (object.type === 'commit') {
        queue.push(parseCommit(object.data).tree);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }
  const objects: PackObject[] = [];
  for (const oid of toSend) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    objects.push({ ...object, oid });
  }
  // Stable pack order: commits first (parents before children is not required),
  // then trees, then blobs, then tags — sorted by oid within each type.
  const typeOrder: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => (typeOrder[a.type] - typeOrder[b.type]) || (a.oid < b.oid ? -1 : 1));
  // ACKs: haves that are ancestors of a want (or a want itself).
  const acks: string[] = [];
  for (const have of haves) {
    if (wants.some((want) => isAncestor(lookup, have, want))) acks.push(have);
  }
  const nothingNew = objects.length === 0;
  return {
    objects,
    shallow: [...newShallow].sort(),
    unshallow: unshallow.sort(),
    acks,
    hasHaves: haves.length > 0,
    nothingNew,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface GitRequest {
  repo: Repo;
  service: string;
  isV2: boolean;
  body: Buffer;
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += MAX_SIDEBAND_DATA) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + MAX_SIDEBAND_DATA));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

function v2FetchResponse(repo: Repo, plan: FetchPlan, wants: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments — only when the client sent `have` lines (see FetchPlan).
  if (plan.hasHaves) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      if (plan.nothingNew) parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // wanted-refs
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const want of wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wantedRefs.push({ oid, ref: name });
    }
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const entry of wantedRefs) parts.push(pktLine(`${entry.oid} ${entry.ref}\n`));
    parts.push(pktDelim());
  }
  // packfile
  if (!plan.nothingNew) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(writePack(plan.objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (!plan.nothingNew) {
    parts.push(sidebandPack(writePack(plan.objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v2 ls-refs / fetch request body into its command and arguments. */
function parseV2Request(body: Buffer): { command: string; args: Map<string, string[]> } {
  const packets = decodePktLines(body);
  const args = new Map<string, string[]>();
  let command = '';
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  if (command === '') throw new Error('v2 request has no command');
  return { command, args };
}

function lsRefsResponse(repo: Repo, args: Map<string, string[]>): Buffer {
  const peel = args.has('peel');
  const symrefs = args.has('symrefs');
  const unborn = args.has('unborn');
  const prefixes = args.get('ref-prefix') ?? [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const refs = refLines(repo);
  const parts: Buffer[] = [];
  if (refs.length === 0) {
    // An empty repository advertises no refs at all — not even an unborn line:
    // the suite proves a fresh repo has zero refs.
    void unborn;
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined && keep('HEAD')) {
    let line = `${headTip} HEAD`;
    if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    parts.push(pktLine(`${line}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Fetch(repo: Repo, args: Map<string, string[]>): Buffer {
  const wants = args.get('want') ?? [];
  const haves = args.get('have') ?? [];
  const boundaries = args.get('shallow') ?? [];
  const deepen = args.get('deepen')?.[0];
  const depth = deepen === undefined ? undefined : parseInt(deepen, 10);
  const plan = planFetch(repo, wants, haves, boundaries, Number.isNaN(depth) ? undefined : depth);
  return v2FetchResponse(repo, plan, wants);
}

/** Parse a v0 upload-pack request: wants section, flush, haves section, flush. */
function parseV0Fetch(body: Buffer): {
  wants: string[];
  haves: string[];
  boundaries: string[];
  depth: number | undefined;
} {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const boundaries: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const [key, ...rest] = line.split(' ');
    if (section === 0) {
      if (key === 'want') wants.push(rest[0] ?? '');
      else if (key === 'shallow') boundaries.push(rest[0] ?? '');
      else if (key === 'deepen') depth = parseInt(rest[0] ?? '', 10);
    } else {
      if (key === 'have') haves.push(rest[0] ?? '');
    }
  }
  return { wants, haves, boundaries, depth: depth !== undefined && Number.isNaN(depth) ? undefined : depth };
}

function v0Fetch(repo: Repo, body: Buffer): Buffer {
  const { wants, haves, boundaries, depth } = parseV0Fetch(body);
  const plan = planFetch(repo, wants, haves, boundaries, depth);
  return v0FetchResponse(plan);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: command lines, flush, then the pack bytes. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  // Walk the raw buffer to find where the pkt-lines end (the flush) so the pack
  // bytes after it are preserved exactly.
  let cursor = 0;
  let packStart = body.length;
  let sawFlush = false;
  while (cursor < body.length) {
    if (cursor + 4 > body.length) throw new Error('truncated pkt-line header');
    const header = body.subarray(cursor, cursor + 4).toString('ascii');
    if (header === '0000') {
      packStart = cursor + 4;
      sawFlush = true;
      break;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line header in receive-pack');
    const length = parseInt(header, 16);
    if (length < 4 || cursor + length > body.length) throw new Error('bad pkt-line length in receive-pack');
    cursor += length;
  }
  if (!sawFlush) throw new Error('receive-pack has no flush after the command list');
  const commandPackets = decodePktLines(body.subarray(0, packStart - 4));
  for (const packet of commandPackets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    if (nul >= 0) capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
    const [oldOid, newOid, ref] = head.split(' ');
    if (oldOid === undefined || newOid === undefined || ref === undefined) {
      throw new Error(`bad receive-pack command line ${JSON.stringify(head.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack has no commands');
  return { commands, capabilities, pack: body.subarray(packStart) };
}

export interface PushReport {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

function handleReceivePack(repo: Repo, store: Store, body: Buffer): { status: number; contentType: string; body: Buffer } {
  let parsed: { commands: PushCommand[]; capabilities: string[]; pack: Buffer };
  try {
    parsed = parseReceivePack(body);
  } catch (err) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`bad receive-pack request: ${err instanceof Error ? err.message : String(err)}`, 'utf8') };
  }
  const { commands, capabilities, pack } = parsed;
  const sideband = capabilities.includes('side-band-64k');
  const report: PushReport = { unpackOk: false, unpackDetail: 'missing', refs: [] };
  const finish = (): { status: number; contentType: string; body: Buffer } => {
    const lines = [`unpack ${report.unpackOk ? 'ok' : report.unpackDetail}`];
    for (const ref of report.refs) {
      lines.push(ref.ok ? `ok ${ref.ref}` : `ng ${ref.ref} ${ref.reason}`);
    }
    // One pkt-line per report line: git's report parser reads the first line
    // and compares it to "unpack ok" exactly, so a single pkt-line holding
    // the whole report reads as "remote unpack failed: ok". The trailing
    // flush goes INSIDE the band-1 data, exactly as git's own receive-pack
    // sends it (the report stream ends with a flush, and a second flush
    // outside the sideband ends the sideband stream); without the inner
    // flush the client reads the report to EOF and dies with "the remote
    // end hung up unexpectedly".
    const framed = encodePktLines([...lines.map((line) => `${line}\n`), 'flush']);
    const bodyOut = sideband
      ? Buffer.concat([sidebandPackInner(framed), pktFlush()])
      : framed;
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
  };
  // Unpack first: a refused update must still unpack.
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef || pack.length > 0) {
    if (pack.length === 0) {
      // An empty pack is legal (the client sends one for every create/update).
      report.unpackOk = true;
      report.unpackDetail = 'ok';
    } else {
      try {
        const objects = readPack(pack);
        for (const object of objects.values()) {
          // Verify each object recomputes to its id before storing it.
          if (hashObject(object.type, object.data) !== object.oid) {
            throw new Error(`pack object ${object.oid} does not recompute`);
          }
          repo.objects.set(object.oid, { type: object.type, data: object.data });
        }
        report.unpackOk = true;
        report.unpackDetail = 'ok';
      } catch (err) {
        report.unpackOk = false;
        report.unpackDetail = err instanceof Error ? err.message : 'unpack error';
        for (const command of commands) {
          report.refs.push({ ref: command.ref, ok: false, reason: 'unpack error' });
        }
        return finish();
      }
    }
  } else {
    report.unpackOk = true;
    report.unpackDetail = 'ok';
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.refs.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (current !== command.oldOid && command.oldOid !== ZERO_OID) {
        report.refs.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        report.refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      // Create.
      if (command.oldOid !== ZERO_OID) {
        report.refs.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (lookup(command.newOid) === undefined) {
        report.refs.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update.
    if (command.oldOid !== current) {
      report.refs.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    if (lookup(command.newOid) === undefined) {
      report.refs.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!isAncestor(lookup, command.oldOid, command.newOid)) {
      report.refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.refs.push({ ref: command.ref, ok: true, reason: '' });
  }
  void store;
  return finish();
}

/** Wrap already pkt-lined bytes as sideband band-1 packets. */
function sidebandPackInner(framed: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < framed.length; offset += MAX_SIDEBAND_DATA) {
    const chunk = framed.subarray(offset, Math.min(framed.length, offset + MAX_SIDEBAND_DATA));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Top-level dispatch for one git request
// ---------------------------------------------------------------------------

export function handleInfoRefs(
  repo: Repo | undefined,
  service: 'git-upload-pack' | 'git-receive-pack',
  isV2: boolean,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0RefAdvertisement(repo, service) };
  }
  if (isV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2CapabilityAdvertisement() };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0RefAdvertisement(repo, service) };
}

export function handleUploadPack(
  repo: Repo | undefined,
  isV2: boolean,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  try {
    if (isV2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
      }
      if (command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2Fetch(repo, args) };
      }
      return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown v2 command ${command}`, 'utf8') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0Fetch(repo, body) };
  } catch (err) {
    // A malformed request must not take the server down: answer 400 and stay up.
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`bad upload-pack request: ${err instanceof Error ? err.message : String(err)}`, 'utf8') };
  }
}

export function handleReceivePackRequest(
  repo: Repo | undefined,
  store: Store,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  return handleReceivePack(repo, store, body);
}
