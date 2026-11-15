// ghforge: a GitHub-compatible forge in one process. This file is the lifecycle: listen on an ephemeral
// port with a raw node:net server, register the port with the env, poll /done gently, exit 0 when done.

import { createServer } from 'node:net';
import { Agent, request } from 'node:http';
import { activity, serve } from './src/http.ts';
import { route } from './src/router.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}
const env = new URL(ENV_URL);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

/** One small request to the env; resolves with the status and body text, or rejects. */
function call(method: string, path: string, body: string | null): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: env.hostname,
        port: env.port === '' ? 80 : Number(env.port),
        path,
        method,
        agent,
        timeout: 30_000,
        headers: body === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await call('POST', '/register', JSON.stringify({ port }));
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${res.text}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered')) throw err;
    }
    await sleep(Math.min(2000, 100 * 2 ** Math.min(attempt, 5)));
  }
}

/**
 * Poll /done every 2 s, skipping a poll while the forge served a request in the last interval: the
 * suite shares the env's event loop with /done, so a quiet poll costs the timed workloads nothing.
 */
async function waitForDone(): Promise<void> {
  let seen = -1;
  for (;;) {
    await sleep(1000);
    if (activity.served !== seen) {
      seen = activity.served;
      continue;
    }
    try {
      const res = await call('GET', '/done', null);
      if (res.status === 200 && (JSON.parse(res.text) as { done?: unknown }).done === true) return;
    } catch {
      // not answering yet: poll again
    }
    await sleep(1000);
  }
}

const server = createServer({ noDelay: true }, (sock) => serve(sock, route));
server.on('error', (err) => {
  process.stderr.write(`[forge] server error: ${err.message}\n`);
});
server.listen(0, () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    process.stderr.write('[forge] no TCP address\n');
    process.exit(1);
  }
  process.stdout.write(`[forge] listening on ${address.port}\n`);
  register(address.port)
    .then(() => {
      process.stdout.write('[forge] registered\n');
      return waitForDone();
    })
    .then(() => {
      process.stdout.write('[forge] done\n');
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
});
