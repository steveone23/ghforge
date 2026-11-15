// The one dispatch point: every request goes to exactly one surface by its path.

import { sendJson, type Req } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './smart.ts';

const HEALTHZ = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}');

export function route(req: Req): void {
  const p = req.path;
  if (p.startsWith('/api/v3')) {
    if (p.length === 7 || p.charCodeAt(7) === 47) {
      handleRest(req);
      return;
    }
  } else if (p === '/api/graphql') {
    handleGraphql(req);
    return;
  } else if (p === '/mcp') {
    handleMcp(req);
    return;
  } else if (p === '/healthz') {
    req.sock.write(HEALTHZ);
    return;
  } else if (p.endsWith('/info/refs') || p.endsWith('/git-upload-pack') || p.endsWith('/git-receive-pack')) {
    handleGit(req);
    return;
  }
  sendJson(req, 404, '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}');
}
