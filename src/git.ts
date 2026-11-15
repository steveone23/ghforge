// Git objects: the content-addressed store, SHA-1 ids, pack reading (with OFS/REF deltas) and writing,
// and the tree and commit helpers the REST surface uses to make commits of its own.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const T_COMMIT = 1;
export const T_TREE = 2;
export const T_BLOB = 3;
export const T_TAG = 4;
export const ZERO = '0000000000000000000000000000000000000000';
const TYPE_NAMES = ['', 'commit', 'tree', 'blob', 'tag'];

export interface GitObj {
  type: number;
  data: Buffer;
  /** The zlib stream for a pack entry: kept from the received pack, or made once on first send. */
  z: Buffer | null;
  /** Parsed lazily for commits (and the target for tags). */
  tree?: string;
  parents?: string[];
  target?: string;
  targetType?: number;
}

/** Every object the forge holds. Objects are immutable, so one store serves every repository. */
export const store = new Map<string, GitObj>();

export function hashOf(type: number, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${TYPE_NAMES[type]} ${data.length}\0`, 'latin1');
  h.update(data);
  return h.digest('hex');
}

export function put(type: number, data: Buffer, z: Buffer | null = null): string {
  const oid = hashOf(type, data);
  const existing = store.get(oid);
  if (existing === undefined) store.set(oid, { type, data, z });
  else if (existing.z === null && z !== null) existing.z = z;
  return oid;
}

export function typeName(type: number): string {
  return TYPE_NAMES[type] ?? 'blob';
}

// ---------------------------------------------------------------- parsing

/** A commit's tree and parents, parsed once and kept on the object. */
export function commitOf(oid: string): GitObj | null {
  const o = store.get(oid);
  if (o === undefined || o.type !== T_COMMIT) return null;
  if (o.parents === undefined) {
    const d = o.data;
    const parents: string[] = [];
    let tree = '';
    let p = 0;
    while (p < d.length) {
      const nl = d.indexOf(10, p);
      if (nl < 0 || nl === p) break;
      if (d[p] === 0x74 && d.latin1Slice(p, p + 5) === 'tree ') tree = d.latin1Slice(p + 5, nl);
      else if (d[p] === 0x70 && d.latin1Slice(p, p + 7) === 'parent ') parents.push(d.latin1Slice(p + 7, nl));
      else if (tree !== '' && d[p] !== 0x70) break;
      p = nl + 1;
    }
    o.tree = tree;
    o.parents = parents;
  }
  return o;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** The whole header set and message of a commit (REST views). */
export function readCommit(oid: string): CommitView | null {
  const o = store.get(oid);
  if (o === undefined || o.type !== T_COMMIT) return null;
  const text = o.data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

/** An annotated tag's target (peeled one level). */
export function tagTarget(o: GitObj): string {
  if (o.target === undefined) {
    const d = o.data;
    o.target = d.latin1Slice(7, 47);
    const nl = d.indexOf(10, 48);
    const t = d.latin1Slice(53, nl < 0 ? d.length : nl);
    o.targetType = TYPE_NAMES.indexOf(t);
  }
  return o.target;
}

/** Follow tags down to a non-tag object id. */
export function peel(oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const o = store.get(cur);
    if (o === undefined || o.type !== T_TAG) return cur;
    cur = tagTarget(o);
  }
  return cur;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    out.push({ mode: data.latin1Slice(p, sp), name: data.toString('utf8', sp + 1, nul), oid: data.hexSlice(nul + 1, nul + 21) });
    p = nul + 21;
  }
  return out;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): string {
  const sorted = entries.slice().sort((a, b) => {
    const x = Buffer.from(treeSortKey(a));
    const y = Buffer.from(treeSortKey(b));
    return Buffer.compare(x, y);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return put(T_TREE, Buffer.concat(parts));
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every file under a tree, by its full path. */
export function flatten(treeOid: string, prefix = '', out: Map<string, FlatEntry> = new Map()): Map<string, FlatEntry> {
  const o = store.get(treeOid);
  if (o === undefined || o.type !== T_TREE) return out;
  for (const e of parseTree(o.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flatten(e.oid, path, out);
    else out.set(path, { mode: e.mode, oid: e.oid });
  }
  return out;
}

/** Build the nested trees for a flat path map and answer the root tree id. */
export function unflatten(files: Map<string, FlatEntry>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of files) {
    const segs = path.split('/');
    let dir = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      let next = dir.dirs.get(segs[i]);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(segs[i], next);
      }
      dir = next;
    }
    dir.files.push({ mode: entry.mode, name: segs[segs.length - 1], oid: entry.oid });
  }
  const build = (dir: Dir): string => {
    const entries = dir.files.slice();
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return buildTree(entries);
  };
  return build(root);
}

/** The entries of the tree at `path` under a root tree, or null when it is not a directory. */
export function treeAt(rootTree: string, path: string): { oid: string; entries: TreeEntry[] } | null {
  let oid = rootTree;
  if (path !== '') {
    for (const seg of path.split('/')) {
      const o = store.get(oid);
      if (o === undefined || o.type !== T_TREE) return null;
      const e = parseTree(o.data).find((entry) => entry.name === seg);
      if (e === undefined || e.mode !== '40000') return null;
      oid = e.oid;
    }
  }
  const o = store.get(oid);
  if (o === undefined || o.type !== T_TREE) return null;
  return { oid, entries: parseTree(o.data) };
}

export function buildCommit(tree: string, parents: string[], message: string, ident: string): string {
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return put(T_COMMIT, Buffer.from(text, 'utf8'));
}

/** Whether `ancestor` is reachable from `tip` through parents. */
export function isAncestor(ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const c = stack.pop() as string;
    if (seen.has(c)) continue;
    seen.add(c);
    const o = commitOf(c);
    if (o === null) continue;
    for (const p of o.parents as string[]) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits (breadth first from `b`), or null. */
export function mergeBase(a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const c = stack.pop() as string;
    if (ancestors.has(c)) continue;
    ancestors.add(c);
    const o = commitOf(c);
    if (o !== null) for (const p of o.parents as string[]) stack.push(p);
  }
  const queue = [b];
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i += 1) {
    const c = queue[i];
    if (ancestors.has(c)) return c;
    if (seen.has(c)) continue;
    seen.add(c);
    const o = commitOf(c);
    if (o !== null) for (const p of o.parents as string[]) queue.push(p);
  }
  return null;
}

// ---------------------------------------------------------------- packs

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const c = delta[p++];
      v += (c & 0x7f) * 2 ** shift;
      shift += 7;
      if ((c & 0x80) === 0) return v;
    }
  };
  const srcSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const size = readSize();
  const out = Buffer.allocUnsafe(size);
  let w = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 1) off = delta[p++];
      if (op & 2) off |= delta[p++] << 8;
      if (op & 4) off |= delta[p++] << 16;
      if (op & 8) off += delta[p++] * 0x1000000;
      if (op & 16) len = delta[p++];
      if (op & 32) len |= delta[p++] << 8;
      if (op & 64) len |= delta[p++] << 16;
      if (len === 0) len = 0x10000;
      base.copy(out, w, off, off + len);
      w += len;
    } else if (op !== 0) {
      delta.copy(out, w, p, p + op);
      p += op;
      w += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (w !== size) throw new Error('delta size mismatch');
  return out;
}

interface Entry {
  off: number;
  type: number;
  data: Buffer;
  baseOff: number;
  baseOid: string;
  oid: string;
}

/**
 * Read a pack at `start` into the store: every object's header, its zlib stream (inflateSync with
 * info reports the compressed length consumed), deltas resolved, ids hashed. Answers the ids it stored,
 * or throws on a malformed pack.
 */
export function unpack(buf: Buffer, start: number): string[] {
  if (buf.length - start < 12 || buf.latin1Slice(start, start + 4) !== 'PACK') throw new Error('not a pack');
  const count = buf.readUInt32BE(start + 8);
  let off = start + 12;
  const entries: Entry[] = [];
  const byOff = new Map<number, Entry>();
  for (let i = 0; i < count; i += 1) {
    const at = off;
    let c = buf[off++];
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = buf[off++];
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOff = -1;
    let baseOid = '';
    if (type === 6) {
      c = buf[off++];
      let v = c & 0x7f;
      while (c & 0x80) {
        c = buf[off++];
        v = (v + 1) * 128 + (c & 0x7f);
      }
      baseOff = at - v;
    } else if (type === 7) {
      baseOid = buf.hexSlice(off, off + 20);
      off += 20;
    }
    const r = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const used = r.engine.bytesWritten;
    const data = r.buffer;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    const e: Entry = { off: at, type, data, baseOff, baseOid, oid: '' };
    if (type >= 1 && type <= 4) e.oid = put(type, data, Buffer.from(buf.subarray(off, off + used)));
    off += used;
    entries.push(e);
    byOff.set(at, e);
  }
  // Resolve deltas: an OFS base always sits earlier; a REF base may sit anywhere, so loop until done.
  const local = new Map<string, Entry>();
  for (const e of entries) if (e.oid !== '') local.set(e.oid, e);
  let left = entries.filter((e) => e.oid === '');
  while (left.length > 0) {
    const still: Entry[] = [];
    for (const e of left) {
      let baseType = 0;
      let baseData: Buffer | null = null;
      if (e.type === 6) {
        const b = byOff.get(e.baseOff);
        if (b !== undefined && b.oid !== '') {
          baseType = b.type;
          baseData = b.data;
        }
      } else if (e.type === 7) {
        const b = local.get(e.baseOid);
        if (b !== undefined) {
          baseType = b.type;
          baseData = b.data;
        } else {
          const s = store.get(e.baseOid);
          if (s !== undefined) {
            baseType = s.type;
            baseData = s.data;
          }
        }
      } else {
        throw new Error(`unknown pack entry type ${e.type}`);
      }
      if (baseData === null) {
        still.push(e);
        continue;
      }
      e.data = applyDelta(baseData, e.data);
      e.type = baseType;
      e.oid = put(baseType, e.data);
      local.set(e.oid, e);
    }
    if (still.length === left.length) throw new Error('unresolved delta base');
    left = still;
  }
  return entries.map((e) => e.oid);
}

function entryHeader(type: number, size: number): number[] {
  const bytes: number[] = [];
  let c = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(c | 0x80);
    c = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(c);
  return bytes;
}

/** A pack of whole objects (no deltas), each from its kept zlib stream. */
export function writePack(oids: readonly string[]): Buffer {
  let total = 12 + 20;
  const objs: GitObj[] = [];
  for (const oid of oids) {
    const o = store.get(oid) as GitObj;
    if (o.z === null) o.z = deflateSync(o.data, { level: 1 });
    objs.push(o);
    total += 10 + o.z.length;
  }
  const out = Buffer.allocUnsafe(total);
  out.latin1Write('PACK', 0);
  out.writeUInt32BE(2, 4);
  out.writeUInt32BE(objs.length, 8);
  let p = 12;
  for (const o of objs) {
    for (const byte of entryHeader(o.type, o.data.length)) out[p++] = byte;
    o.z!.copy(out, p);
    p += o.z!.length;
  }
  createHash('sha1').update(out.subarray(0, p)).digest().copy(out, p);
  return out.subarray(0, p + 20);
}
