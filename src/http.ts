// HTTP/1.1 over raw node:net sockets: a small request parser (keep-alive, pipelining, chunked bodies)
// and response writers that put the status line, headers and body on the wire in one write.

import type { Socket } from 'node:net';

export interface Req {
  method: string;
  path: string;
  /** The raw query string without '?', '' when absent. */
  query: string;
  auth: string;
  gitProtocol: string;
  host: string;
  body: Buffer;
  sock: Socket;
  close: boolean;
}

export type Handler = (req: Req) => void;

const EMPTY = Buffer.alloc(0);
const MAX_HEAD = 64 * 1024;

/** A fixed request id: the contract asks for a non-empty one, and a constant lets whole responses be cached. */
export const REQUEST_ID = '0F0F:1E1E:2D2D3C:4B4B5A:6969';

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 411: 'Length Required',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 500: 'Internal Server Error',
};

/** Requests served so far; the done poll reads it to stay quiet while the suite is busy. */
export const activity = { served: 0 };

/** Serve one connection: parse every request in the buffer and hand each to `handler` in order. */
export function serve(sock: Socket, handler: Handler): void {
  sock.setNoDelay(true);
  let buf: Buffer | null = null;
  let pending: Req | null = null;
  let bodyStart = 0;
  let need = -1; // content length of the pending request, -2 for chunked
  sock.on('error', ignore);
  sock.on('data', (chunk: Buffer) => {
    buf = buf === null ? chunk : Buffer.concat([buf, chunk]);
    let off = 0;
    for (;;) {
      const b: Buffer = buf;
      if (pending === null) {
        const end = b.indexOf('\r\n\r\n', off, 'latin1');
        if (end < 0) {
          if (b.length - off > MAX_HEAD) {
            sock.destroy();
            buf = null;
            return;
          }
          break;
        }
        const req = parseHead(b, off, end, sock);
        if (req === null) {
          sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          buf = null;
          return;
        }
        pending = req;
        bodyStart = end + 4;
        need = headLength;
        off = bodyStart;
      }
      const req: Req = pending;
      if (need >= 0) {
        if (b.length - bodyStart < need) break;
        req.body = need === 0 ? EMPTY : b.subarray(bodyStart, bodyStart + need);
        off = bodyStart + need;
      } else {
        const done = dechunk(b, bodyStart);
        if (done === null) break;
        req.body = done.body;
        off = done.end;
      }
      pending = null;
      activity.served += 1;
      try {
        handler(req);
      } catch (err) {
        process.stderr.write(`[forge] handler failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        sendJson(req, 500, '{"message":"Internal Server Error"}');
      }
      if (req.close) {
        sock.end();
        buf = null;
        return;
      }
      if (off >= b.length) break;
    }
    if (buf !== null) buf = off >= buf.length ? null : buf.subarray(off);
    if (pending !== null && buf !== null && off > 0) bodyStart -= off;
    if (pending !== null && buf === null) bodyStart = 0;
  });
}

function ignore(): void {
  // a peer that went away needs no answer
}

/** Set by parseHead: the body length of the request it parsed (-2 chunked). */
let headLength = 0;

function parseHead(b: Buffer, start: number, end: number, sock: Socket): Req | null {
  const head = b.latin1Slice(start, end);
  let lineEnd = head.indexOf('\r\n');
  if (lineEnd < 0) lineEnd = head.length;
  const sp1 = head.indexOf(' ');
  const sp2 = head.indexOf(' ', sp1 + 1);
  if (sp1 <= 0 || sp2 < 0 || sp2 > lineEnd) return null;
  const method = head.slice(0, sp1);
  const target = head.slice(sp1 + 1, sp2);
  const q = target.indexOf('?');
  const req: Req = {
    method,
    path: q < 0 ? target : target.slice(0, q),
    query: q < 0 ? '' : target.slice(q + 1),
    auth: '',
    gitProtocol: '',
    host: '',
    body: EMPTY,
    sock,
    close: false,
  };
  let length = 0;
  let pos = lineEnd + 2;
  while (pos < head.length) {
    let next = head.indexOf('\r\n', pos);
    if (next < 0) next = head.length;
    const colon = head.indexOf(':', pos);
    if (colon > pos && colon < next) {
      const nameLen = colon - pos;
      // Only the headers the forge reads are looked at; the first character narrows the match cheaply.
      const c = head.charCodeAt(pos) | 0x20;
      if (c === 0x63 /* c */ && nameLen === 14 && head.slice(pos, colon).toLowerCase() === 'content-length') {
        length = Number(head.slice(colon + 1, next).trim());
        if (!Number.isFinite(length) || length < 0) return null;
      } else if (c === 0x61 /* a */ && nameLen === 13 && head.slice(pos, colon).toLowerCase() === 'authorization') {
        req.auth = head.slice(colon + 1, next).trim();
      } else if (c === 0x68 /* h */ && nameLen === 4 && head.slice(pos, colon).toLowerCase() === 'host') {
        req.host = head.slice(colon + 1, next).trim();
      } else if (c === 0x67 /* g */ && nameLen === 12 && head.slice(pos, colon).toLowerCase() === 'git-protocol') {
        req.gitProtocol = head.slice(colon + 1, next).trim();
      } else if (c === 0x74 /* t */ && nameLen === 17 && head.slice(pos, colon).toLowerCase() === 'transfer-encoding') {
        if (head.slice(colon + 1, next).toLowerCase().includes('chunked')) length = -2;
      } else if (c === 0x63 && nameLen === 10 && head.slice(pos, colon).toLowerCase() === 'connection') {
        if (head.slice(colon + 1, next).trim().toLowerCase() === 'close') req.close = true;
      }
    }
    pos = next + 2;
  }
  headLength = length;
  return req;
}

/** Decode a chunked body starting at `start`; null while it is incomplete. */
function dechunk(b: Buffer, start: number): { body: Buffer; end: number } | null {
  const parts: Buffer[] = [];
  let pos = start;
  for (;;) {
    const lineEnd = b.indexOf('\r\n', pos, 'latin1');
    if (lineEnd < 0) return null;
    const size = parseInt(b.latin1Slice(pos, lineEnd), 16);
    if (!Number.isFinite(size)) return { body: EMPTY, end: b.length };
    pos = lineEnd + 2;
    if (size === 0) {
      // optional trailers, then the empty line
      for (;;) {
        const e = b.indexOf('\r\n', pos, 'latin1');
        if (e < 0) return null;
        if (e === pos) return { body: parts.length === 1 ? parts[0] : Buffer.concat(parts), end: e + 2 };
        pos = e + 2;
      }
    }
    if (b.length < pos + size + 2) return null;
    parts.push(b.subarray(pos, pos + size));
    pos += size + 2;
  }
}

/** One JSON reply: status line, the JSON headers, `extra` header lines and the body, in one write. */
export function sendJson(req: Req, status: number, json: string, extra = ''): void {
  req.sock.write(
    `HTTP/1.1 ${status} ${REASONS[status] ?? 'OK'}\r\nContent-Type: application/json; charset=utf-8\r\nX-GitHub-Request-Id: ${REQUEST_ID}\r\n${extra}Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
  );
}

/** A whole JSON response as one Buffer, for replies served many times unchanged. */
export function jsonResponse(status: number, json: string, extra = ''): Buffer {
  return Buffer.from(
    `HTTP/1.1 ${status} ${REASONS[status] ?? 'OK'}\r\nContent-Type: application/json; charset=utf-8\r\nX-GitHub-Request-Id: ${REQUEST_ID}\r\n${extra}Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
  );
}

/** A 204 with no body (no Content-Length, as the status forbids one). */
export function sendNoContent(req: Req): void {
  req.sock.write(`HTTP/1.1 204 No Content\r\nX-GitHub-Request-Id: ${REQUEST_ID}\r\n\r\n`);
}

/** A whole binary response as one Buffer. */
export function binaryResponse(status: number, type: string, body: Buffer): Buffer {
  const head = `HTTP/1.1 ${status} ${REASONS[status] ?? 'OK'}\r\nContent-Type: ${type}\r\nCache-Control: no-cache\r\nContent-Length: ${body.length}\r\n\r\n`;
  const out = Buffer.allocUnsafe(head.length + body.length);
  out.latin1Write(head, 0);
  body.copy(out, head.length);
  return out;
}

/** A binary reply in one write. */
export function sendBinary(req: Req, status: number, type: string, body: Buffer): void {
  req.sock.write(binaryResponse(status, type, body));
}

/** The query string's parameters (only list routes read them, so a plain split is enough). */
export function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  if (query === '') return out;
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? '' : part.slice(eq + 1);
    try {
      out.set(decodeURIComponent(key.replace(/\+/g, ' ')), decodeURIComponent(value.replace(/\+/g, ' ')));
    } catch {
      out.set(key, value);
    }
  }
  return out;
}
