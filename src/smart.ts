// Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack (protocol v2: ls-refs and fetch with
// shallow/deepen; v0 kept for old clients) and git-receive-pack (v0 with report-status, side-band-64k
// and delete-refs). Advertisements are cached per repository until a ref moves; a fetch answer depends
// only on immutable objects and the request body, so whole fetch responses are cached by body.

import { binaryResponse, sendBinary, sendJson, type Req } from './http.ts';
import { T_COMMIT, T_TAG, T_TREE, ZERO, commitOf, isAncestor, parseTree, peel, store, tagTarget, unpack, writePack } from './git.ts';
import { findRepo, setRef, type Repo } from './store.ts';

const AGENT = 'agent=ghforge/1.0';
const ADV_UPLOAD = 'application/x-git-upload-pack-advertisement';
const ADV_RECEIVE = 'application/x-git-receive-pack-advertisement';
const RES_UPLOAD = 'application/x-git-upload-pack-result';
const RES_RECEIVE = 'application/x-git-receive-pack-result';
const CAPS_UPLOAD_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:refs/heads/main ${AGENT} object-format=sha1`;
const CAPS_RECEIVE = `report-status delete-refs side-band-64k quiet ofs-delta ${AGENT} object-format=sha1`;

function pkt(line: string): string {
  const n = Buffer.byteLength(line) + 4;
  return (n < 16 ? '000' : n < 256 ? '00' : n < 4096 ? '0' : '') + n.toString(16) + line;
}

/** The v2 capability advertisement: the same bytes for every repository. */
const V2_ADVERTISEMENT = binaryResponse(
  200,
  ADV_UPLOAD,
  Buffer.from(`${pkt('version 2\n')}${pkt(`${AGENT}\n`)}${pkt('ls-refs=unborn\n')}${pkt('fetch=shallow\n')}${pkt('server-option\n')}${pkt('object-format=sha1\n')}0000`),
);

const NOT_FOUND = Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 10\r\n\r\nnot found\n');

function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function advertiseV0(repo: Repo, receive: boolean): Buffer {
  let body = receive ? `${pkt('# service=git-receive-pack\n')}0000` : `${pkt('# service=git-upload-pack\n')}0000`;
  const caps = receive ? CAPS_RECEIVE : CAPS_UPLOAD_V0.replace('symref=HEAD:refs/heads/main', `symref=HEAD:${headTarget(repo)}`);
  const lines: string[] = [];
  const head = repo.refs.get(headTarget(repo));
  if (!receive && head !== undefined) lines.push(`${head} HEAD`);
  for (const name of sortedRefs(repo)) {
    const oid = repo.refs.get(name) as string;
    lines.push(`${oid} ${name}`);
    if (!receive && name.startsWith('refs/tags/')) {
      const peeled = peel(oid);
      if (peeled !== oid) lines.push(`${peeled} ${name}^{}`);
    }
  }
  if (lines.length === 0) lines.push(`${ZERO} capabilities^{}`);
  for (let i = 0; i < lines.length; i += 1) body += pkt(i === 0 ? `${lines[i]}\0${caps}\n` : `${lines[i]}\n`);
  body += '0000';
  return binaryResponse(200, receive ? ADV_RECEIVE : ADV_UPLOAD, Buffer.from(body));
}

/** Route one smart-HTTP request; `path` is /{owner}/{repo}.git/<service path>. */
export function handleGit(req: Req): void {
  const p = req.path;
  const s1 = p.indexOf('/', 1);
  const s2 = s1 < 0 ? -1 : p.indexOf('/', s1 + 1);
  if (s1 < 0 || s2 < 0) {
    req.sock.write(NOT_FOUND);
    return;
  }
  const owner = decode(p.slice(1, s1));
  let name = decode(p.slice(s1 + 1, s2));
  if (name.endsWith('.git')) name = name.slice(0, -4);
  const rest = p.slice(s2);
  const repo = findRepo(owner, name);
  if (repo === undefined) {
    req.sock.write(NOT_FOUND);
    return;
  }
  if (rest === '/info/refs' && req.method === 'GET') {
    if (req.query.includes('git-receive-pack')) {
      if (repo.advReceive === null) repo.advReceive = advertiseV0(repo, true);
      req.sock.write(repo.advReceive);
    } else if (req.query.includes('git-upload-pack')) {
      if (req.gitProtocol.includes('version=2')) req.sock.write(V2_ADVERTISEMENT);
      else {
        if (repo.advUpload0 === null) repo.advUpload0 = advertiseV0(repo, false);
        req.sock.write(repo.advUpload0);
      }
    } else {
      sendJson(req, 403, '{"message":"dumb HTTP is not served"}');
    }
    return;
  }
  if (rest === '/git-upload-pack' && req.method === 'POST') {
    uploadPack(req, repo);
    return;
  }
  if (rest === '/git-receive-pack' && req.method === 'POST') {
    receivePack(req, repo);
    return;
  }
  req.sock.write(NOT_FOUND);
}

function decode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function badRequest(req: Req, why: string): void {
  sendBinary(req, 400, 'text/plain; charset=utf-8', Buffer.from(`${why}\n`));
}

interface Packets {
  lines: (string | null)[]; // null marks a delim (0001); a flush ends the list unless `all`
  end: number;
}

/** Read pkt-lines from `body` until a flush; null entries are delims. Throws on a malformed frame. */
function readPkts(body: Buffer, start: number): Packets {
  const lines: (string | null)[] = [];
  let p = start;
  for (;;) {
    if (p + 4 > body.length) throw new Error('truncated pkt-line');
    const len = parseInt(body.latin1Slice(p, p + 4), 16);
    if (!Number.isInteger(len) || !/^[0-9a-fA-F]{4}$/.test(body.latin1Slice(p, p + 4))) throw new Error('malformed pkt-line');
    if (len === 0) return { lines, end: p + 4 };
    if (len === 1) {
      lines.push(null);
      p += 4;
      continue;
    }
    if (len < 4 || p + len > body.length) throw new Error('malformed pkt-line');
    let line = body.toString('utf8', p + 4, p + len);
    if (line.endsWith('\n')) line = line.slice(0, -1);
    lines.push(line);
    p += len;
  }
}

// ---------------------------------------------------------------- upload-pack

const fetchCache = new Map<string, Buffer>();

function uploadPack(req: Req, repo: Repo): void {
  const body = req.body;
  let pk: Packets;
  try {
    pk = readPkts(body, 0);
  } catch {
    badRequest(req, 'malformed pkt-line request');
    return;
  }
  const first = pk.lines[0] ?? '';
  if (first === 'command=ls-refs') {
    const key = body.latin1Slice(0, body.length);
    let cached = repo.lsRefs.get(key);
    if (cached === undefined) {
      cached = binaryResponse(200, RES_UPLOAD, lsRefs(repo, pk.lines));
      repo.lsRefs.set(key, cached);
    }
    req.sock.write(cached);
    return;
  }
  if (first === 'command=fetch') {
    const key = body.latin1Slice(0, body.length);
    const cached = fetchCache.get(key);
    if (cached !== undefined) {
      req.sock.write(cached);
      return;
    }
    const out = fetchV2(pk.lines);
    if (typeof out === 'string') {
      sendBinary(req, 200, RES_UPLOAD, Buffer.from(`${pkt(`ERR ${out}\n`)}0000`));
      return;
    }
    const resp = binaryResponse(200, RES_UPLOAD, out);
    if (fetchCache.size > 512) fetchCache.clear();
    fetchCache.set(key, resp);
    req.sock.write(resp);
    return;
  }
  if (first.startsWith('want ')) {
    fetchV0(req, body, pk);
    return;
  }
  badRequest(req, 'unknown upload-pack command');
}

function lsRefs(repo: Repo, lines: (string | null)[]): Buffer {
  let peelOpt = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let args = false;
  for (const line of lines) {
    if (line === null) {
      args = true;
      continue;
    }
    if (!args) continue;
    if (line === 'peel') peelOpt = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  let out = '';
  if (keep('HEAD')) {
    const target = headTarget(repo);
    const head = repo.refs.get(target);
    if (head !== undefined) out += pkt(`${head} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
    else if (unborn) out += pkt(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
  }
  for (const name of sortedRefs(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peelOpt && name.startsWith('refs/tags/')) {
      const peeled = peel(oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    out += pkt(`${line}\n`);
  }
  return Buffer.from(`${out}0000`);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number;
  done: boolean;
}

function fetchArgs(lines: (string | null)[], v2: boolean): FetchArgs {
  const a: FetchArgs = { wants: [], haves: [], shallow: [], depth: 0, done: false };
  let args = !v2;
  for (const line of lines) {
    if (line === null) {
      args = true;
      continue;
    }
    if (!args) continue;
    if (line.startsWith('want ')) a.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) a.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) a.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) a.depth = Math.max(0, Number(line.slice(7)) | 0);
    else if (line === 'done') a.done = true;
  }
  return a;
}

interface FetchPlan {
  oids: string[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/** The objects a fetch must send, and the shallow boundary it moves. A string is an error. */
function planFetch(a: FetchArgs): FetchPlan | string {
  const clientShallow = new Set(a.shallow);
  // What the client holds: every commit reachable from its haves, cut at its shallow boundary.
  const held = new Set<string>();
  const common: string[] = [];
  const stack: string[] = [];
  for (const h of a.haves) {
    const o = store.get(h);
    if (o === undefined) continue;
    common.push(h);
    stack.push(o.type === T_TAG ? peel(h) : h);
  }
  while (stack.length > 0) {
    const c = stack.pop() as string;
    if (held.has(c)) continue;
    const o = commitOf(c);
    if (o === null) continue;
    held.add(c);
    if (clientShallow.has(c)) continue;
    for (const p of o.parents as string[]) stack.push(p);
  }
  const heldObjects = new Set<string>();
  for (const c of held) markTree((commitOf(c) as { tree: string }).tree, heldObjects);

  const send: string[] = [];
  const sent = new Set<string>();
  const add = (oid: string): void => {
    if (!sent.has(oid)) {
      sent.add(oid);
      send.push(oid);
    }
  };
  const roots: string[] = [];
  for (const w of a.wants) {
    let cur = w;
    for (let i = 0; i < 16; i += 1) {
      const o = store.get(cur);
      if (o === undefined) return `upload-pack: not our ref ${cur}`;
      if (o.type !== T_TAG) break;
      if (!heldObjects.has(cur)) add(cur);
      cur = tagTarget(o);
    }
    const o = store.get(cur) as { type: number };
    if (o.type === T_COMMIT) roots.push(cur);
    else if (o.type === T_TREE) walkTree(cur, heldObjects, sent, send);
    else if (!heldObjects.has(cur)) add(cur);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!depthOf.has(r)) {
      depthOf.set(r, 1);
      queue.push(r);
    }
  }
  const commits: string[] = [];
  for (let i = 0; i < queue.length; i += 1) {
    const c = queue[i];
    const d = depthOf.get(c) as number;
    if (a.depth === 0 && held.has(c)) continue;
    const o = commitOf(c);
    if (o === null) return `upload-pack: missing commit ${c}`;
    if (!held.has(c)) commits.push(c);
    const parents = o.parents as string[];
    if (a.depth > 0 && d >= a.depth) {
      if (parents.length > 0 && !clientShallow.has(c)) shallow.push(c);
      continue;
    }
    if (a.depth > 0 && clientShallow.has(c) && parents.length > 0) unshallow.push(c);
    for (const p of parents) {
      if (!depthOf.has(p)) {
        depthOf.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  for (const c of commits) add(c);
  for (const c of commits) walkTree((commitOf(c) as { tree: string }).tree, heldObjects, sent, send);
  return { oids: send, shallow, unshallow, common };
}

function markTree(tree: string, seen: Set<string>): void {
  if (seen.has(tree)) return;
  seen.add(tree);
  const o = store.get(tree);
  if (o === undefined || o.type !== T_TREE) return;
  for (const e of parseTree(o.data)) {
    if (e.mode === '160000') continue;
    if (e.mode === '40000') markTree(e.oid, seen);
    else seen.add(e.oid);
  }
}

function walkTree(tree: string, held: Set<string>, sent: Set<string>, send: string[]): void {
  if (held.has(tree) || sent.has(tree)) return;
  const o = store.get(tree);
  if (o === undefined) return;
  sent.add(tree);
  send.push(tree);
  for (const e of parseTree(o.data)) {
    if (e.mode === '160000') continue;
    if (e.mode === '40000') walkTree(e.oid, held, sent, send);
    else if (!held.has(e.oid) && !sent.has(e.oid) && store.has(e.oid)) {
      sent.add(e.oid);
      send.push(e.oid);
    }
  }
}

/** The pack in side-band-64k frames on band 1. */
function sideband(pack: Buffer, prefix: Buffer, suffix: string): Buffer {
  const MAX = 65515;
  const frames = Math.ceil(pack.length / MAX);
  const out = Buffer.allocUnsafe(prefix.length + pack.length + frames * 5 + suffix.length);
  prefix.copy(out, 0);
  let w = prefix.length;
  for (let p = 0; p < pack.length; p += MAX) {
    const n = Math.min(MAX, pack.length - p);
    out.latin1Write((n + 5).toString(16).padStart(4, '0'), w);
    out[w + 4] = 1;
    pack.copy(out, w + 5, p, p + n);
    w += n + 5;
  }
  out.latin1Write(suffix, w);
  return out;
}

function fetchV2(lines: (string | null)[]): Buffer | string {
  const a = fetchArgs(lines, true);
  const plan = planFetch(a);
  if (typeof plan === 'string') return plan;
  let head = '';
  if (!a.done && a.haves.length > 0) {
    head += pkt('acknowledgments\n');
    for (const c of plan.common) head += pkt(`ACK ${c}\n`);
    if (plan.common.length === 0) head += pkt('NAK\n');
    head += `${pkt('ready\n')}0001`;
  }
  if (a.depth > 0) {
    head += pkt('shallow-info\n');
    for (const c of plan.shallow) head += pkt(`shallow ${c}\n`);
    for (const c of plan.unshallow) head += pkt(`unshallow ${c}\n`);
    head += '0001';
  }
  head += pkt('packfile\n');
  return sideband(writePack(plan.oids), Buffer.from(head), '0000');
}

function fetchV0(req: Req, body: Buffer, first: Packets): void {
  const lines: (string | null)[] = first.lines.slice();
  try {
    if (first.end < body.length) {
      const second = readPkts(body, first.end);
      for (const l of second.lines) lines.push(l);
    }
  } catch {
    // a body cut after the wants still has a fetch to answer
  }
  const a = fetchArgs(lines, false);
  const plan = planFetch(a);
  if (typeof plan === 'string') {
    sendBinary(req, 200, RES_UPLOAD, Buffer.from(`${pkt(`ERR ${plan}\n`)}0000`));
    return;
  }
  let head = '';
  if (a.depth > 0) {
    for (const c of plan.shallow) head += pkt(`shallow ${c}\n`);
    for (const c of plan.unshallow) head += pkt(`unshallow ${c}\n`);
    head += '0000';
  }
  head += pkt('NAK\n');
  sendBinary(req, 200, RES_UPLOAD, sideband(writePack(plan.oids), Buffer.from(head), '0000'));
}

// ---------------------------------------------------------------- receive-pack

function receivePack(req: Req, repo: Repo): void {
  const body = req.body;
  let pk: Packets;
  try {
    pk = readPkts(body, 0);
  } catch {
    badRequest(req, 'malformed pkt-line request');
    return;
  }
  const commands: { old: string; neu: string; ref: string }[] = [];
  let caps = '';
  for (const line of pk.lines) {
    if (line === null) continue;
    let text = line;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    commands.push({ old: text.slice(0, 40), neu: text.slice(41, 81), ref: text.slice(82) });
  }
  let unpackError = '';
  if (pk.end < body.length) {
    try {
      unpack(body, pk.end);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  let report = pkt(unpackError === '' ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const cmd of commands) report += pkt(`${unpackError === '' ? applyCommand(repo, cmd) : `ng ${cmd.ref} unpacker error`}\n`);
  report += '0000';
  const wantsReport = caps.includes('report-status');
  let out = '';
  if (wantsReport) out = caps.includes('side-band-64k') ? `${pkt(`\x01${report}`)}0000` : report;
  sendBinary(req, 200, RES_RECEIVE, Buffer.from(out));
}

function applyCommand(repo: Repo, cmd: { old: string; neu: string; ref: string }): string {
  const { neu, ref } = cmd;
  if (!ref.startsWith('refs/') || neu.length !== 40) return `ng ${ref} funny refname`;
  const cur = repo.refs.get(ref);
  if (neu === ZERO) {
    if (cur !== undefined) setRef(repo, ref, null);
    return `ok ${ref}`;
  }
  const obj = store.get(neu);
  if (obj === undefined) return `ng ${ref} missing necessary objects`;
  if (cur !== undefined && cur !== neu) {
    const curObj = store.get(cur);
    const ff = curObj !== undefined && curObj.type === T_COMMIT && obj.type === T_COMMIT && isAncestor(cur, neu);
    if (!ff) return `ng ${ref} non-fast-forward`;
  }
  if (cur !== neu) setRef(repo, ref, neu);
  return `ok ${ref}`;
}
